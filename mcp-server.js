#!/usr/bin/env node
/* =========================================================================
 * 独立 MCP 服务器（stdio 传输，零依赖，由外部 AI 客户端以 node 启动）
 *
 * 接入方式见 docs/MCP接入指南.md。配置示例（Claude Desktop / Cursor）：
 *   { "mcpServers": { "serial-protocol-manager": {
 *       "command": "node",
 *       "args": ["<本文件绝对路径>"] } } }
 *
 * 运行模式（自动选择）：
 *   在线：桌面应用运行中 → 读取 <数据目录>/mcp-bridge.json，工具调用经
 *         回环 HTTP 转发给应用执行（能枚举串口、读最新数据）
 *   离线：应用未运行 → node:sqlite 只读直读 <数据目录>/serial_protocol.db，
 *         数据库类工具照常可用（list_serial_ports 会明确报错）
 *
 * 数据目录发现顺序：
 *   1. --data-dir=<绝对路径> 或环境变量 SERIAL_PM_DATA_DIR
 *   2. --instance=<名称> → <候选目录>/instances/<名称>
 *   3. 候选目录：脚本同目录 data/（开发态）、%APPDATA%/Serial Protocol Manager/data、
 *      %APPDATA%/serial-protocol-manager/data；多实例时取 mcp-bridge.json 最新者
 *
 * 注意：stdout 是 MCP 协议通道，一切日志只写 stderr。
 * ========================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const { executeTool } = require('./ai-tools');
const { REQUEST_TIMEOUT_MS } = require('./mcp-bridge');

const SERVER_NAME = 'serial-protocol-manager';
const SUPPORTED_PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18'];
const FALLBACK_PROTOCOL_VERSION = '2025-06-18';
const OFFLINE_RETRY_MS = 3000; /* 在线探测失败后的冷却期，避免每次工具调用都连一次 */

function serverVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || '0.0.0'; }
  catch { return '0.0.0'; }
}

/* ---------------- 数据目录与桥接信息发现 ---------------- */

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([a-z-]+)(?:=(.*))?$/i);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

