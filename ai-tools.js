/* =========================================================================
 * AI 只读工具集（Tool Call）
 * 模型可主动调用来读取工具内数据：协议库 / 最近串口数据 / 系统日志。
 * 只读、无副作用；execute 的异常会被主进程捕获并作为工具错误回传给模型。
 *
 * 同一份 TOOLS 同时供三个入口使用：
 *   1. 应用内 AI 助手（ai-assistant.js）
 *   2. 应用内 MCP 桥（mcp-bridge.js，供外部 AI 客户端在线调用）
 *   3. 独立 MCP 服务器（mcp-server.js，应用未运行时离线直读数据库）
 * ========================================================================= */
const codec = require('./frame-codec');

/* 单条工具结果上限（字符），防止撑爆后续请求。
 * 非字符串（对象/数组）先 JSON 序列化——直接 String() 会得到
 * "[object Object]"，模型什么都读不到。 */
const MAX_RESULT_CHARS = 6000;

async function runQuery(query, sql, params = []) {
  if (typeof query !== 'function') throw new Error('数据通道未就绪');
  const r = await query(sql, params);
  if (!r || !r.success) throw new Error((r && r.error) || '数据库查询失败');
  return r.rows || [];
}

function clip(s, n = MAX_RESULT_CHARS) {
  const text = typeof s === 'string' ? s : JSON.stringify(s, null, 1);
  return text.length > n ? text.slice(0, n) + '…(已截断)' : text;
}

function num(v, dft, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dft;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function pick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return '';
}

/* config_json 里的字段定义（各版本结构有差异，防御式取名） */
function parseFields(configJson) {
  try {
    const cfg = JSON.parse(configJson || '{}');
    const fields = Array.isArray(cfg.fields) ? cfg.fields : [];
    return fields.map((f) => ({
      name: String(pick(f, ['name', 'label', 'title']) || '?'),
      type: String(pick(f, ['type', 'dataType']) || ''),
      length: pick(f, ['length', 'len', 'dataLen']) || undefined,
      offset: pick(f, ['offset', 'start']) || undefined,
    }));
  } catch {
    return [];
  }
}

/* 加载协议完整定义（协议行 + config_json + 命令行 + 模块表 → frame-codec 结构） */
async function loadProtocolDef(query, name) {
  const protos = await runQuery(query, 'SELECT * FROM protocols WHERE name = ? COLLATE NOCASE', [name]);
  if (!protos.length) {
    const all = await runQuery(query, 'SELECT name FROM protocols ORDER BY name COLLATE NOCASE');
    const err = new Error(`协议库中不存在名为「${name}」的协议`);
    err.available = all.map((r) => r.name).slice(0, 30);
    throw err;
  }
  const p = protos[0];
  let protoConfig = {};
  try { protoConfig = JSON.parse(p.config_json || '{}'); } catch { /* 旧数据无 config */ }
  const cmds = await runQuery(query, 'SELECT code, name, config_json FROM commands WHERE protocol_id = ? ORDER BY id', [p.id]).catch(() => []);
  const def = codec.buildProtoDef(p, protoConfig, cmds);
  const mods = await runQuery(query, 'SELECT name, address FROM modules WHERE protocol_id = ? ORDER BY id', [p.id]).catch(() => []);
  def.modules = mods.map((m) => ({ name: m.name, address: m.address }));
  return def;
}

/* 异常消息附带可用协议列表（build_frame / parse_frame 用） */
function withAvailable(e) {
  if (e && Array.isArray(e.available)) {
    return new Error(`${e.message}。可用协议: ${e.available.join('，')}`);
  }
  return e;
}

/* =========================================================================
 * AFT-1 文件传输帧识别（供 file_transfer_status 扫描串口日志）
 * 帧格式（小端）：A5 5A | TYPE 1 | SEQ 1 | LEN 2 | PAYLOAD | CRC16-CCITT-FALSE 2
 * CRC 范围: TYPE 起至 payload 末尾
 * ========================================================================= */
const AFT1_FINAL_STATUS = ['文件完整且校验通过', '收齐但整包 CRC32 不符', '协议版本不支持', '无进行中的会话'];

function crc16CcittFalse(bytes) {
  let crc = 0xFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] << 8;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
  }
  return crc;
}

