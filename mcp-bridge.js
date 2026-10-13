/* =========================================================================
 * 应用内 MCP 桥（主进程启动，随应用退出关闭）
 *
 * 作用：让独立 MCP 服务器（mcp-server.js，由外部 AI 客户端以 node 启动）
 * 在应用运行时拿到"活"数据——串口枚举、最新数据库内容——并把工具执行
 * 统一收口到应用进程内。
 *
 * 通信：127.0.0.1 回环 HTTP，随机令牌鉴权；桥接信息写入
 *   <数据目录>/mcp-bridge.json  { port, token, pid, version, startedAt }
 * 供 mcp-server.js 发现与鉴权。端口从 37655 起向上找空闲位。
 *
 * 接口（仅一个）：
 *   POST /mcp/tool   { name, args }  →  { ok, result }
 *   GET  /mcp/ping   →  { ok: true, version }
 * ========================================================================= */
'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { executeTool, MAX_RESULT_CHARS } = require('./ai-tools');

const PORT_RANGE_START = 37655;
const PORT_RANGE_SIZE = 10;
const BRIDGE_FILE = 'mcp-bridge.json';
/* 写操作要等用户在应用内点确认弹窗（最长 30s 自动拒绝），超时需覆盖它 */
const REQUEST_TIMEOUT_MS = 35000;

function registerMcpBridge({ dataDir, queryDatabase, app, confirm, log } = {}) {
  if (!dataDir) return { stop: () => {} };
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const token = crypto.randomBytes(24).toString('hex');
  const server = http.createServer((req, res) => {
    const send = (code, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(body);
    };

    /* 鉴权：回环 + Bearer 令牌；ping 也要求令牌，避免本机其他进程探测 */
    const auth = String(req.headers.authorization || '');
    if (auth !== `Bearer ${token}`) {
      send(401, { ok: false, error: 'unauthorized' });
      return;
    }

    if (req.method === 'GET' && req.url === '/mcp/ping') {
      send(200, { ok: true, pid: process.pid });
      return;
    }

    if (req.method !== 'POST' || req.url !== '/mcp/tool') {
      send(404, { ok: false, error: 'not found' });
      return;
    }

    let raw = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) { tooBig = true; req.destroy(); }
    });
    req.on('end', async () => {
      if (tooBig) return;
      let body;
      try { body = JSON.parse(raw || '{}'); } catch { send(400, { ok: false, error: 'bad json' }); return; }
      const name = String(body.name || '');
      const args = (body.args && typeof body.args === 'object') ? body.args : {};
      const started = Date.now();
      /* 工具执行上下文：query 数据通道 + app 能力钩子 + confirm 人工确认弹窗。
       * 写操作工具（dangerous）经 executeTool 强制走 confirm，用户拒绝则不执行 */
      const out = await executeTool(name, args, { query: queryDatabase, app, confirm });
      if (log) {
        try {
          log(out.ok ? 'info' : 'warn', `MCP桥调用 ${name}（${Date.now() - started}ms）${out.ok ? '' : ' → ' + String(out.result).slice(0, 120)}`);
        } catch { /* 日志失败不影响响应 */ }
      }
      send(200, out);
    });
  });

  /* 端口占用时向上重试；全部失败则放弃桥（MCP 仍可离线用，仅缺在线能力） */
  return new Promise((resolve) => {
    let port = PORT_RANGE_START;
    const tryListen = () => {
      if (port >= PORT_RANGE_START + PORT_RANGE_SIZE) {
        if (log) try { log('warn', 'MCP桥启动失败：37655~37664 端口均被占用'); } catch { /* ignore */ }
        resolve({ stop: () => {} });
        return;
      }
      server.once('error', () => { port += 1; tryListen(); });
      server.listen(port, '127.0.0.1', () => {
        const info = {
          port,
          token,
          pid: process.pid,
          version: 1,
          startedAt: new Date().toISOString(),
        };
        try { fs.writeFileSync(path.join(dataDir, BRIDGE_FILE), JSON.stringify(info, null, 2)); } catch { /* ignore */ }
        console.log('[MCP] 桥已就绪:', `127.0.0.1:${port}`, '→', path.join(dataDir, BRIDGE_FILE));
        resolve({
          port,
          file: path.join(dataDir, BRIDGE_FILE),
          stop: () => {
            try { server.close(); } catch { /* ignore */ }
            try {
              const file = path.join(dataDir, BRIDGE_FILE);
              if (fs.existsSync(file)) {
                const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
                if (cur.pid === process.pid) fs.unlinkSync(file);
              }
            } catch { /* ignore */ }
          },
        });
      });
    };
    tryListen();
  });
}

module.exports = { registerMcpBridge, BRIDGE_FILE, PORT_RANGE_START, PORT_RANGE_SIZE, MAX_RESULT_CHARS, REQUEST_TIMEOUT_MS };