function candidateDataDirs(args) {
  const list = [];
  const push = (p) => { if (p && !list.includes(p)) list.push(p); };

  /* 显式指定 --data-dir / SERIAL_PM_DATA_DIR 时锁定目录：
   * 不再扫描其他候选，避免同机其他实例的桥/库被误选（测试隔离也依赖这一点） */
  const explicit = args['data-dir'] || process.env.SERIAL_PM_DATA_DIR;
  if (explicit) {
    push(explicit);
    const instance = args['instance'] || process.env.SERIAL_PM_INSTANCE;
    if (instance) push(path.join(explicit, 'instances', instance));
    return list.filter((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
  }

  const bases = [];
  /* 开发态：脚本在项目根 → <root>/data；打包态：脚本在 resources/mcp → 安装目录无 data，靠下面 APPDATA 候选 */
  bases.push(path.join(__dirname, 'data'));
  bases.push(path.join(__dirname, '..', '..', 'data'));
  bases.push(path.join(os.homedir(), 'AppData', 'Roaming', 'Serial Protocol Manager', 'data'));
  bases.push(path.join(os.homedir(), 'AppData', 'Roaming', 'serial-protocol-manager', 'data'));

  const instance = args['instance'] || process.env.SERIAL_PM_INSTANCE;
  for (const b of bases) {
    if (instance) push(path.join(b, 'instances', instance));
    else push(b);
  }
  return list.filter((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
}

/* 桥文件里的 pid 是否还活着（应用异常退出会留下陈旧文件，直接按无桥处理） */
function bridgePidAlive(bridge) {
  if (!bridge || !Number.isInteger(bridge.pid)) return false;
  try { process.kill(bridge.pid, 0); return true; } catch { return false; }
}

/* 在候选目录里找最新的 mcp-bridge.json；无桥时找最新的 serial_protocol.db */
function discoverDataDir(args, log) {
  const dirs = candidateDataDirs(args);
  if (!dirs.length) return { dataDir: null, bridge: null, dbPath: null };

  let best = { mtime: -1, dir: null, bridge: null };
  for (const dir of dirs) {
    const candidates = [path.join(dir, 'mcp-bridge.json')];
    try {
      for (const name of fs.readdirSync(path.join(dir, 'instances'))) {
        candidates.push(path.join(dir, 'instances', name, 'mcp-bridge.json'));
      }
    } catch { /* 无多实例目录 */ }
    for (const file of candidates) {
      try {
        const st = fs.statSync(file);
        if (st.mtimeMs > best.mtime) {
          best = { mtime: st.mtimeMs, dir: path.dirname(file), bridge: JSON.parse(fs.readFileSync(file, 'utf8')) };
        }
      } catch { /* 跳过坏文件 */ }
    }
  }

  if (best.dir) {
    const bridge = bridgePidAlive(best.bridge) ? best.bridge : null;
    if (best.bridge && !bridge) log(`忽略陈旧的桥文件（进程 ${best.bridge.pid} 已退出）`);
    return { dataDir: best.dir, bridge, dbPath: path.join(best.dir, 'serial_protocol.db') };
  }

  /* 无桥文件：取存在数据库的最新候选目录（离线模式） */
  let dbBest = { mtime: -1, dir: null };
  for (const dir of dirs) {
    for (const db of [path.join(dir, 'serial_protocol.db'), path.join(dir, 'instances')]) {
      try {
        if (db.endsWith('.db')) {
          const st = fs.statSync(db);
          if (st.mtimeMs > dbBest.mtime) dbBest = { mtime: st.mtimeMs, dir };
        } else {
          for (const name of fs.readdirSync(db)) {
            const f = path.join(db, name, 'serial_protocol.db');
            const st = fs.statSync(f);
            if (st.mtimeMs > dbBest.mtime) dbBest = { mtime: st.mtimeMs, dir: path.dirname(f) };
          }
        }
      } catch { /* 跳过 */ }
    }
  }
  if (dbBest.dir) log(`未发现运行中的应用，离线模式使用数据库: ${dbBest.dir}`);
  return { dataDir: dbBest.dir, bridge: null, dbPath: dbBest.dir ? path.join(dbBest.dir, 'serial_protocol.db') : null };
}

/* ---------------- 在线桥 / 离线 SQLite 两条执行通路 ---------------- */

function createAppClient(initialBridge, dataDir, log) {
  let bridge = initialBridge || null;
  let offlineUntil = 0;

  const post = (target, body) => new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port: target.port,
      path: '/mcp/tool',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Authorization: `Bearer ${target.token}`,
      },
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error(`桥响应解析失败: ${e.message}`)); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('桥请求超时')); });
    req.on('error', reject);
    req.end(payload);
  });

  /* 重读 mcp-bridge.json：应用每次启动都会换新令牌/端口，
   * 这是"应用重启后所有调用返回 undefined"的自愈来源 */
  function reloadBridge() {
    if (!dataDir) return false;
    try {
      const info = JSON.parse(fs.readFileSync(path.join(dataDir, 'mcp-bridge.json'), 'utf8'));
      if (!bridgePidAlive(info)) return false;
      if (!bridge || info.port !== bridge.port || info.token !== bridge.token) {
        log(`检测到应用（重新）启动，更新桥连接 → 127.0.0.1:${info.port}`);
        offlineUntil = 0; /* 新桥已就位，立即恢复在线尝试 */
      }
      bridge = info;
      return true;
    } catch { return false; }
  }

  return {
    hasBridge() { return !!bridge; },
    reloadBridge,
    available() { return !!bridge && Date.now() >= offlineUntil; },
    markOffline(reason) {
      offlineUntil = Date.now() + OFFLINE_RETRY_MS;
      log(`在线桥不可用（${reason}），暂时走离线模式`);
    },
    async call(name, args) {
      let out;
      try {
        out = await post(bridge, { name, args });
      } catch (e) {
        /* 连接失败：应用可能重启换了端口，重读桥文件后重试一次 */
        if (reloadBridge()) out = await post(bridge, { name, args });
        else throw e;
      }
      /* 桥拒绝类响应（401 令牌过期 / 404 / 400）形如 {ok:false, error}，
       * 没有 result 字段——重读桥文件换新令牌重试一次 */
      if (!out || typeof out.ok !== 'boolean' || (out.ok === false && out.result === undefined)) {
        if (reloadBridge()) out = await post(bridge, { name, args });
      }
      if (!out || typeof out.ok !== 'boolean') throw new Error('桥响应格式异常');
      if (out.ok === false && out.result === undefined) {
        throw new Error(`桥拒绝请求（${out.error || '未知原因'}），已尝试刷新连接`);
      }
      return out;
    },
  };
}