/* 一行日志 HEX 里可能有多帧也可能截断，容错扫描并解出 FILE_BEGIN 元信息 */
function parseAft1Hex(hexStr) {
  const bytes = codec.hexToBytes(hexStr);
  const out = [];
  for (let i = 0; i + 8 <= bytes.length; i++) {
    if (bytes[i] !== 0xA5 || bytes[i + 1] !== 0x5A) continue;
    const len = bytes[i + 4] | (bytes[i + 5] << 8);
    const total = 6 + len + 2;
    if (i + total > bytes.length) break;
    const type = bytes[i + 2];
    const seq = bytes[i + 3];
    const payload = bytes.slice(i + 6, i + 6 + len);
    const expect = crc16CcittFalse(bytes.slice(i + 2, i + 6 + len));
    const stored = bytes[i + 6 + len] | (bytes[i + 7 + len] << 8);
    const frame = {
      type,
      typeName: AFT1_TYPE_NAMES[type] || `0x${type.toString(16).toUpperCase()}`,
      seq, len, crc_ok: stored === expect,
      payload,
    };
    if (type === 0x01 && len >= 17) {
      const nameLen = payload[15];
      frame.meta = {
        chunkSize: payload[1] | (payload[2] << 8),
        fileSize: (payload[3] | (payload[4] << 8) | (payload[5] << 16) | (payload[6] << 24)) >>> 0,
        totalBlocks: (payload[7] | (payload[8] << 8) | (payload[9] << 16) | (payload[10] << 24)) >>> 0,
        name: Buffer.from(payload.slice(16, Math.min(16 + nameLen, payload.length))).toString('utf8'),
      };
    }
    out.push(frame);
    i += total - 1;
  }
  return out;
}

const AFT1_TYPE_NAMES = {
  0x01: 'FILE_BEGIN', 0x02: 'DATA', 0x03: 'FILE_END', 0x04: 'CANCEL',
  0x10: 'READY', 0x11: 'ACK', 0x12: 'RESEND', 0x13: 'FINAL', 0x14: 'CANCEL_ACK',
};