function createOfflineQuery(dbPath, log) {
  let db = null;
  let openFailed = false;
  return async function query(sql, params = []) {
    if (!db) {
      if (openFailed) throw new Error('离线数据库不可用（此前打开失败）');
      try {
        const { DatabaseSync } = require('node:sqlite');
        db = new DatabaseSync(dbPath, { readOnly: true });
        log(`离线模式：已只读打开 ${dbPath}`);
      } catch (e) {
        openFailed = true;
        throw new Error(`离线打开数据库失败（需要 Node.js ≥ 22.13 且数据库存在）: ${e.message}`);
      }
    }
    try {
      return { success: true, rows: db.prepare(sql).all(...(params || [])) };
    } catch (e) {
      return { success: false, error: e.message };
    }
  };
}

/* ---------------- 工具调用：在线优先，失败自动落离线 ---------------- */

function createToolRunner(bridge, dataDir, dbPath, log) {
  const app = createAppClient(bridge, dataDir, log);
  const offlineQuery = createOfflineQuery(dbPath, log); /* 惰性连接：首次真正用到才打开 */
  const noData = !bridge && !dbPath;

  return async function runTool(name, args) {
    /* 每次调用前轻量重读桥文件：应用重启/新实例后自动恢复在线（文件读取开销可忽略） */
    app.reloadBridge();
    if (app.available()) {
      try {
        return await app.call(name, args);
      } catch (e) {
        app.markOffline(e.message);
      }
    }
    if (noData) {
      return { ok: false, result: '未找到应用数据目录，也无法连接运行中的应用。可在启动本服务时用 --data-dir 指定数据目录，或先打开桌面应用。' };
    }
    /* 在线桥失效时自动落为离线直读数据库（list_serial_ports 会明确报错） */
    return executeTool(name, args, { query: offlineQuery });
  };
}

/* ---------------- MCP 协议（JSON-RPC 2.0 over stdio，按行分帧） ---------------- */

/* ---------------- MCP 资源（resources/*）与提示模板（prompts/*） ---------------- */

/* 静态资源 + 协议模板资源；读取统一复用工具层（在线桥 / 离线库自动适配） */
const MCP_RESOURCES = [
  { uri: 'protocol://list', name: '协议库清单', description: '全部协议的名称、版本、帧模式与校验方式', mimeType: 'application/json' },
  { uri: 'serial://logs/recent', name: '最近串口日志', description: '最近 30 条串口收发记录（hex/方向/时间）', mimeType: 'application/json' },
  { uri: 'serial://ports', name: '本机串口列表', description: '当前可用的串口（需应用运行）', mimeType: 'application/json' },
];
const MCP_RESOURCE_TEMPLATES = [
  {
    uriTemplate: 'protocol://{name}',
    name: '协议定义',
    description: '按名称读取单个协议的完整定义（帧参数、模块地址表、指令表与字段）',
    mimeType: 'application/json',
  },
];