const TOOLS = {
  query_protocols: {
    description: '获取串口协议管理工具协议库中的全部协议清单（名称、版本、帧模式、字节序、校验方式）。当用户询问"有哪些协议/协议库概况"，或需要先了解协议库名称列表时调用。',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async (_args, { query }) => {
      const rows = await runQuery(query, 'SELECT id, name, version, frame_mode, frame_length, byte_order, check_method FROM protocols ORDER BY name COLLATE NOCASE');
      return rows.map((r) => ({
        name: r.name,
        version: r.version || '',
        frame: r.frame_mode === 'fixed' ? `定长${r.frame_length || '?'}字节` : (r.frame_mode || ''),
        byte_order: r.byte_order || '',
        check: r.check_method || '',
      }));
    },
  },

  get_protocol_detail: {
    description: '按名称查询单个协议的完整定义：基础帧参数、模块地址表、指令表（含每条指令的字段）。当用户询问某个具体协议的指令、字段、帧结构时调用；协议名可先用 query_protocols 查询。',
    parameters: {
      type: 'object',
      properties: {
        protocol_name: { type: 'string', description: '协议名称，需与协议库中的名称完全一致' },
      },
      required: ['protocol_name'],
    },
    execute: async (args, { query }) => {
      const name = String(args.protocol_name || '').trim();
      if (!name) throw new Error('protocol_name 不能为空');
      const protos = await runQuery(query, 'SELECT * FROM protocols WHERE name = ? COLLATE NOCASE', [name]);
      if (!protos.length) {
        const all = await runQuery(query, 'SELECT name FROM protocols ORDER BY name COLLATE NOCASE');
        return { error: `协议库中不存在名为「${name}」的协议`, available: all.map((r) => r.name).slice(0, 30) };
      }
      const p = protos[0];
      const modules = await runQuery(query, 'SELECT name, address FROM modules WHERE protocol_id = ? ORDER BY id', [p.id]).catch(() => []);
      const cmds = await runQuery(query, 'SELECT code, name, sender, receiver, direction, period_ms, config_json FROM commands WHERE protocol_id = ? ORDER BY id', [p.id]).catch(() => []);
      return clip({
        name: p.name,
        version: p.version,
        frame_mode: p.frame_mode,
        frame_length: p.frame_length,
        byte_order: p.byte_order,
        check_method: p.check_method,
        check_range: `${p.check_start || ''} → ${p.check_end || ''}`,
        modules,
        commands: cmds.map((c) => ({
          code: c.code,
          name: c.name,
          sender: c.sender || '',
          receiver: c.receiver || '',
          direction: c.direction || '',
          period_ms: c.period_ms,
          fields: parseFields(c.config_json),
        })),
      });
    },
  },

  get_recent_serial_data: {
    description: '读取最近串口收发日志（hex 与文本、方向、时间）。当用户提到"最近收到的数据""刚发的帧""调试记录"等时调用。',
    parameters: {
      type: 'object',
      properties: {
        count: { type: 'number', description: '条数，默认 20，最大 100' },
      },
      required: [],
    },
    execute: async (args, { query }) => {
      const n = num(args.count, 20, 1, 100);
      const rows = await runQuery(query, `SELECT direction, data_hex, data_text, timestamp FROM serial_logs ORDER BY id DESC LIMIT ${n}`);
      return clip(rows.map((r) => ({
        dir: (r.direction || '?').toUpperCase(),
        time: r.timestamp || '',
        hex: String(r.data_hex || '').slice(0, 240),
        text: r.data_text ? String(r.data_text).slice(0, 80) : undefined,
      })));
    },
  },

  get_system_logs: {
    description: '读取应用系统日志（级别、来源、消息、时间）。当用户需要排查问题（如发送失败、连接异常、更新问题）时调用。',
    parameters: {
      type: 'object',
      properties: {
        count: { type: 'number', description: '条数，默认 30，最大 100' },
        level: { type: 'string', enum: ['info', 'warn', 'error'], description: '可选，按级别过滤' },
      },
      required: [],
    },
    execute: async (args, { query }) => {
      const n = num(args.count, 30, 1, 100);
      const level = String(args.level || '').trim().toLowerCase();
      const rows = ['info', 'warn', 'error'].includes(level)
        ? await runQuery(query, `SELECT level, category, source, message, created_at FROM app_logs WHERE level = '${level}' ORDER BY id DESC LIMIT ${n}`)
        : await runQuery(query, `SELECT level, category, source, message, created_at FROM app_logs ORDER BY id DESC LIMIT ${n}`);
      return clip(rows.map((r) => `[${r.level}] ${r.created_at} ${r.category || ''}${r.source ? '/' + r.source : ''} ${r.message}`));
    },
  },

  search_protocols: {
    description: '按关键字检索协议库：匹配协议名称、指令码、指令名称。当用户记不清协议全名，或想找"含某功能的指令"时调用；找到后可用 get_protocol_detail 看完整定义。',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '关键字，如协议名片段、指令码（"0200"）、指令名（"泵料"）' },
      },
      required: ['keyword'],
    },
    execute: async (args, { query }) => {
      const kw = String(args.keyword || '').trim();
      if (!kw) throw new Error('keyword 不能为空');
      const like = `%${kw}%`;
      const protos = await runQuery(query, 'SELECT name, version, frame_mode, check_method FROM protocols WHERE name LIKE ? ORDER BY name COLLATE NOCASE LIMIT 20', [like]);
      const cmds = await runQuery(
        query,
        `SELECT p.name AS protocol_name, c.code, c.name AS command_name, c.sender, c.receiver
         FROM commands c JOIN protocols p ON p.id = c.protocol_id
         WHERE c.code LIKE ? OR c.name LIKE ?
         ORDER BY p.name COLLATE NOCASE, c.id LIMIT 30`,
        [like, like],
      );
      return clip({
        protocols: protos,
        commands: cmds,
        hint: '协议详情用 get_protocol_detail，构帧用 build_frame',
      });
    },
  },

  build_frame: {
    description: '按协议生成完整指令帧 HEX：给定协议名、命令（码或名称）与各字段值，自动计算长度与校验（CRC16-MODBUS 或累加和）。生成的是帧数据本身，不会发送到串口。字段值可用数值、0x 十六进制串或枚举含义文本。',
    parameters: {
      type: 'object',
      properties: {
        protocol_name: { type: 'string', description: '协议名称，需与协议库一致' },
        command: { type: 'string', description: '命令码（如 "0200"）或命令名称（如 "泵料"）' },
        values: {
          type: 'object',
          description: '字段名 → 值 的映射（可选字段可省略，省略按 0 填充）。枚举字段可填含义文本如 "水"；文本字段直接填字符串；未定义的字段值会被忽略',
        },
        payload_hex: { type: 'string', description: '可选：直接给载荷 HEX（空格分隔字节），给出时忽略 values' },
      },
      required: ['protocol_name', 'command'],
    },
    execute: async (args, { query }) => {
      const proto = await loadProtocolDef(query, String(args.protocol_name || '').trim()).catch(withAvailable);
      return clip(codec.buildFrame(proto, args.command, args.values || {}, { payloadHex: args.payload_hex }));
    },
  },

  parse_frame: {
    description: '按协议解析一帧 HEX 数据：定位命令字，逐字段给出原始值与含义（枚举含义/位域/物理值），并校验 CRC/累加和。不指定协议名时会在全部协议中自动识别（帧头匹配 + 校验通过者优先）。只做解析，不访问串口。',
    parameters: {
      type: 'object',
      properties: {
        hex: { type: 'string', description: '完整帧 HEX，如 "AA 01 02 00 01 00 8F 0D"' },
        protocol_name: { type: 'string', description: '可选，协议名称；省略时自动识别' },
      },
      required: ['hex'],
    },
    execute: async (args, { query }) => {
      const bytes = codec.hexToBytes(String(args.hex || ''));
      const name = String(args.protocol_name || '').trim();
      if (name) {
        const proto = await loadProtocolDef(query, name).catch(withAvailable);
        return clip(codec.parseFrame(proto, bytes));
      }
      const rows = await runQuery(query, 'SELECT id, name, version, check_method, config_json FROM protocols ORDER BY id');
      if (!rows.length) throw new Error('协议库为空，无法自动识别');
      const protos = [];
      for (const p of rows) {
        const cmds = await runQuery(query, 'SELECT code, name, config_json FROM commands WHERE protocol_id = ? ORDER BY id', [p.id]).catch(() => []);
        let cfg = {};
        try { cfg = JSON.parse(p.config_json || '{}'); } catch { /* ignore */ }
        protos.push(codec.buildProtoDef(p, cfg, cmds));
      }
      const hit = codec.autoDetectFrame(protos, bytes);
      if (!hit) {
        return {
          ok: false,
          error: '无法自动识别协议（无帧头匹配）',
          candidates: protos.map((p) => p.name).slice(0, 30),
        };
      }
      return clip({ detected_protocol: hit.proto.name, ...hit.result });
    },
  },

  list_serial_ports: {
    description: '枚举本机可用串口（路径、厂商、VID/PID）。注意：需要桌面应用处于运行状态；应用未运行时会返回明确错误。',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async (_args, ctx) => {
      const list = ctx && ctx.app && typeof ctx.app.listSerialPorts === 'function'
        ? await ctx.app.listSerialPorts()
        : null;
      if (!list) throw new Error('枚举串口需要 BaudLab 桌面应用处于运行状态（当前为离线模式）');
      return { count: list.length, ports: list };
    },
  },

  protocol_diff: {
    description: '对比两个协议（或同一协议两个版本快照）的定义差异：帧参数、模块地址表、指令表（新增/删除/改名/字段变化）。两个协议名对比给出完整差异；给定版本号则对比 protocol_versions 里的快照（仅帧参数级，快照不含命令表）。',
    parameters: {
      type: 'object',
      properties: {
        protocol_a: { type: 'string', description: '协议 A 名称（与 protocol_b 二选一使用：两两对比协议，或用 protocol_name 对比版本）' },
        protocol_b: { type: 'string', description: '协议 B 名称' },
        protocol_name: { type: 'string', description: '同一协议的版本对比：协议名称' },
        version_a: { type: 'string', description: '版本 A（省略时用当前生效定义）' },
        version_b: { type: 'string', description: '版本 B' },
      },
      required: [],
    },
    execute: async (args, { query }) => {
      if (args.protocol_name) {
        const name = String(args.protocol_name).trim();
        const snapRows = await runQuery(query, 'SELECT version, config_json, created_at FROM protocol_versions WHERE protocol_name = ? ORDER BY id', [name]);
        const pick = (v) => {
          if (!v) {
            return { label: '当前生效', config: null, loadCurrent: true };
          }
          const row = snapRows.find((r) => r.version === v);
          if (!row) {
            const e = new Error(`协议「${name}」没有版本快照 ${v}。已有: ${snapRows.map((r) => r.version).join('，') || '（无）'}`);
            throw e;
          }
          return { label: v, config: JSON.parse(row.config_json || '{}') };
        };
        const a = pick(args.version_a);
        const b = pick(args.version_b);
        const loadDef = async (side) => {
          if (side.config === null) {
            const protos = await runQuery(query, 'SELECT * FROM protocols WHERE name = ? COLLATE NOCASE', [name]);
            if (!protos.length) throw new Error(`协议库中不存在「${name}」`);
            return codec.buildProtoDef(protos[0], JSON.parse(protos[0].config_json || '{}'), []);
          }
          /* 快照行没有 check_method 等列，用占位行（buildProtoDef 优先取 config_json 内的值） */
          return codec.buildProtoDef({ name, check_method: side.config.checkType || '' }, side.config, []);
        };
        const diff = codec.diffProtoDefs(await loadDef(a), await loadDef(b));
        return clip({ mode: '版本对比', a: a.label, b: b.label, snapshot_count: snapRows.length, versions: snapRows.map((r) => r.version), ...diff });
      }
      const nameA = String(args.protocol_a || '').trim();
      const nameB = String(args.protocol_b || '').trim();
      if (!nameA || !nameB) throw new Error('需要 protocol_a + protocol_b（两协议对比）或 protocol_name + version_a/version_b（版本对比）');
      const defA = await loadProtocolDef(query, nameA).catch(withAvailable);
      const defB = await loadProtocolDef(query, nameB).catch(withAvailable);
      const diff = codec.diffProtoDefs(defA, defB);
      return clip({ mode: '协议对比', a: nameA, b: nameB, ...diff });
    },
  },

  /* ---------- 以下为写操作 / 实时串口工具：需要应用在线，写操作需人工确认 ---------- */

  serial_open: {
    dangerous: true,
    confirm: (a) => ({
      title: '打开串口',
      message: `AI 请求打开串口 ${a.port}（${a.baud_rate || 115200} ${a.data_bits || 8}${(a.parity || 'none')[0].toUpperCase()}${a.stop_bits || 1}）`,
      detail: '确认后该串口将被占用（与调试页共用），AI 可继续向其发送数据。不要授权给来历不明的自动化流程。',
      policyKey: `serial_open:${a.port}`,
      checkboxLabel: `记住"允许执行"，此后打开 ${a.port} 不再询问`,
    }),
    description: '打开指定串口（与调试页共用端口，重复打开会报"端口已打开"）。写操作：会弹出应用内确认框，用户允许后才执行。',
    parameters: {
      type: 'object',
      properties: {
        port: { type: 'string', description: '串口路径，如 COM3 / /dev/ttyUSB0' },
        baud_rate: { type: 'number', description: '波特率，默认 115200' },
        data_bits: { type: 'number', description: '数据位，默认 8' },
        stop_bits: { type: 'number', description: '停止位，默认 1' },
        parity: { type: 'string', enum: ['none', 'even', 'odd'], description: '校验位，默认 none' },
      },
      required: ['port'],
    },
    execute: async (args, ctx) => {
      const fn = ctx && ctx.app && ctx.app.openSerial;
      if (typeof fn !== 'function') throw new Error('打开串口需要桌面应用处于运行状态');
      const r = await fn({
        port: String(args.port || ''),
        baudRate: num(args.baud_rate, 115200, 300, 4000000),
        dataBits: num(args.data_bits, 8, 5, 8),
        stopBits: num(args.stop_bits, 1, 1, 3),
        parity: ['none', 'even', 'odd'].includes(args.parity) ? args.parity : 'none',
      });
      if (!r || !r.success) throw new Error((r && r.error) || '打开失败');
      return { ok: true, port: args.port, params: { baud: r.baudRate, dataBits: r.dataBits, stopBits: r.stopBits, parity: r.parity }, note: '已打开；用 serial_send 发送、serial_wait_frame 等待回复、serial_close 关闭' };
    },
  },

  serial_close: {
    dangerous: true,
    confirm: (a) => ({
      title: '关闭串口',
      message: `AI 请求关闭串口 ${a.port}`,
      detail: '若该串口正被调试页使用，关闭会影响调试会话（终端里的连接状态会断开）。',
      policyKey: `serial_close:${a.port}`,
      checkboxLabel: `记住"允许执行"，此后关闭 ${a.port} 不再询问`,
    }),
    description: '关闭指定串口。写操作：会弹出应用内确认框，用户允许后才执行。',
    parameters: {
      type: 'object',
      properties: { port: { type: 'string', description: '串口路径' } },
      required: ['port'],
    },
    execute: async (args, ctx) => {
      const fn = ctx && ctx.app && ctx.app.closeSerial;
      if (typeof fn !== 'function') throw new Error('关闭串口需要桌面应用处于运行状态');
      const r = await fn(String(args.port || ''));
      if (!r || !r.success) throw new Error((r && r.error) || '关闭失败');
      return { ok: true, port: args.port };
    },
  },

  serial_send: {
    dangerous: true,
    confirm: (a) => {
      const what = a.protocol_name
        ? `按协议「${a.protocol_name}」命令「${a.command}」构帧发送`
        : `直接发送 ${a.format === 'text' ? '文本' : 'HEX'} 数据`;
      return {
        title: '串口发送',
        message: `AI 请求向 ${a.port} 发送数据`,
        detail: `${what}。内容: ${String(a.data || '').slice(0, 200)}${String(a.data || '').length > 200 ? '…' : ''}`,
        policyKey: `serial_send:${a.port}`,
        checkboxLabel: `记住"允许执行"，此后向 ${a.port} 发送不再询问`,
      };
    },
    description: '向已打开的串口发送数据。可直接发 HEX/文本，或给 protocol_name + command + values 由工具按协议构帧后发送。写操作：会弹出应用内确认框，用户允许后才执行。',
    parameters: {
      type: 'object',
      properties: {
        port: { type: 'string', description: '已打开的串口路径' },
        data: { type: 'string', description: 'format=hex 时为十六进制串（"AA 01 02"）；format=text 时为文本' },
        format: { type: 'string', enum: ['hex', 'text'], description: '默认 hex' },
        protocol_name: { type: 'string', description: '可选：按该协议构帧后发送（构帧自动算长度与校验）' },
        command: { type: 'string', description: '命令码或命令名称（配合 protocol_name）' },
        values: { type: 'object', description: '字段名 → 值（配合 protocol_name，同 build_frame）' },
      },
      required: ['port', 'data'],
    },
    execute: async (args, ctx) => {
      const send = ctx && ctx.app && ctx.app.sendSerial;
      if (typeof send !== 'function') throw new Error('串口发送需要桌面应用处于运行状态');
      let data = String(args.data || '');
      let format = args.format === 'text' ? 'text' : 'hex';
      let frameInfo;
      if (args.protocol_name) {
        const proto = await loadProtocolDef(ctx.query, String(args.protocol_name).trim()).catch(withAvailable);
        const built = codec.buildFrame(proto, args.command, args.values || {});
        data = built.hex;
        format = 'hex';
        frameInfo = { cmd: built.cmd, cmd_name: built.cmdName, check: built.checkMethod, bytes: built.length };
      }
      const r = await send({ port: String(args.port || ''), data, format });
      if (!r || !r.success) throw new Error((r && r.error) || '发送失败');
      const out = { ok: true, port: args.port, bytes_written: r.bytesWritten, sent: String(data).slice(0, 120) };
      if (frameInfo) out.frame = frameInfo;
      return out;
    },
  },

  serial_wait_frame: {
    description: '等待串口收到数据：不带协议参数时返回下一个 RX 数据块；给定 protocol_name 时持续积累字节并尝试按协议解帧，返回第一条校验通过（可选匹配 command）的完整帧解析结果。只读，不发送任何数据。需要桌面应用运行。',
    parameters: {
      type: 'object',
      properties: {
        port: { type: 'string', description: '串口路径' },
        timeout_ms: { type: 'number', description: '最长等待，默认 5000，上限 120000' },
        protocol_name: { type: 'string', description: '可选：按该协议解帧' },
        command: { type: 'string', description: '可选：只接受该命令码的帧' },
      },
      required: ['port'],
    },
    execute: async (args, ctx) => {
      const waitForRx = ctx && ctx.app && ctx.app.waitForRx;
      if (typeof waitForRx !== 'function') throw new Error('等待串口数据需要桌面应用处于运行状态');
      const port = String(args.port || '');
      const deadline = Date.now() + Math.min(Math.max(num(args.timeout_ms, 5000, 200, 120000), 200), 120000);
      const name = String(args.protocol_name || '').trim();
      const proto = name ? await loadProtocolDef(ctx.query, name).catch(withAvailable) : null;
      const wantCmd = proto && args.command ? codec.findCmd(proto, args.command) : null;
      let buf = [];
      let waited = 0;
      while (Date.now() < deadline) {
        const chunk = await waitForRx(port, Math.min(deadline - Date.now(), 2000));
        if (!chunk) break;
        waited = Date.now() - (deadline - num(args.timeout_ms, 5000, 200, 120000));
        try { buf = buf.concat(codec.hexToBytes(chunk.hex)); } catch { continue; }
        if (!proto) {
          return { ok: true, port, wait_ms: waited, hex: codec.bytesToHex(buf), note: '如需按协议解帧请带 protocol_name 再次调用' };
        }
        if (buf.length > 8192) buf = buf.slice(-4096);
        for (const off of codec.headerOffsets(buf, proto)) {
          const r = codec.parseFrame(proto, buf.slice(off));
          if (r.ok && r.checkOk && (!wantCmd || String(r.cmd).toUpperCase() === String(wantCmd.code).toUpperCase())) {
            return { ok: true, port, wait_ms: waited, ...r };
          }
        }
      }
      return {
        ok: true, timeout: true, port,
        received_hex: codec.bytesToHex(buf).slice(0, 2000) || '（未收到数据）',
        note: proto ? '未等到校验通过的完整帧；可加大 timeout_ms 重试' : '超时未收到数据',
      };
    },
  },

  file_transfer_status: {
    description: '从最近串口日志中识别 AFT-1 文件传输帧（A5 5A 魔数），汇总最近一次传输：文件名/大小/总块数、已传块数、重传请求次数、最终结果（FINAL 状态）与各方向帧统计。不依赖传输页面状态，离线可用。',
    parameters: {
      type: 'object',
      properties: {
        count: { type: 'number', description: '扫描最近 N 条串口日志，默认 400，最大 2000' },
      },
      required: [],
    },
    execute: async (args, { query }) => {
      const n = num(args.count, 400, 1, 2000);
      const rows = await runQuery(query, `SELECT direction, data_hex, timestamp FROM serial_logs ORDER BY id DESC LIMIT ${n}`);
      const found = [];
      for (const r of rows) {
        const hex = String(r.data_hex || '');
        if (!hex.includes('A5 5A')) continue;
        let frames;
        try { frames = parseAft1Hex(hex); } catch { continue; }
        for (const f of frames) found.push({ dir: (r.direction || '?').toUpperCase(), time: r.timestamp, ...f });
      }
      if (!found.length) return { frames_found: 0, note: `最近 ${rows.length} 条串口日志中没有 AFT-1 传输帧` };

      /* 汇总：以最近一次 FILE_BEGIN 为起点 */
      const begins = found.filter((f) => f.type === 0x01);
      const lastBeginIdx = found.findIndex((f) => f.type === 0x01);
      const session = found.slice(0, Math.max(lastBeginIdx + 1, 0));
      let current = null;
      if (begins.length) {
        const b = begins[0];
        current = {
          file: b.meta.name, file_size: b.meta.fileSize, total_blocks: b.meta.totalBlocks,
          chunk_size: b.meta.chunkSize,
        };
      }
      const dataSeq = new Set();
      let resend = 0;
      let finalStatus;
      const activity = {};
      for (const f of session) {
        const k = `${f.dir} ${f.typeName}`;
        activity[k] = (activity[k] || 0) + 1;
        if (f.type === 0x02 && f.dir === 'TX') dataSeq.add(f.seq);
        if (f.type === 0x12) resend += 1;
        if (f.type === 0x13) finalStatus = AFT1_FINAL_STATUS[f.payload[0]] ?? `未知(${f.payload[0]})`;
      }
      return clip({
        frames_found: found.length,
        current_transfer: current,
        progress: current ? {
          data_frames_tx: dataSeq.size,
          percent: current.total_blocks ? Math.min(100, Math.round((dataSeq.size / current.total_blocks) * 100)) : null,
          resend_requests: resend,
          final_status: finalStatus || '未收到 FINAL（可能仍在传输或被取消）',
        } : undefined,
        activity,
        last_frame_at: found[0] && found[0].time,
        note: '统计基于串口日志识别，进度为估算值',
      });
    },
  },

  db_stats: {
    description: '数据库统计：每张表的行数与库文件大小。用于了解数据规模、确认导入/同步是否生效。',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async (_args, ctx) => {
      const tables = (await runQuery(ctx.query, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")).map((r) => r.name);
      const stats = [];
      for (const t of tables) {
        const rows = await runQuery(ctx.query, `SELECT COUNT(*) AS cnt FROM "${t.replace(/"/g, '""')}"`);
        stats.push({ table: t, rows: rows[0] ? rows[0].cnt : 0 });
      }
      return { tables: stats };
    },
  },

  db_backup: {
    dangerous: true,
    confirm: () => ({
      title: '数据库备份',
      message: 'AI 请求执行一次数据库备份',
      detail: '将以 VACUUM INTO 方式在数据目录生成 backup-<时间>.db，不影响现有数据。',
      policyKey: 'db_backup',
      checkboxLabel: '记住"允许执行"，此后备份不再询问',
    }),
    description: '立即执行一次数据库备份（VACUUM INTO 到数据目录，文件名 backup-<时间戳>.db）。写操作：会弹出应用内确认框。离线模式不可用。',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async (_args, ctx) => {
      const fn = ctx && ctx.app && ctx.app.dbBackup;
      if (typeof fn !== 'function') throw new Error('备份需要桌面应用处于运行状态（离线只读连接无法 VACUUM）');
      const r = await fn();
      if (!r || !r.success) throw new Error((r && r.error) || '备份失败');
      return { ok: true, path: r.path, size: r.size, time: r.time };
    },
  },

  draft_list: {
    description: '列出协议库中的协议及草稿标记（编辑保存未发布的协议带 draft: 前缀标记）、最近更新时间。可配合 draft_publish 发布到团队服务器。',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async (_args, { query }) => {
      const rows = await runQuery(query, 'SELECT name, version, created_by, updated_at FROM protocols ORDER BY updated_at DESC, name COLLATE NOCASE').catch(() => runQuery(query, 'SELECT name, version, updated_at FROM protocols ORDER BY name'));
      return clip({
        count: rows.length,
        protocols: rows.map((r) => ({
          name: r.name,
          version: r.version || '',
          is_draft: String(r.created_by || '').startsWith('draft:'),
          updated_at: r.updated_at,
        })),
      });
    },
  },

  draft_publish: {
    dangerous: true,
    confirm: (a) => ({
      title: '发布草稿到团队服务器',
      message: `AI 请求把草稿「${a.name}」发布到团队服务器`,
      detail: '将覆盖服务器上的同名协议（先删后插），进入团队同步范围。仅远程数据源模式下可用。',
      policyKey: `draft_publish:${a.name}`,
      checkboxLabel: `记住"允许执行"，此后发布「${a.name}」不再询问`,
    }),
    description: '把本地协议（草稿）的完整内容推送到团队服务器（覆盖服务器同名协议）。需要应用处于远程数据源模式；写操作：会弹出应用内确认框。',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: '协议名称' } },
      required: ['name'],
    },
    execute: async (args, ctx) => {
      const fn = ctx && ctx.app && ctx.app.publishDraft;
      if (typeof fn !== 'function') throw new Error('发布草稿需要桌面应用处于运行状态');
      const r = await fn(String(args.name || '').trim());
      if (!r || !r.success) throw new Error((r && r.error) || '发布失败');
      return { ok: true, name: args.name, note: '已推送到团队服务器' };
    },
  },
};

/* 转为两种协议的声明格式 */
function toSchemaList() {
  return Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, parameters: t.parameters }));
}

/* 统一的工具执行入口：供 mcp-bridge.js 与 mcp-server.js 复用。
 * 未知工具 / 参数异常 / execute 抛错一律转为 { ok:false, result: 文本 }，
 * 与 ai-assistant.js 的 executeToolCall 行为一致。
 * 写操作工具（dangerous: true）强制要求 ctx.confirm 人工确认：
 * 应用内 MCP 桥由主进程提供弹窗确认；离线模式 / 应用内助手环境一律拒绝执行。 */
async function executeTool(name, args, ctx) {
  const tool = TOOLS[name];
  if (!tool) return { ok: false, result: `未知工具: ${name}` };
  try {
    if (tool.dangerous) {
      if (!ctx || typeof ctx.confirm !== 'function') {
        return { ok: false, result: `${name} 是写操作工具，需要在桌面应用在线时由用户在应用内确认后执行（当前环境不可用，只读工具不受影响）` };
      }
      const question = tool.confirm(args || {});
      const allowed = await ctx.confirm(question);
      if (!allowed) return { ok: false, result: `用户在应用内拒绝了本次操作（${(question && question.title) || name}），未执行` };
    }
    const out = await tool.execute(args || {}, ctx || {});
    const text = typeof out === 'string' ? out : JSON.stringify(out, null, 1);
    const clipped = text.length > MAX_RESULT_CHARS ? text.slice(0, MAX_RESULT_CHARS) + '…(已截断)' : text;
    return { ok: true, result: clipped };
  } catch (e) {
    return { ok: false, result: `工具执行失败: ${String((e && e.message) || e)}` };
  }
}

module.exports = { TOOLS, toSchemaList, executeTool, MAX_RESULT_CHARS, parseFields };