const MCP_PROMPTS = {
  'debug-command-no-response': {
    description: '排查"指令发下去设备无响应"：构帧核对 → 查日志 → 解析回复 → 给出原因清单',
    arguments: [
      { name: 'protocol_name', description: '协议名称', required: true },
      { name: 'command', description: '命令码或命令名称', required: true },
    ],
    render: (a) => `我在调试串口协议「${a.protocol_name}」，发送命令「${a.command}」后设备没有响应。请按以下步骤协助排查：
1. 用 build_frame 生成该命令的正确帧 HEX，并逐段核对帧结构（帧头/地址/CMD/长度/校验）。
2. 用 get_recent_serial_data 查看最近收发记录，确认帧是否真的发出、设备是否有任何回复。
3. 若有回复数据，用 parse_frame 解析并解读设备返回（含错误码含义）。
4. 综合以上信息，给出可能原因清单（接线/波特率/地址不匹配/校验方式/固件状态）与下一步动作。`,
  },
  'parse-hex-frame': {
    description: '解析一帧 HEX 数据：自动识别协议 → 逐字段解释 → 校验结论',
    arguments: [
      { name: 'hex', description: '完整帧 HEX 数据', required: true },
      { name: 'protocol_name', description: '协议名称（可选，省略则自动识别）', required: false },
    ],
    render: (a) => `请解析这帧串口数据：${a.hex}${a.protocol_name ? `（协议：${a.protocol_name}）` : ''}
1. 用 parse_frame 解析（${a.protocol_name ? '指定协议' : '先自动识别协议；识别失败时用 query_protocols 列出协议库让我选择'}）。
2. 用通俗语言解释每个字段的含义（含枚举值、位域、物理值换算）。
3. 明确给出校验（CRC/累加和）是否通过的结论。`,
  },
  'protocol-library-overview': {
    description: '协议库概况：逐协议介绍帧模式、校验方式与主要指令用途，汇总成表',
    arguments: [],
    render: () => `请用 query_protocols 获取协议库清单，然后：
1. 对每个协议给出一段简明介绍（帧模式、字节序、校验方式、指令数量）。
2. 抽取每个协议有代表性的 3-5 条指令，说明其用途（可按需用 get_protocol_detail 查看详情）。
3. 最后汇总成一张 Markdown 表格。`,
  },
};

function main() {
  const log = (msg) => process.stderr.write(`[mcp-server] ${msg}\n`);
  const args = parseArgs(process.argv.slice(2));
  const { dataDir, bridge: foundBridge, dbPath } = discoverDataDir(args, log);
  /* --offline：强制离线只读（不连接应用桥），适合涉密环境 */
  const bridge = args.offline ? null : foundBridge;
  const runTool = createToolRunner(bridge, dataDir, dbPath, log);

  if (args.offline) log('已指定 --offline：固定离线只读模式（不连接应用桥）');
  else if (bridge) log(`在线模式：应用桥 127.0.0.1:${bridge.port}（数据目录 ${path.dirname(dbPath || '') || '?'}）`);
  else if (!dbPath) log('未找到数据目录与运行中的应用：数据库类工具将返回错误，可通过 --data-dir=<路径> 指定');
  else log('离线模式：未连接运行中的应用，直读数据库');

  const write = (obj) => {
    try { process.stdout.write(JSON.stringify(obj) + '\n'); } catch { process.exit(0); }
  };

  /* resources/read 按 URI 分发到对应工具（在线桥 / 离线库通用） */
  const readResource = async (uri) => {
    if (uri === 'protocol://list') return runTool('query_protocols', {});
    if (uri === 'serial://logs/recent') return runTool('get_recent_serial_data', { count: 30 });
    if (uri === 'serial://ports') return runTool('list_serial_ports', {});
    const m = String(uri).match(/^protocol:\/\/(.+)$/);
    if (m) return runTool('get_protocol_detail', { protocol_name: decodeURIComponent(m[1]) });
    return { ok: false, result: `未知资源 URI: ${uri}` };
  };

  const handleRequest = async (msg) => {
    const { id, method, params } = msg;
    switch (method) {
      case 'initialize':
        write({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(params && params.protocolVersion)
              ? params.protocolVersion
              : FALLBACK_PROTOCOL_VERSION,
            capabilities: { tools: {}, resources: {}, prompts: {} },
            serverInfo: { name: SERVER_NAME, version: serverVersion() },
          },
        });
        return;
      case 'ping':
        write({ jsonrpc: '2.0', id, result: {} });
        return;
      case 'tools/list': {
        const { toSchemaList } = require('./ai-tools');
        write({
          jsonrpc: '2.0',
          id,
          result: {
            tools: toSchemaList().map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })),
          },
        });
        return;
      }
      case 'tools/call': {
        const name = String((params && params.name) || '');
        const toolArgs = (params && params.arguments && typeof params.arguments === 'object') ? params.arguments : {};
        const out = await runTool(name, toolArgs);
        write({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: String(out.result ?? '') }],
            isError: !out.ok,
          },
        });
        return;
      }
      case 'resources/list':
        write({ jsonrpc: '2.0', id, result: { resources: MCP_RESOURCES } });
        return;
      case 'resources/templates/list':
        write({ jsonrpc: '2.0', id, result: { resourceTemplates: MCP_RESOURCE_TEMPLATES } });
        return;
      case 'resources/read': {
        const uri = String((params && params.uri) || '');
        const out = await readResource(uri);
        write({
          jsonrpc: '2.0',
          id,
          result: { contents: [{ uri, mimeType: 'application/json', text: String(out.result ?? '') }] },
          ...(out.ok ? {} : { isError: true }),
        });
        return;
      }
      case 'prompts/list':
        write({
          jsonrpc: '2.0',
          id,
          result: {
            prompts: Object.entries(MCP_PROMPTS).map(([name, p]) => ({
              name, description: p.description, arguments: p.arguments,
            })),
          },
        });
        return;
      case 'prompts/get': {
        const name = String((params && params.name) || '');
        const p = MCP_PROMPTS[name];
        if (!p) {
          write({ jsonrpc: '2.0', id, error: { code: -32602, message: `提示模板不存在: ${name}` } });
          return;
        }
        const promptArgs = (params && params.arguments) || {};
        const missing = p.arguments.filter((a) => a.required && !promptArgs[a.name]).map((a) => a.name);
        if (missing.length) {
          write({ jsonrpc: '2.0', id, error: { code: -32602, message: `缺少参数: ${missing.join('、')}` } });
          return;
        }
        write({
          jsonrpc: '2.0',
          id,
          result: {
            description: p.description,
            messages: [{ role: 'user', content: { type: 'text', text: p.render(promptArgs) } }],
          },
        });
        return;
      }
      default:
        if (id !== undefined && id !== null) {
          write({ jsonrpc: '2.0', id, error: { code: -32601, message: `方法不存在: ${method}` } });
        }
    }
  };

  let buf = '';
  const feed = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try { msg = JSON.parse(trimmed); } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析失败' } });
      return;
    }
    /* 通知（无 id）不回包；请求串行执行，保证输出顺序与到达顺序一致 */
    Promise.resolve()
      .then(() => handleRequest(msg))
      .catch((e) => {
        log(`处理 ${msg.method || '?'} 出错: ${e.message}`);
        if (msg.id !== undefined && msg.id !== null) {
          write({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: `内部错误: ${e.message}` } });
        }
      });
  };

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      feed(buf.slice(0, idx));
      buf = buf.slice(idx + 1);
    }
  });
  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('close', () => process.exit(0));
  process.stdin.resume();

  const bye = () => process.exit(0);
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
  process.on('uncaughtException', (e) => { log(`未捕获异常: ${e.message}`); });
  process.stdout.on('error', bye);
}

main();
