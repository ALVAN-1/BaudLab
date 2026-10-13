/**
 * 团队数据共享服务器（方案 A：中心小服务器 + HTTP 适配）
 *
 * 部署（已简化为零依赖）：
 *   - 服务器电脑安装 Node.js 22.13+ 后，双击「启动服务器.bat」即可运行
 *     （优先使用 Node 内置 SQLite 模块，无需 npm install 任何依赖）
 *   - Node 版本较低时自动回退 better-sqlite3，需在当前目录执行一次：
 *     npm install better-sqlite3
 *   - 本开发机也可直接 node server.js / npx electron server.js
 *
 * 部署到服务器电脑：将 server.js / db-schema.js / 启动服务器.bat 三个文件
 * 拷贝到服务器同一目录，安装 Node.js 22.13+ 后双击「启动服务器.bat」即可运行
 * （如需开机自启，可自行用任务计划程序或 pm2 注册）
 *
 * 配置：server.config.json（首次启动自动生成）
 *   {
 *     "port": 3010,
 *     "token": "团队访问令牌，留空则不鉴权（仅建议纯内网环境）",
 *     "dbPath": "server-data/serial_protocol.db",
 *     "backup": {
 *       "enabled": true,          // 启用定时备份
 *       "dir": "server-data/backups", // 备份目录（相对路径基于本文件）
 *       "intervalHours": 24,      // 备份间隔（小时）
 *       "keep": 14                // 保留最近 N 份，超出自动清理
 *     }
 *   }
 * 常驻：双击「开机自启.bat」注册当前用户启动项，或用 pm2 / 任务计划程序
 *
 * 接口（与桌面端 electronAPI.db 一一对应，切换数据源后渲染层零改动）：
 *   GET  /api/health   健康检查（返回协议数量与服务器时间）
 *   POST /api/query    { sql, params }            → { success, rows }
 *   POST /api/execute  { sql, params }            → { success, changes, lastInsertRowid }
 *   POST /api/batch    { statements: [{sql, params}] } → { success, results }
 *
 * 邮箱认证（新版登录模型：邮箱 + 密码，注册需邮箱验证码）：
 *   POST /api/auth/register-request  { email }                          → 发送注册验证码（60s 冷却）
 *   POST /api/auth/register-verify   { email, code, password, displayName } → 建号并签发令牌
 *   POST /api/auth/login             { email, password }                → 登录签发令牌
 *   POST /api/auth/forgot-request    { email }                          → 发送重置验证码（防枚举）
 *   POST /api/auth/reset-password    { email, code, password }          → 重置密码并吊销旧令牌
 *   POST /api/auth/session-check     {}（凭 X-User + X-User-Token）      → 会话有效性确认
 *
 * 已知限制：当前为局域网明文 HTTP，密码/令牌未加密传输；
 * 后续需引入 HTTPS（Nginx 反代或自签证书），见 TODO_HTTPS 标记。
 *
 * 所有请求需携带 Authorization: Bearer <token>（配置了 token 时）
 * 数据库仅本进程读写（同步执行，天然串行化写入），
 * 备份建议：定时任务复制 db 文件，或 Litestream 推送到对象存储
 */
const http = require('http');
const net = require('net');
const tls = require('tls');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { initSchema, hashPassword, verifyPassword } = require('./db-schema');
const { exec } = require('child_process');

/* ===================== UI 引擎 ===================== */
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red:    '\x1b[38;2;239;68;68m',
  green:  '\x1b[38;2;34;197;94m',
  yellow: '\x1b[38;2;245;158;11m',
  blue:   '\x1b[38;2;59;130;246m',
  purple: '\x1b[38;2;139;92;246m',
  cyan:   '\x1b[38;2;6;182;212m',
  gray:   '\x1b[38;2;107;114;128m',
  bgPurple: '\x1b[48;2;76;65;162m',
};
const W = '═', HW = '─';

function stripAnsi(s) { return typeof s === 'string' ? s.replace(/\x1b\[[0-9;]*m/g, '') : String(s); }
function pad(str, width) { const len = [...stripAnsi(str)].length; return str + ' '.repeat(Math.max(0, width - len)); }
function center(str, width) { const len = [...stripAnsi(str)].length; return ' '.repeat(Math.max(0, Math.floor((width - len) / 2))) + str; }

function ts() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${C.gray}${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${C.reset}`;
}

function tag(label, color) {
  const map = { Server: C.cyan, Backup: C.purple, Updates: C.blue, Error: C.red, Sql: C.yellow };
  return `${color || map[label] || C.gray}${C.bold}[${label}]${C.reset}`;
}

const logServer = (m) => console.log(`  ${ts()} ${tag('Server')} ${m}`);
const logBackup = (m) => console.log(`  ${ts()} ${tag('Backup')} ${C.purple}${m}${C.reset}`);
const logUpdates = (m) => console.log(`  ${ts()} ${tag('Updates')} ${C.blue}${m}${C.reset}`);
const logError = (m) => console.log(`  ${ts()} ${tag('Error')} ${C.red}${m}${C.reset}`);

/* ---------------- 数据库驱动 ----------------
 * 优先 Node 内置 node:sqlite（22.13+ 免依赖）；
 * 低版本/受限环境回退 better-sqlite3（需 npm install）。
 * 两者 prepare/all/get/run 接口兼容，仅事务与 pragma 写法不同。
 */
let Database = null;
let useBuiltinSqlite = false;
try {
  const { DatabaseSync } = require('node:sqlite');
  /* 探测：22.5–22.12 需实验标志才能实例化，失败则回退 */
  const probe = new DatabaseSync(':memory:');
  probe.exec('SELECT 1');
  probe.close();
  Database = DatabaseSync;
  useBuiltinSqlite = true;
} catch {
  Database = require('better-sqlite3');
}

/* ---------------- 配置 ---------------- */
const CONFIG_PATH = path.join(__dirname, 'server.config.json');

function loadConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    } catch (e) {
      logError(`config.json 解析失败，使用默认配置: ${e.message}`);
      return {};
    }
  }
  const def = { port: 3010, token: '', dbPath: 'server-data/serial_protocol.db', backup: { enabled: true, dir: 'server-data/backups', intervalHours: 24, keep: 14 } };
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(def, null, 2));
    logServer('已生成默认配置 server.config.json，可按需修改端口与令牌');
  } catch {
    /* 只读目录等场景下忽略 */
  }
  return def;
}

const config = loadConfig();
const PORT = parseInt(config.port, 10) || 3010;
let TOKEN = String(config.token || ''); // 团队访问令牌（管理台可热更新）
const DB_PATH = path.isAbsolute(config.dbPath || '')
  ? config.dbPath
  : path.join(__dirname, config.dbPath || path.join('server-data', 'serial_protocol.db'));

/* ===================== 邮件发送（内置极简 SMTP 客户端，零依赖） =====================
 * 支持 465 隐式 TLS 与 587 STARTTLS + AUTH LOGIN。
 * 兜底策略：mail 未启用或发送失败时，验证码打印到服务器控制台（内网工具可用性优先），
 * 保证未配置 SMTP 的团队仍可完成注册；配置好 SMTP 后验证码只走邮件不再落控制台。
 *
 * server.config.json 新增配置节：
 *   "mail": { "enabled": true, "host": "smtp.exmail.qq.com", "port": 465,
 *             "secure": true, "user": "noreply@xxx.com", "pass": "SMTP授权码", "from": "" }
 */
/** 由配置节计算邮件设置（管理台保存后热更新重建） */
function computeMailCfg(mail) {
  return {
    enabled: !!(mail && mail.enabled && mail.host && mail.user),
    host: String((mail && mail.host) || ''),
    port: parseInt((mail && mail.port), 10) || 465,
    secure: !(mail && mail.secure === false),
    user: String((mail && mail.user) || ''),
    pass: String((mail && mail.pass) || ''),
    from: String((mail && mail.from) || (mail && mail.user) || ''),
  };
}
let MAIL_CFG = computeMailCfg(config.mail);

const MAIL_SENDER_NAME = '串口协议管理工具';

/** RFC 2047 编码邮件头（中文主题） */
function encodeMailHeader(s) {
  return `=?UTF-8?B?${Buffer.from(String(s), 'utf8').toString('base64')}?=`;
}

/**
 * 发送一封纯文本邮件（阻塞到 QUIT 前，失败抛错）
 * @param {{to: string, subject: string, text: string}} mail
 */
async function sendMail({ to, subject, text }) {
  if (!MAIL_CFG.enabled) throw new Error('邮件服务未配置');

  /* 1) 连接：465 直接 TLS，587 明文连接后 STARTTLS 升级 */
  let socket = await new Promise((resolve, reject) => {
    const s = MAIL_CFG.secure
      ? tls.connect({ host: MAIL_CFG.host, port: MAIL_CFG.port, servername: MAIL_CFG.host })
      : net.connect({ host: MAIL_CFG.host, port: MAIL_CFG.port });
    s.once('error', reject);
    s.once(MAIL_CFG.secure ? 'secureConnect' : 'connect', () => {
      s.removeListener('error', reject);
      resolve(s);
    });
  });

  let buf = '';
  let pending = null;
  let closed = false;
  const deadline = setTimeout(() => finish(new Error('SMTP 会话超时')), 30000);

  function finish(err, reply) {
    if (closed) return;
    closed = true;
    clearTimeout(deadline);
    try { socket.destroy(); } catch { /* 已关闭 */ }
    if (pending) {
      const p = pending;
      pending = null;
      err ? p.reject(err) : p.resolve(reply);
    }
  }

  /** 从缓冲提取一个完整回复（多行回复以 "ddd " 空格行收束） */
  function extractReply() {
    const lines = buf.split('\r\n');
    for (let i = 0; i < lines.length; i++) {
      if (/^\d{3} /.test(lines[i])) {
        buf = lines.slice(i + 1).join('\r\n');
        return { code: parseInt(lines[i].slice(0, 3), 10), last: lines[i] };
      }
    }
    return null;
  }

  function attach(s) {
    s.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      if (!pending) return;
      const r = extractReply();
      if (r) {
        const p = pending;
        pending = null;
        p.resolve(r);
      }
    });
    s.once('error', (e) => finish(e));
    s.once('close', () => finish(new Error('SMTP 连接被关闭')));
  }
  attach(socket);

  const readReply = () => new Promise((resolve, reject) => {
    if (closed) return reject(new Error('SMTP 会话已结束'));
    const r = extractReply();
    if (r) return resolve(r);
    pending = { resolve, reject };
  });

  const cmd = async (line, okCodes) => {
    socket.write(line + '\r\n');
    const r = await readReply();
    if (!okCodes.includes(r.code)) throw new Error(`SMTP ${r.code}: ${r.last}`);
    return r;
  };

  const ehloDomain = (MAIL_CFG.from.split('@')[1] || 'spm.local').replace(/[^\w.-]/g, '') || 'spm.local';

  try {
    const greet = await readReply();
    if (greet.code !== 220) throw new Error(`SMTP ${greet.code}: ${greet.last}`);

    await cmd(`EHLO ${ehloDomain}`, [250]);
    if (!MAIL_CFG.secure) {
      /* STARTTLS：升级后重新挂载读取器 */
      await cmd('STARTTLS', [220]);
      socket.removeAllListeners('data');
      socket.removeAllListeners('error');
      socket.removeAllListeners('close');
      socket = await new Promise((resolve, reject) => {
        const t = tls.connect({ socket, servername: MAIL_CFG.host, rejectUnauthorized: false });
        t.once('error', reject);
        t.once('secureConnect', () => {
          t.removeListener('error', reject);
          resolve(t);
        });
      });
      buf = '';
      attach(socket);
      await cmd(`EHLO ${ehloDomain}`, [250]);
    }

    await cmd('AUTH LOGIN', [334]);
    await cmd(Buffer.from(MAIL_CFG.user).toString('base64'), [334]);
    await cmd(Buffer.from(MAIL_CFG.pass).toString('base64'), [235]);

    await cmd(`MAIL FROM:<${MAIL_CFG.from}>`, [250]);
    await cmd(`RCPT TO:<${to}>`, [250, 251]);
    await cmd('DATA', [354]);

    /* 正文 base64（76 列折行）；base64 字母表不含 '.'，无需 SMTP 点填充 */
    const body = Buffer.from(String(text || ''), 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
    const data = [
      `From: =?UTF-8?B?${Buffer.from(MAIL_SENDER_NAME).toString('base64')}?= <${MAIL_CFG.from}>`,
      `To: <${to}>`,
      `Subject: ${encodeMailHeader(subject)}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${Date.now()}.${crypto.randomBytes(6).toString('hex')}@spm>`,
      '',
      body,
      '',
    ].join('\r\n');
    socket.write(data + '\r\n.\r\n');
    const sent = await readReply();
    if (sent.code !== 250) throw new Error(`SMTP ${sent.code}: ${sent.last}`);
    socket.write('QUIT\r\n');
  } finally {
    finish();
  }
}

/**
 * 发送验证码邮件；邮件未启用时验证码兜底打印到控制台（见 MAIL_CFG 注释）
 * @returns {Promise<{delivered: boolean}>}
 */
async function sendCodeMail(email, code, purpose) {
  const action = purpose === 'register' ? '注册' : '密码重置';
  const subject = `【${MAIL_SENDER_NAME}】${action}验证码：${code}`;
  const text = [
    `您的${action}验证码为：${code}`,
    '',
    '验证码 10 分钟内有效，请勿泄露给他人。',
    '如非本人操作，请忽略本邮件。',
  ].join('\n');
  if (!MAIL_CFG.enabled) {
    logServer(`邮件未配置，验证码兜底输出 → ${email} ${C.bold}${code}${C.reset}（10 分钟内有效）`);
    return { delivered: false };
  }
  try {
    await sendMail({ to: email, subject, text });
    logServer(`验证码邮件已发送 → ${C.gray}${email}${C.reset}`);
    return { delivered: true };
  } catch (e) {
    /* 发送失败兜底打印，避免 SMTP 故障阻塞注册/找回（控制台可见即为本人操作） */
    logError(`验证码邮件发送失败(${email}): ${e.message}，验证码兜底输出 ${C.bold}${code}${C.reset}`);
    return { delivered: false, error: e.message };
  }
}

/* ---------------- SSE 版本推送 ---------------- */
const sseClients = new Map(); // clientId -> response
let sseClientCount = 0;

/* ---------------- 在线用户追踪 ---------------- */
const onlineUsers = new Map(); // username -> { displayName, lastSeen }
const HEARTBEAT_TIMEOUT_MS = 90000; // 90 秒无心跳视为离线

function cleanStaleOnlineUsers() {
  const now = Date.now();
  for (const [name, info] of onlineUsers) {
    if (now - info.lastSeen > HEARTBEAT_TIMEOUT_MS) {
      onlineUsers.delete(name);
    }
  }
}

function broadcastUpdate(version, releaseNotes) {
  const data = JSON.stringify({ version, releaseNotes, time: Date.now() });
  let count = 0;
  for (const [id, res] of sseClients) {
    if (res.writableEnded) {
      sseClients.delete(id);
      sseClientCount--;
      continue;
    }
    res.write(`event: update\ndata: ${data}\n\n`);
    count++;
  }
  return count;
}

/* ---------------- 数据库 ---------------- */
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 5000');
initSchema(db);
logServer(`数据库就绪: ${C.gray}${DB_PATH}${C.reset} ${C.green}${useBuiltinSqlite ? '(Node 内置 SQLite)' : '(better-sqlite3)'}${C.reset}`);

/* ---------------- 定时备份 ----------------
 * 使用 SQLite 官方推荐的 VACUUM INTO 在线备份：
 *   - 对 WAL 模式库安全：生成事务一致的自包含副本（自动包含未 checkpoint 的 WAL 内容）
 *   - 不阻塞业务读写（写请求在备份期间由 WAL 正常承载）
 *   - 产物经过压缩，且可在驱动版本不同的环境下直接打开
 * 策略：启动时备份一次 + 每 intervalHours 小时定时备份；保留最近 keep 份，超出按mtime 清理
 * 旧配置文件无 backup 字段时自动启用默认策略（对齐 def 默认值），无需手工迁移
 */
const backupCfg = {
  enabled: config.backup?.enabled !== false, // 缺省视为启用（config.backup 为 undefined 时不启用则永不备份）
  dir: path.isAbsolute(String(config.backup?.dir || ''))
    ? String(config.backup?.dir)
    : path.join(__dirname, config.backup?.dir || path.join('server-data', 'backups')),
  intervalHours: Math.max(1, parseInt(config.backup?.intervalHours, 10) || 24),
  keep: Math.max(1, parseInt(config.backup?.keep, 10) || 14),
};
const BACKUP_PREFIX = 'serial_protocol';
const BACKUP_SUFFIX = '.db';

/** 生成形如 serial_protocol-20260825-143012.db 的备份文件名（本地时间，便于人工辨认） */
function backupFileName(now = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${BACKUP_PREFIX}-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}${BACKUP_SUFFIX}`;
}

/**
 * 执行一次备份并轮转清理
 * 备份失败仅打日志不抛出：备份故障不应拖垮数据服务本身（可用性优先）
 * @returns {boolean} 是否成功
 */
function runBackup() {
  try {
    fs.mkdirSync(backupCfg.dir, { recursive: true });
    const dest = path.join(backupCfg.dir, backupFileName());
    /* 目标文件已存在时 VACUUM INTO 会报错；秒级重名的场景（连续手动触发）先删除 */
    if (fs.existsSync(dest)) fs.unlinkSync(dest);
    db.prepare('VACUUM INTO ?').run(dest);
    logBackup(`备份完成: ${C.gray}${dest}${C.reset} ${C.green}(${(fs.statSync(dest).size / 1024).toFixed(1)} KB)${C.reset}`);

    /* 轮转清理：仅匹配本工具命名规则的文件，按修改时间升序删除超出 keep 的最旧份 */
    const backups = fs.readdirSync(backupCfg.dir)
      .filter(f => f.startsWith(BACKUP_PREFIX) && f.endsWith(BACKUP_SUFFIX))
      .map(f => ({ f, mtime: fs.statSync(path.join(backupCfg.dir, f)).mtimeMs }))
      .sort((a, b) => a.mtime - b.mtime);
    for (let i = 0; i < backups.length - backupCfg.keep; i++) {
      fs.unlinkSync(path.join(backupCfg.dir, backups[i].f));
      logBackup(`轮转清理: ${C.gray}${backups[i].f}${C.reset}`);
    }
    return true;
  } catch (e) {
    logError(`备份失败: ${e.message}`);
    return false;
  }
}

let backupTimer = null;
if (backupCfg.enabled) {
  runBackup(); // 启动即备份一次，保证最新状态落盘
  backupTimer = setInterval(() => runBackup(), backupCfg.intervalHours * 3600 * 1000);
  logBackup(`定时备份已启用: 目录 ${C.gray}${backupCfg.dir}${C.reset}，间隔 ${C.bold}${backupCfg.intervalHours}h${C.reset}，保留 ${C.bold}${backupCfg.keep}${C.reset} 份`);
} else {
  logBackup('定时备份已在配置中禁用');
}

/** 最近一次备份信息（健康检查与管理台共用） */
function lastBackupInfo() {
  try {
    const files = fs.readdirSync(backupCfg.dir)
      .filter(f => f.startsWith(BACKUP_PREFIX) && f.endsWith(BACKUP_SUFFIX))
      .map(f => ({ f, mtime: fs.statSync(path.join(backupCfg.dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length > 0) {
      return { file: files[0].f, time: new Date(files[0].mtime).toLocaleString('zh-CN', { hour12: false }), total: files.length };
    }
  } catch { /* 备份目录不存在等场景，忽略 */ }
  return null;
}

/** 管理台热更新备份设置：清旧定时器，按新参数重建 */
function applyBackupSettings(enabled, intervalHours, keep) {
  backupCfg.enabled = !!enabled;
  backupCfg.intervalHours = Math.max(1, parseInt(intervalHours, 10) || 24);
  backupCfg.keep = Math.max(1, parseInt(keep, 10) || 14);
  if (backupTimer) { clearInterval(backupTimer); backupTimer = null; }
  if (backupCfg.enabled) {
    backupTimer = setInterval(() => runBackup(), backupCfg.intervalHours * 3600 * 1000);
  }
  logBackup(`备份设置已更新: ${backupCfg.enabled ? '启用' : '禁用'}，间隔 ${backupCfg.intervalHours}h，保留 ${backupCfg.keep} 份`);
}

/**
 * 批量执行（事务）：内置驱动无 transaction() 助手，用 BEGIN/COMMIT 等价实现
 * 每条语句支持可选的 expectChanges 字段（CAS 乐观锁校验）：
 *   实际影响行数与预期不符时抛错，整个事务回滚，用于关闭"检查-写入"竞态窗口
 *   错误信息带 CAS_CONFLICT: 前缀，与桌面端 main.js 的 db:batch 行为保持一致
 * @param {Array<{sql: string, params?: Array, expectChanges?: number}>} stmts
 */
function runBatch(stmts) {
  const list = Array.isArray(stmts) ? stmts : [];
  const check = (r, expectChanges) => {
    if (expectChanges !== undefined && r.changes !== expectChanges) {
      throw new Error(`CAS_CONFLICT: 语句影响 ${r.changes} 行，预期 ${expectChanges} 行（数据已被其他用户/窗口修改）`);
    }
    return { changes: r.changes, lastInsertRowid: Number(r.lastInsertRowid) };
  };
  if (useBuiltinSqlite) {
    db.exec('BEGIN');
    try {
      const results = list.map(({ sql, params, expectChanges }) =>
        check(db.prepare(sql).run(...(params || [])), expectChanges));
      db.exec('COMMIT');
      return results;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* 连接异常时忽略 */ }
      throw e;
    }
  }
  const tx = db.transaction((items) => items.map(({ sql, params, expectChanges }) =>
    check(db.prepare(sql).run(...(params || [])), expectChanges)));
  return tx(list);
}

/* ===================== SQL 网关安全层 =====================
 * 修复报告问题 #1（SQL 直通）：
 *   服务器不再无条件执行客户端 SQL，改为「动词 + 表」白名单校验。
 *   - 仅允许 SELECT / INSERT / UPDATE / DELETE / REPLACE 五类 DML 动词
 *   - 表引用（FROM/JOIN/INTO/UPDATE 目标）必须全部命中业务表白名单
 *   - DROP / ALTER / ATTACH / PRAGMA / VACUUM / CREATE / WITH 等一律拒绝
 *   - better-sqlite3 与 node:sqlite 的 prepare() 均拒绝多语句，天然防注入拼接
 * 修复报告问题 #2/#3（共享 Token + 零鉴权）：
 *   - 写操作必须携带有效的用户级令牌（X-User + X-User-Token 头）
 *   - users / roles 表的写操作要求操作人为管理员（身份伪造防护）
 *   - users 表的 api_token 列禁止经网关修改（令牌只由服务器签发）
 *   - 审核流自审拦截（问题 #4）：approved/rejected/published 状态变更
 *     要求操作人 ≠ 申请人；withdrawn 要求操作人 = 申请人
 *   - 管理死锁防护：users 表锁定自己、锁定/删除最后一个可用管理员一律拒绝
 *   - 所有写操作落 app_logs 审计（操作人 + 动词 + 表）
 */

/* 允许经网关访问的业务表 */
const SQL_ALLOWED_TABLES = new Set([
  'protocols', 'commands', 'modules', 'audit_logs', 'protocol_versions',
  'serial_logs', 'app_logs', 'projects', 'notifications', 'users', 'roles',
]);
/* 写操作需管理员角色的特权表 */
const SQL_ADMIN_TABLES = new Set(['users', 'roles']);
/* 仅允许的 SQL 动词（全部为 DML，DDL/DAL 一律拒绝） */
const SQL_ALLOWED_VERBS = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE']);
/* users 表允许非管理员自助修改的列（只能改自己的行） */
const USERS_SELF_COLUMNS = new Set(['last_login', 'password_hash']);

/** 可登录的管理员数量（active + 邮箱已验证 + 已设密码）
 *  新版登录为邮箱 + 密码：无邮箱/未验证/无密码的管理员实际无法登录，
 *  死锁校验按"可登录"口径统计，否则会误判"还有管理员"造成无人能管理用户 */
function countLoginableAdmins() {
  return db.prepare(`
    SELECT COUNT(*) AS c FROM users u
    LEFT JOIN roles r ON u.role_id = r.id
    WHERE r.name = '管理员' AND u.status = 'active'
      AND u.email_verified = 1 AND u.password_hash != ''
  `).get().c;
}

/** 校验"锁定/删除最后一个可用管理员"死锁场景；违规抛错 */
function checkAdminDeadlock(targetId, action) {
  if (!Number.isFinite(targetId)) return;
  const target = db.prepare(`
    SELECT u.status, r.name AS role_name FROM users u
    LEFT JOIN roles r ON u.role_id = r.id
    WHERE u.id = ?
  `).get(targetId);
  if (target && target.status === 'active' && target.role_name === '管理员' && countLoginableAdmins() <= 1) {
    throw new Error(`不能${action}最后一个可登录管理员（否则将无人能管理用户）`);
  }
}

/** 解析 SQL 动词 + 全部表引用；非法语句抛错 */
function parseSqlStatement(sql) {
  const trimmed = String(sql || '').trim();
  if (!trimmed) throw new Error('SQL 语句为空');
  const verb = (trimmed.match(/^(\w+)/) || ['', ''])[1].toUpperCase();
  if (!SQL_ALLOWED_VERBS.has(verb)) {
    throw new Error(`禁止执行的语句类型: ${verb || '(空)'}（仅允许 SELECT/INSERT/UPDATE/DELETE）`);
  }
  const tables = new Set();
  /* UPDATE 目标表（含 UPDATE OR ROLLBACK/ABORT/REPLACE/FAIL/IGNORE 变体） */
  const up = trimmed.match(/^UPDATE(?:\s+OR\s+\w+)?\s+["'`\[]?(\w+)/i);
  if (up) tables.add(up[1].toLowerCase());
  /* FROM / JOIN / INTO 引用的表（覆盖子查询、联结、INSERT INTO ... SELECT） */
  const refRe = /\b(?:FROM|JOIN|INTO)\s+["'`\[]?(\w+)/gi;
  let m;
  while ((m = refRe.exec(trimmed))) tables.add(m[1].toLowerCase());
  for (const t of tables) {
    if (!SQL_ALLOWED_TABLES.has(t)) throw new Error(`禁止访问的表: ${t}`);
  }
  return { verb, tables };
}

/** 从 SQL 中提取「col = ?」对应参数在 params 数组中的下标；找不到返回 null */
function sqlParamIndexOf(sql, col) {
  const re = new RegExp(`\\b${col}\\s*=\\s*\\?`, 'i');
  const m = re.exec(sql);
  if (!m) return null;
  const before = sql.slice(0, m.index + m[0].length);
  const count = (before.match(/\?/g) || []).length;
  return count - 1;
}

/** 提取 UPDATE 语句 SET 子句的列名集合（小写）；解析失败返回 null */
function extractSetColumns(sql) {
  const m = String(sql).match(/^UPDATE\s+(?:OR\s+\w+\s+)?["'`\[]?\w+["'`\]]?\s+SET\s+([\s\S]*?)(?:\s+WHERE\s+|$)/i);
  if (!m) return null;
  const cols = new Set();
  let cm;
  const colRe = /(\w+)\s*=/g;
  while ((cm = colRe.exec(m[1]))) cols.add(cm[1].toLowerCase());
  return cols;
}

/** 提取 INSERT 语句列名列表中指定列的参数值；解析失败返回 undefined */
function getInsertColumnValue(sql, params, col) {
  const m = String(sql).match(/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+\w+\s*\(([^)]+)\)/i);
  if (!m) return undefined;
  const cols = m[1].split(',').map(s => s.trim().toLowerCase());
  const idx = cols.indexOf(col.toLowerCase());
  return idx >= 0 ? params?.[idx] : undefined;
}

/** 校验单条写语句的权限；违规抛错（返回值供审计） */
function checkWritePermission(op, verb, table, sql, params) {
  const isAdmin = op.role === '管理员';

  if (table === 'users') {
    if (verb === 'INSERT' || verb === 'DELETE') {
      if (!isAdmin) throw new Error('用户管理操作需要管理员身份');
      /* 管理死锁防护：不能删除最后一个可用管理员 */
      if (verb === 'DELETE') {
        const idIdx = sqlParamIndexOf(sql, 'id');
        checkAdminDeadlock(idIdx != null ? Number(params?.[idIdx]) : NaN, '删除');
      }
    } else if (verb === 'UPDATE') {
      const setCols = extractSetColumns(sql) || new Set();
      /* 令牌列只能由服务器内部签发流程修改，网关一律拒绝（防伪造他人令牌） */
      if (setCols.has('api_token') || setCols.has('api_token_expires')) {
        throw new Error('禁止通过网关修改用户令牌');
      }
      /* 管理死锁防护：锁定（status 改为非 active）时不能锁定自己、不能锁定最后一个可用管理员 */
      if (setCols.has('status')) {
        const statusIdx = sqlParamIndexOf(sql, 'status');
        const newStatus = statusIdx != null ? String(params?.[statusIdx] ?? '') : '';
        if (newStatus && newStatus !== 'active') {
          const idIdx = sqlParamIndexOf(sql, 'id');
          const targetId = idIdx != null ? Number(params?.[idIdx]) : NaN;
          if (targetId === op.id) {
            throw new Error('不能锁定当前登录的账号（锁定后无人能进入人员管理解锁）');
          }
          checkAdminDeadlock(targetId, '锁定');
        }
      }
      const selfOnly = [...setCols].every(c => USERS_SELF_COLUMNS.has(c));
      if (selfOnly) {
        /* 自助列（last_login / password_hash）：仅允许改自己 */
        const idx = sqlParamIndexOf(sql, 'id');
        const targetId = idx != null ? Number(params?.[idx]) : NaN;
        if (targetId !== op.id && !isAdmin) throw new Error('只能修改自己的登录/密码数据');
      } else if (!isAdmin) {
        throw new Error('用户管理操作需要管理员身份');
      }
    }
  }

  if (table === 'roles' && !isAdmin) {
    throw new Error('角色管理操作需要管理员身份');
  }

  /* 审核流校验：提交人身份绑定 + 自审拦截 */
  if (table === 'audit_logs') {
    if (verb === 'INSERT') {
      const applicant = getInsertColumnValue(sql, params, 'applicant');
      if (applicant != null && String(applicant) !== op.username) {
        throw new Error('只能以本人身份提交审核申请');
      }
    } else if (verb === 'UPDATE') {
      const statusIdx = sqlParamIndexOf(sql, 'status');
      const newStatus = statusIdx != null ? String(params?.[statusIdx] || '') : '';
      if (['approved', 'rejected', 'published', 'withdrawn'].includes(newStatus)) {
        const cidIdx = sqlParamIndexOf(sql, 'change_id');
        const changeId = cidIdx != null ? params?.[cidIdx] : null;
        const row = changeId != null
          ? db.prepare('SELECT applicant, assignee, status FROM audit_logs WHERE change_id = ?').get(changeId)
          : null;
        if (row) {
          const isSelf = row.applicant === op.username;
          const opRow = db.prepare('SELECT display_name FROM users WHERE username = ?').get(op.username);
          const isAssignee = !!row.assignee && !!opRow && row.assignee === opRow.display_name;
          const isAdmin = op.role === '管理员';

          if (newStatus === 'withdrawn') {
            /* 撤回：仅申请人本人，且只能撤回待审核中的变更 */
            if (!isSelf) throw new Error('服务端校验：只能撤回自己提交的变更');
            if (row.status !== 'pending') throw new Error('服务端校验：仅待审核中的变更可以撤回');
          } else if (newStatus === 'published') {
            /* 发布生效：不是审核行为。审核通过后允许申请人本人发布（否则通过后无人能发布），
             * 审核人/管理员也可代发布；必须从 approved 流转，防止绕过审核直接发布 */
            if (row.status !== 'approved') throw new Error('服务端校验：仅审核通过的变更可以发布生效');
            if (!isSelf && !isAssignee && !isAdmin) {
              throw new Error('服务端校验：仅申请人、审核人或管理员可以发布生效');
            }
          } else {
            /* 通过/驳回：审核行为，不能审核自己提交的变更，且只能审核待审核中的变更 */
            if (isSelf) throw new Error('服务端校验：不能审核自己提交的变更');
            if (row.status !== 'pending') throw new Error('服务端校验：仅待审核中的变更可以审核');
          }
        }
      }
    }
  }
}

/** 写操作审计：操作人 + 动词 + 表落 app_logs（截断 SQL 防日志膨胀） */
function logGatewayWrite(operator, verb, table, sql) {
  try {
    const snippet = String(sql).replace(/\s+/g, ' ').slice(0, 160);
    db.prepare('INSERT INTO app_logs (level, category, source, message) VALUES (?, ?, ?, ?)')
      .run('info', 'gateway', operator, `写入 ${table} [${verb}] ${snippet}`);
  } catch { /* 审计失败不影响业务 */ }
}

/* ===================== 用户级令牌 =====================
 * 修复报告问题 #2：用户级 Token + 操作人身份透传
 *   - 客户端凭（邮箱 + 密码）换取 32 字节随机令牌
 *   - users.api_token 只存 SHA-256 哈希（泄露库文件也无法还原令牌），30 天有效；
 *     重新登录自动换新（即吊销旧令牌）
 *   - 每用户同时只有一个有效令牌 → 人员变动重新登录即失效
 */
const USER_TOKEN_TTL_MS = 30 * 24 * 3600 * 1000; // 30 天

/** 用户令牌哈希（api_token 列只存哈希，不存明文） */
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** 签发用户令牌：生成随机令牌，库中落哈希，返回明文给客户端 */
function issueUserToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + USER_TOKEN_TTL_MS;
  db.prepare('UPDATE users SET api_token = ?, api_token_expires = ? WHERE id = ?')
    .run(hashToken(token), expiresAt, userId);
  return { token, expiresAt };
}

/** 从请求头验证操作人身份；无效返回 null */
function getOperator(req) {
  const username = String(req.headers['x-user'] || '');
  const token = String(req.headers['x-user-token'] || '');
  if (!username || !token) return null;
  const row = db.prepare(`
    SELECT u.id, u.username, u.status, u.api_token, u.api_token_expires, r.name AS role_name
    FROM users u LEFT JOIN roles r ON u.role_id = r.id
    WHERE u.username = ?
  `).get(username);
  if (!row || row.status !== 'active') return null;
  /* 令牌只存 SHA-256 哈希：对请求令牌取哈希后与库中哈希恒定时间比较 */
  if (!row.api_token || row.api_token.length !== 64) return null;
  const providedHash = Buffer.from(crypto.createHash('sha256').update(token).digest('hex'), 'hex');
  const storedHash = Buffer.from(row.api_token, 'hex');
  if (providedHash.length !== storedHash.length || !crypto.timingSafeEqual(providedHash, storedHash)) return null;
  if (!row.api_token_expires || row.api_token_expires < Date.now()) return null;
  return { id: row.id, username: row.username, role: row.role_name };
}

/* ---------------- HTTP 工具 ---------------- */
const MAX_BODY = 32 * 1024 * 1024; // 32MB

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function checkAuth(req) {
  if (!TOKEN) return true;
  const header = req.headers['authorization'] || '';
  return header === `Bearer ${TOKEN}`;
}

/** 本机全部 IPv4 局域网地址（供成员填写连接） */
function getLanIps() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    /* 跳过常见虚拟网卡：WSL2、Docker、VMware、VirtualBox 等 */
    if (/^(WSL|vEthernet|Docker|vmware|VirtualBox|vboxnet|Hyper-V)/i.test(name)) continue;
    for (const it of ifs[name] || []) {
      if (it.family === 'IPv4' && !it.internal) out.push(it.address);
    }
  }
  return out;
}

/* ===================== 邮箱注册 / 登录 / 找回（辅助） ===================== */
const CODE_TTL_MS = 10 * 60 * 1000;       // 验证码 10 分钟有效
const CODE_SEND_COOLDOWN_MS = 60 * 1000;  // 同邮箱同用途 60 秒重发冷却
const CODE_MAX_ATTEMPTS = 5;              // 验证码错 5 次作废
const MIN_PASSWORD_LEN = 8;               // 密码最小长度（注册/重置/修改统一口径）
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;

/* 限流状态（内存态，重启即清零；验证码行自身带过期时间兜底）
 * 登录不设次数限制（按需求取消重试锁定） */
const codeSendAt = new Map();   // `${email}|${purpose}` -> lastSentAt
const limiterTimer = setInterval(() => {
  const now = Date.now();
  for (const [k, t] of codeSendAt) if (now - t > CODE_SEND_COOLDOWN_MS * 10) codeSendAt.delete(k);
}, 30 * 60 * 1000);
if (limiterTimer && limiterTimer.unref) limiterTimer.unref();

function sha256Hex(v) {
  return crypto.createHash('sha256').update(String(v)).digest('hex');
}

/** 恒定时间比较两个等长 hex 串（验证码/令牌哈希比对） */
function timingSafeHexEqual(aHex, bHex) {
  const a = Buffer.from(String(aHex || ''), 'hex');
  const b = Buffer.from(String(bHex || ''), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function normEmail(email) { return String(email || '').trim().toLowerCase(); }

function isEmail(email) {
  return typeof email === 'string' && email.length <= 254 && EMAIL_RE.test(email);
}

/** 可直接提示给客户端的错误（限流/验证码类文案） */
function clientError(msg) {
  return Object.assign(new Error(msg), { client: true });
}

function findUserByEmail(email) {
  return db.prepare(`
    SELECT u.*, r.name AS role_name
    FROM users u LEFT JOIN roles r ON u.role_id = r.id
    WHERE LOWER(u.email) = ?
  `).get(normEmail(email));
}

/** 登录/注册成功后返回给客户端的用户信息 */
function toAuthUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    name: row.display_name || row.username,
    email: row.email || '',
    department: row.department || '',
    project: row.project || '',
    module: row.module || '',
    role: row.role_name || '',
    isAdmin: row.role_name === '管理员',
    hasPassword: !!row.password_hash,
  };
}

/** 认证审计（注册/登录/重置/锁定全落 app_logs） */
function auditAuth(source, message) {
  try {
    db.prepare('INSERT INTO app_logs (level, category, source, message) VALUES (?, ?, ?, ?)')
      .run('info', 'auth', source, message);
  } catch { /* 审计失败不影响业务 */ }
}

/** 签发验证码：作废同用途旧码 → 落哈希 → 返回明文码（发送由调用方负责） */
function issueCode(email, purpose) {
  const key = `${email}|${purpose}`;
  const last = codeSendAt.get(key) || 0;
  const waitMs = CODE_SEND_COOLDOWN_MS - (Date.now() - last);
  if (waitMs > 0) throw clientError(`发送过于频繁，请 ${Math.ceil(waitMs / 1000)} 秒后再试`);
  /* 单邮箱单用途同时只有一个有效验证码 */
  db.prepare('DELETE FROM email_verifications WHERE email = ? AND purpose = ?').run(email, purpose);
  const code = String(crypto.randomInt(100000, 1000000));
  db.prepare(`INSERT INTO email_verifications (email, purpose, code_hash, expires_at, attempts, created_at)
              VALUES (?, ?, ?, ?, 0, ?)`)
    .run(email, purpose, sha256Hex(code), Date.now() + CODE_TTL_MS, Date.now());
  codeSendAt.set(key, Date.now());
  return code;
}

/** 校验并消费验证码；失败抛 clientError（文案可直接展示） */
function consumeCode(email, purpose, code) {
  const row = db.prepare(`SELECT * FROM email_verifications
    WHERE email = ? AND purpose = ? ORDER BY id DESC LIMIT 1`).get(email, purpose);
  if (!row || row.used_at) throw clientError('验证码无效，请重新获取');
  if (row.expires_at < Date.now()) throw clientError('验证码已过期，请重新获取');
  if (row.attempts >= CODE_MAX_ATTEMPTS) throw clientError('错误次数过多，请重新获取验证码');
  if (!timingSafeHexEqual(row.code_hash, sha256Hex(String(code || '').trim()))) {
    db.prepare('UPDATE email_verifications SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    const left = CODE_MAX_ATTEMPTS - row.attempts - 1;
    throw clientError(left > 0 ? `验证码错误，还可尝试 ${left} 次` : '验证码错误次数过多，请重新获取');
  }
  db.prepare('UPDATE email_verifications SET used_at = ? WHERE id = ?').run(Date.now(), row.id);
}

/* ===================== 本机管理台（/admin，仅服务器本机可访问） =====================
 * 浏览器打开 http://localhost:<端口>/admin 即可可视化管理：
 * 左侧为可折叠侧边导航（概览/用户/角色/邮件/备份/访问控制/数据库/日志，状态记忆在 localStorage），
 * 右侧展示对应页面。修改即时热生效并写回 server.config.json（端口与数据库路径需重启）。
 * 安全边界：按来源地址放行（127.0.0.1/::1），局域网其他机器返回 403；
 * 不设密码——能坐到服务器本机前的人即视为管理员（与控制台等同的信任级别）。
 */
function isLocalRequest(req) {
  const addr = String(req.socket.remoteAddress || '');
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/** 合并写入 server.config.json（管理台各保存按钮共用） */
function saveConfigPatch(patch) {
  for (const k of Object.keys(patch)) config[k] = patch[k];
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    return true;
  } catch (e) {
    logError(`配置写回失败: ${e.message}`);
    return false;
  }
}

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>团队服务器管理台</title>
<style>
* { box-sizing:border-box; margin:0; padding:0; }
  html, body { height:100%; }
  :root {
    --ink:#1c2537; --ink-2:#5d6880; --ink-3:#99a2b6;
    --line:#eceff5; --line-2:#f3f5f9;
    --ok:#0c8a5f; --ok-bg:#e4f6ee; --warn:#b45309; --warn-bg:#fdf3e1; --err:#d92d20;
  }
  :root, [data-theme="orange"] { --acc:#f97316; --acc2:#ea580c; --acc-rgb:249,115,22; --acc2-rgb:234,88,12; }
  [data-theme="blue"]   { --acc:#3b82f6; --acc2:#2563eb; --acc-rgb:59,130,246;  --acc2-rgb:37,99,235; }
  [data-theme="green"]  { --acc:#10b981; --acc2:#059669; --acc-rgb:16,185,129;  --acc2-rgb:5,150,105; }
  [data-theme="cyan"]   { --acc:#06b6d4; --acc2:#0891b2; --acc-rgb:6,182,212;   --acc2-rgb:8,145,178; }
  [data-theme="purple"] { --acc:#8b5cf6; --acc2:#7c3aed; --acc-rgb:139,92,246;  --acc2-rgb:124,58,237; }
  [data-theme="rose"]   { --acc:#f43f5e; --acc2:#e11d48; --acc-rgb:244,63,94;   --acc2-rgb:225,29,72; }
  body {
    background:#e8ecf2; color:var(--ink); position:relative;
    font:14px/1.65 "Segoe UI","Microsoft YaHei",system-ui,sans-serif;
    -webkit-font-smoothing:antialiased;
  }
  ::selection { background:rgba(var(--acc-rgb),.22); }
  ::-webkit-scrollbar { width:10px; height:10px; }
  ::-webkit-scrollbar-thumb { background:#d2d8e3; border-radius:8px; border:2px solid transparent; background-clip:content-box; }
  ::-webkit-scrollbar-thumb:hover { background:#bcc4d2; border:2px solid transparent; background-clip:content-box; }
  ::-webkit-scrollbar-track { background:transparent; }
  .bg-glow { position:fixed; inset:0; z-index:0; pointer-events:none;
    background:
      radial-gradient(720px 360px at 6% -10%, rgba(var(--acc-rgb),.16), transparent 62%),
      radial-gradient(880px 440px at 98% -12%, rgba(99,112,246,.10), transparent 65%),
      radial-gradient(760px 420px at 50% 118%, rgba(var(--acc-rgb),.08), transparent 60%); }
  /* ── 整体骨架：白色圆角工作台浮在浅灰桌面上 ── */
  .app { position:relative; z-index:1; display:flex; height:calc(100vh - 36px); margin:18px;
    border-radius:26px; overflow:hidden; background:#fff;
    box-shadow:0 2px 6px rgba(28,37,55,.05), 0 36px 90px -40px rgba(28,37,55,.38); }
  .sidebar { width:216px; flex:none; display:flex; flex-direction:column;
    background:#fbfcfe; border-right:1px solid var(--line); transition:width .22s ease; overflow:hidden; }
  body.side-collapsed .sidebar { width:64px; }
  .brand { display:flex; gap:12px; align-items:center; padding:20px 16px 16px; white-space:nowrap; }
  .logo { width:38px; height:38px; border-radius:12px; flex:none;
    background:linear-gradient(135deg,var(--acc),var(--acc2)); display:flex; align-items:center; justify-content:center;
    box-shadow:0 8px 18px -6px rgba(var(--acc2-rgb),.55); }
  .logo svg { width:21px; height:21px; }
  .brand-name { font-size:15px; font-weight:700; letter-spacing:.3px; }
  .brand-sub { font-size:11px; color:var(--ink-3); margin-top:1px; }
  body.side-collapsed .brand { justify-content:center; padding-left:0; padding-right:0; }
  body.side-collapsed .brand-text { display:none; }

  .side-nav { flex:1; display:flex; flex-direction:column; gap:4px; padding:10px;
    overflow-x:hidden; overflow-y:auto; }
  .nav-item { display:flex; align-items:center; gap:11px; width:100%; padding:9px 13px;
    border:none; border-radius:11px; background:transparent; color:var(--ink-2); cursor:pointer;
    font-family:inherit; font-size:13.5px; font-weight:500; text-align:left; white-space:nowrap;
    transition:background .15s, color .15s; }
  .nav-item svg { width:17px; height:17px; flex:none; opacity:.85; }
  .nav-item:hover { color:var(--ink); background:#f1f3f8; }
  .nav-item.active { color:var(--acc2); background:rgba(var(--acc-rgb),.12); font-weight:600; }
  .nav-item.active svg { opacity:1; }
  body.side-collapsed .nav-item { justify-content:center; padding:9px 0; }
  body.side-collapsed .nav-item span { display:none; }

  .side-foot { flex:none; padding:10px; border-top:1px solid var(--line); }
  .collapse-btn { display:flex; align-items:center; gap:9px; width:100%; padding:8px 11px;
    border:none; border-radius:10px; background:transparent; color:var(--ink-3); cursor:pointer;
    font-family:inherit; font-size:12.5px; white-space:nowrap; transition:.15s; }
  .collapse-btn:hover { color:var(--ink); background:#f1f3f8; }
  .collapse-btn svg { width:15px; height:15px; flex:none; transition:transform .22s; }
  body.side-collapsed .collapse-btn { justify-content:center; padding:8px 0; }
  body.side-collapsed .collapse-btn span { display:none; }
  body.side-collapsed .collapse-btn svg { transform:rotate(180deg); }

  /* ── 右侧主区 ── */
  .main { flex:1; min-width:0; display:flex; flex-direction:column; min-height:0; background:#f6f8fb; }
  .topbar { flex:none; display:flex; justify-content:space-between; align-items:center; gap:14px;
    padding:16px 26px; border-bottom:1px solid var(--line); background:rgba(255,255,255,.6); }
  .page-title { font-size:18px; font-weight:700; letter-spacing:.2px;
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .content { flex:1; overflow-y:auto; padding:22px 26px 46px; }
  .page { display:none; }
  .page.active { display:block; }

  .top-status { display:flex; gap:9px; align-items:center; font-size:12.5px; color:var(--ink-2);
    background:#fff; border:1px solid var(--line);
    padding:7px 15px; border-radius:999px; white-space:nowrap; box-shadow:0 1px 2px rgba(28,37,55,.04); }
  .top-right { display:flex; gap:10px; align-items:center; }
  .theme-dots { display:flex; gap:7px; align-items:center; background:#fff;
    border:1px solid var(--line); padding:8px 12px; border-radius:999px; box-shadow:0 1px 2px rgba(28,37,55,.04); }
  .tdot { width:16px; height:16px; border-radius:50%; border:2px solid transparent;
    background:var(--c); cursor:pointer; padding:0; transition:transform .15s, border-color .15s; }
  .tdot:hover { transform:scale(1.18); }
  .tdot.on { border-color:var(--ink); }

  .dot { width:8px; height:8px; border-radius:50%; display:inline-block; flex:none; }
  .dot.ok { background:#12b76a; box-shadow:0 0 0 3px rgba(18,183,106,.18); }
  .dot.warn { background:#f79009; box-shadow:0 0 0 3px rgba(247,144,9,.16); }
  .dot.err { background:#f04438; box-shadow:0 0 0 3px rgba(240,68,56,.15); }

  /* ── 指标卡：柔和主题色渐变 + 右上角箭头 ── */
  .stats { display:grid; grid-template-columns:repeat(4,1fr); gap:14px; margin-bottom:16px; }
  .stat { position:relative; border-radius:18px; padding:15px 18px 13px;
    background:linear-gradient(125deg, rgba(var(--acc-rgb),.16), rgba(var(--acc-rgb),.05) 48%, rgba(255,255,255,0)), #fff;
    border:1px solid rgba(var(--acc-rgb),.14);
    box-shadow:0 1px 2px rgba(28,37,55,.04), 0 14px 34px -22px rgba(28,37,55,.20);
    transition:transform .18s, box-shadow .18s; }
  .stat:hover { transform:translateY(-2px); box-shadow:0 2px 4px rgba(28,37,55,.05), 0 20px 40px -22px rgba(28,37,55,.28); }
  .stat::after { content:"↗"; position:absolute; top:12px; right:12px; width:26px; height:26px;
    border-radius:9px; background:rgba(255,255,255,.8); color:var(--acc2);
    display:grid; place-items:center; font-size:13px; font-weight:700;
    box-shadow:inset 0 0 0 1px rgba(var(--acc-rgb),.16); }
  .stat .num { font-size:23px; font-weight:700; display:flex; align-items:center; gap:9px;
    letter-spacing:.2px; padding-right:32px; }
  .stat .lbl { font-size:12px; color:var(--ink-2); margin-top:1px; }
  .stat .meta { font-size:11.5px; color:var(--ink-3); margin-top:4px; min-height:17px;
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }

  /* ── 卡片 ── */
  .card { background:#fff; border:1px solid var(--line); border-radius:18px; overflow:hidden;
    box-shadow:0 1px 2px rgba(28,37,55,.04), 0 18px 44px -30px rgba(28,37,55,.22); }
  .card + .card, .card + .ov-grid { margin-top:16px; }
  .card-head { display:flex; align-items:center; gap:9px; padding:15px 20px;
    border-bottom:1px solid var(--line-2); }
  .card-head svg { width:15px; height:15px; color:var(--acc2); flex:none; }
  .card-head h2 { font-size:13.5px; font-weight:600; letter-spacing:.3px; color:var(--ink); flex:1; }
  .head-pill { font-size:11.5px; padding:3px 12px; border-radius:999px; flex:none; font-weight:500; }
  .head-pill.ok { color:var(--ok); background:var(--ok-bg); }
  .head-pill.warn { color:var(--warn); background:var(--warn-bg); }
  .head-note { font-size:11.5px; color:var(--ink-3); flex:none; }
  .card-body { padding:18px 20px 16px; }

  /* 图例与活动趋势图 */
  .legend { display:flex; gap:14px; align-items:center; flex:none; }
  .lg { display:flex; gap:6px; align-items:center; font-size:11.5px; color:var(--ink-2); }
  .lg-dot { width:8px; height:8px; border-radius:50%; flex:none; }
  .lg-dot.all { background:var(--acc); }
  .lg-dot.auth { background:#12b76a; }
  .lg-dot.gateway { background:#5b8def; }
  .chart-wrap { position:relative; height:232px; cursor:crosshair; }
  .chart-wrap svg { display:block; }
  .chart-line { fill:none; stroke:var(--acc); stroke-width:2.5; stroke-linecap:round; stroke-linejoin:round; }
  .chart-area { fill:url(#actgrad); }
  .gstop-a { stop-color:rgba(var(--acc-rgb),.30); }
  .gstop-b { stop-color:rgba(var(--acc-rgb),0); }
  .chart-axis { fill:var(--ink-3); font-size:10.5px; font-family:inherit; }
  .chart-dot { fill:#fff; stroke:var(--acc); stroke-width:2.5; pointer-events:none; }
  .chart-tip { position:absolute; pointer-events:none; opacity:0; transition:opacity .12s;
    transform:translate(-50%,-100%); background:#fff; border:1px solid var(--line);
    border-radius:12px; padding:8px 12px; font-size:11.5px; color:var(--ink-2);
    box-shadow:0 12px 30px -12px rgba(28,37,55,.30); white-space:nowrap; z-index:3; }
  .chart-tip .tt-h { font-weight:600; color:var(--ink); margin-bottom:2px; }
  .chart-tip .tt-r { display:flex; gap:10px; }
  .chart-tip .tc-auth { color:var(--ok); }
  .chart-tip .tc-gw { color:#3565d8; }
  .chart-empty { position:absolute; inset:0; display:grid; place-items:center;
    color:var(--ink-3); font-size:12.5px; }

  /* 概览双栏 */
  .ov-grid { display:grid; grid-template-columns:1.45fr 1fr; gap:16px; margin-top:16px; }
  .ov-grid .card + .card { margin-top:0; }
  .recent { display:flex; flex-direction:column; }
  .act-row { display:flex; align-items:center; gap:12px; padding:8px 2px;
    border-bottom:1px solid var(--line-2); }
  .act-row.last { border-bottom:none; }
  .act-ico { width:34px; height:34px; border-radius:50%; flex:none; display:grid; place-items:center;
    font-size:12px; font-weight:600; }
  .act-ico.auth { color:var(--ok); background:var(--ok-bg); }
  .act-ico.gateway { color:#3565d8; background:#eaf1fe; }
  .act-main { flex:1; min-width:0; }
  .act-msg { display:block; font-size:12.5px; color:var(--ink); white-space:nowrap;
    overflow:hidden; text-overflow:ellipsis; }
  .act-sub { display:block; font-size:11px; color:var(--ink-3); margin-top:1px; }
  .act-time { flex:none; font-size:12px; color:var(--ink-2); }
  .link-btn { margin-left:auto; border:none; background:transparent; color:var(--acc2);
    font-family:inherit; font-size:12.5px; font-weight:600; cursor:pointer; padding:4px 8px;
    border-radius:8px; flex:none; transition:background .15s; }
  .link-btn:hover { background:rgba(var(--acc-rgb),.09); }
  .recent-empty { color:var(--ink-3); font-size:12.5px; padding:14px 2px; }

  /* ── 表单 ── */
  .form-row { display:flex; align-items:center; gap:10px; margin-bottom:12px; }
  .form-row > label { width:88px; flex:none; font-size:13px; color:var(--ink-2); }
  .form-row input[type=text], .form-row input[type=password], .form-row input[type=number], .inline-input {
    flex:1; min-width:0; background:#f6f8fb; border:1px solid #e3e8f0; color:var(--ink);
    border-radius:11px; padding:9px 13px; font-size:13px; transition:border-color .15s, box-shadow .15s, background .15s; }
  .form-row input:focus, .inline-input:focus { outline:none; background:#fff; border-color:rgba(var(--acc-rgb),.65);
    box-shadow:0 0 0 3.5px rgba(var(--acc-rgb),.14); }
  .form-row input::placeholder, .inline-input::placeholder { color:#a6aebf; }
  .form-note { font-size:12px; color:var(--ink-3); }
  .row2 { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
  .row2 .form-row { margin-bottom:12px; }
  .row2 .form-row > label { width:auto; }

  /* 开关 */
  .switch { position:relative; display:inline-block; width:42px; height:23px; flex:none; }
  .switch input { opacity:0; width:0; height:0; }
  .track { position:absolute; inset:0; background:#dde2ec; border-radius:999px;
    transition:.18s; cursor:pointer; }
  .track::after { content:""; position:absolute; width:17px; height:17px; border-radius:50%;
    background:#fff; top:3px; left:3px; transition:.18s; box-shadow:0 1px 3px rgba(28,37,55,.25); }
  .switch input:checked + .track { background:linear-gradient(135deg,var(--acc),var(--acc2)); }
  .switch input:checked + .track::after { transform:translateX(19px); }

  /* 按钮 */
  .btn { border:none; border-radius:999px; padding:9px 19px; font-size:13px; font-weight:600;
    font-family:inherit; cursor:pointer; transition:filter .15s, border-color .15s, color .15s; }
  .btn.primary { background:linear-gradient(135deg,var(--acc),var(--acc2)); color:#fff;
    box-shadow:0 8px 18px -8px rgba(var(--acc2-rgb),.65); }
  .btn.primary:hover { filter:brightness(1.06); }
  .btn.ghost { background:#fff; color:var(--ink-2); border:1px solid #e3e8f0; font-weight:500;
    box-shadow:0 1px 2px rgba(28,37,55,.04); }
  .btn.ghost:hover { border-color:rgba(var(--acc-rgb),.55); color:var(--acc2); }
  .btn:disabled { opacity:.45; cursor:not-allowed; }
  .actions { display:flex; gap:10px; align-items:center; margin-top:6px; flex-wrap:wrap; }
  .test-group { display:flex; gap:8px; align-items:center; margin-left:auto; }
  .inline-input { width:225px; flex:none; }

  /* 信息行 */
  .kv { display:flex; justify-content:space-between; gap:12px; padding:7px 0;
    font-size:13px; border-bottom:1px dashed var(--line); }
  .kv:last-child { border-bottom:none; }
  .kv .k { color:var(--ink-3); flex:none; }
  .kv .v { text-align:right; word-break:break-all; }
  .kv .v .meta { color:var(--ink-3); font-size:11.5px; }

  .note { font-size:12px; margin-top:12px; padding:10px 14px; border-radius:12px; line-height:1.6; }
  .note.warn { color:var(--warn); background:var(--warn-bg); border:1px solid #f5e3bb; }
  .result { font-size:12.5px; margin-top:10px; min-height:19px; }
  .ok { color:var(--ok); } .warn { color:var(--warn); } .err { color:var(--err); }
  .hint { font-size:12px; color:var(--ink-3); }

  /* 日志 */
  .filters { display:flex; gap:6px; align-items:center; margin-left:auto; }
  .filters button { background:#fff; border:1px solid #e3e8f0; color:var(--ink-2);
    border-radius:999px; padding:3px 13px; font-size:12px; cursor:pointer; transition:.15s; font-family:inherit; }
  .filters button.on { color:var(--acc2); border-color:rgba(var(--acc-rgb),.55); background:rgba(var(--acc-rgb),.09); }

  /* 用户与管理员 */
  .utable { width:100%; border-collapse:collapse; font-size:12.5px; }
  .utable th { text-align:left; color:var(--ink-3); font-weight:500; padding:7px 10px;
    border-bottom:1px solid var(--line); white-space:nowrap; }
  .utable td { padding:8px 10px; border-bottom:1px solid var(--line-2); white-space:nowrap; }
  .utable tr:last-child td { border-bottom:none; }
  .utable .u-mail { color:var(--ink-2); font-size:12px; }
  .utable select, .utable .mini-btn { background:#fff; border:1px solid #e3e8f0;
    color:var(--ink-2); border-radius:8px; padding:3px 10px; font-size:12px; cursor:pointer; font-family:inherit; }
  .utable .mini-btn:hover { border-color:rgba(var(--acc-rgb),.55); color:var(--acc2); }
  .utable .st { font-size:11.5px; }
  .utable .st.active { color:var(--ok); background:var(--ok-bg); border-color:#bfe7d2; }
  .utable .st.locked { color:var(--err); background:#feeceb; border-color:#f6c9c5; }
  .create-box { background:#f8fafc; border:1px solid var(--line); border-radius:14px;
    padding:13px 15px; margin-bottom:14px; }
  .create-title { font-size:12px; color:var(--ink-2); margin-bottom:10px; }
  .create-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .create-row .inline-input { flex:1; min-width:150px; background:#fff; }
  .utable .u-online { font-size:11.5px; }
  .utable .u-online.ok { color:var(--ok); }
  .utable .u-online.off { color:var(--ink-3); }
  .dbstats { display:grid; grid-template-columns:repeat(auto-fill, minmax(150px, 1fr)); gap:8px; }
  .dbstat { background:#f8fafc; border:1px solid var(--line); border-radius:12px; padding:9px 13px; }
  .dbstat .n { font-size:16px; font-weight:700; }
  .dbstat .l { font-size:11.5px; color:var(--ink-3); }
  .perm-table th, .perm-table td { text-align:center; }
  .perm-table td:first-child, .perm-table th:first-child { text-align:left; }
  .perm-table .meta { font-size:10.5px; color:var(--ink-3); font-weight:400; }
  .perm-table input[type=checkbox] { accent-color:var(--acc); cursor:pointer; }
  .perm-table input[type=checkbox]:disabled { cursor:not-allowed; opacity:.55; }
  .bk-list { font-family:Consolas,"Courier New",monospace; font-size:12px; }
  .bk-list div { display:flex; justify-content:space-between; gap:12px; padding:5px 0;
    border-bottom:1px solid var(--line-2); }
  .bk-list div:last-child { border-bottom:none; }
  .bk-list .t { color:var(--ink-3); flex:none; }
  .log { font-family:Consolas,"Courier New",monospace; font-size:12px; max-height:300px; overflow:auto;
    background:#f8fafc; border-radius:12px; padding:6px 14px; border:1px solid var(--line); }
  .log div { display:flex; gap:10px; padding:7px 0; border-bottom:1px solid var(--line-2); align-items:baseline; }
  .log div:last-child { border-bottom:none; }
  .log .t { color:var(--ink-3); flex:none; }
  .log .c { flex:none; font-size:11px; padding:0 9px; border-radius:999px; font-family:"Segoe UI","Microsoft YaHei",sans-serif; }
  .log .c.auth { color:var(--ok); background:var(--ok-bg); }
  .log .c.gateway { color:#3565d8; background:#eaf1fe; }
  .log .m { color:#414b60; word-break:break-all; }

  .toast { position:fixed; bottom:26px; left:50%; transform:translate(-50%,20px); opacity:0;
    background:#fff; border:1px solid var(--line); border-left:3px solid #12b76a; color:var(--ink);
    padding:11px 22px; border-radius:12px; font-size:13px; transition:.25s; pointer-events:none;
    max-width:70vw; box-shadow:0 18px 44px -14px rgba(28,37,55,.35); z-index:10; }
  .toast.show { opacity:1; transform:translate(-50%,0); }
  .toast.err { border-left-color:var(--err); }

  /* 窄屏：导航自动收成图标栏 */
  @media (max-width:900px) {
    .ov-grid { grid-template-columns:1fr; }
  }
  @media (max-width:760px) {
    .app { margin:10px; height:calc(100vh - 20px); border-radius:18px; }
    .sidebar { width:64px; }
    .brand { justify-content:center; padding-left:0; padding-right:0; }
    .brand-text { display:none; }
    .nav-item { justify-content:center; padding:9px 0; }
    .nav-item span { display:none; }
    .collapse-btn { justify-content:center; padding:8px 0; }
    .collapse-btn span { display:none; }
    .topbar { padding:12px 14px; }
    .content { padding:16px 14px 40px; }
    .stats { grid-template-columns:repeat(2,1fr); }
    .chart-wrap { height:190px; }
  }
  </style>
</head>
<body>
<div class="bg-glow"></div>
<div class="app">
  <aside class="sidebar">
    <div class="brand">
      <div class="logo">
        <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 16h4l3-8 3 8h2"/><path d="M18 16h2"/></svg>
      </div>
      <div class="brand-text">
        <div class="brand-name">团队服务器管理台</div>
        <div class="brand-sub">仅限服务器本机访问</div>
      </div>
    </div>
    <nav class="side-nav">
      <button class="nav-item active" data-page="overview" title="概览" onclick="showPage('overview')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg><span>概览</span></button>
      <button class="nav-item" data-page="users" title="用户管理" onclick="showPage('users')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg><span>用户管理</span></button>
      <button class="nav-item" data-page="roles" title="角色权限" onclick="showPage('roles')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg><span>角色权限</span></button>
      <button class="nav-item" data-page="mail" title="邮件服务" onclick="showPage('mail')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="3"/><path d="m2 7 10 6 10-6"/></svg><span>邮件服务</span></button>
      <button class="nav-item" data-page="backup" title="定时备份" onclick="showPage('backup')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/></svg><span>定时备份</span></button>
      <button class="nav-item" data-page="security" title="访问控制" onclick="showPage('security')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m21 2-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8zm0 0L15 8m-3.6 3.6L19 4"/></svg><span>访问控制</span></button>
      <button class="nav-item" data-page="database" title="数据库" onclick="showPage('database')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg><span>数据库</span></button>
      <button class="nav-item" data-page="logs" title="审计日志" onclick="showPage('logs')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/></svg><span>审计日志</span></button>
    </nav>
    <div class="side-foot">
      <button class="collapse-btn" id="collapse_btn" title="折叠 / 展开导航" onclick="toggleSide()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
        <span>收起导航</span>
      </button>
    </div>
  </aside>

  <main class="main">
    <header class="topbar">
      <div class="page-title" id="page_title">概览</div>
      <div class="top-right">
        <div class="theme-dots" title="主题色">
          <button class="tdot on" data-t="orange" style="--c:#f97316" onclick="setTheme('orange')" aria-label="橙色主题"></button>
          <button class="tdot" data-t="blue" style="--c:#3b82f6" onclick="setTheme('blue')" aria-label="蓝色主题"></button>
          <button class="tdot" data-t="green" style="--c:#10b981" onclick="setTheme('green')" aria-label="绿色主题"></button>
          <button class="tdot" data-t="cyan" style="--c:#06b6d4" onclick="setTheme('cyan')" aria-label="青色主题"></button>
          <button class="tdot" data-t="purple" style="--c:#8b5cf6" onclick="setTheme('purple')" aria-label="紫色主题"></button>
          <button class="tdot" data-t="rose" style="--c:#f43f5e" onclick="setTheme('rose')" aria-label="玫红主题"></button>
        </div>
        <div class="top-status" id="top_status"><span class="dot ok"></span>连接中…</div>
      </div>
    </header>

    <div class="content">
            <section class="page active" data-page="overview">
        <div class="stats">
          <div class="stat" id="stat_users"><div class="num">—</div><div class="lbl">注册用户</div><div class="meta"></div></div>
          <div class="stat" id="stat_online"><div class="num">—</div><div class="lbl">在线成员</div><div class="meta"></div></div>
          <div class="stat" id="stat_mail"><div class="num">—</div><div class="lbl">邮件服务</div><div class="meta"></div></div>
          <div class="stat" id="stat_backup"><div class="num">—</div><div class="lbl">定时备份</div><div class="meta"></div></div>
        </div>
        <section class="card">
          <div class="card-head">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 15l5-5 4 4 7-8"/></svg>
            <h2>活动趋势</h2>
            <div class="legend">
              <span class="lg"><i class="lg-dot all"></i>全部</span>
              <span class="lg"><i class="lg-dot auth"></i>认证</span>
              <span class="lg"><i class="lg-dot gateway"></i>网关</span>
            </div>
            <span class="head-note">近 12 小时</span>
          </div>
          <div class="card-body">
            <div class="chart-wrap" id="chart_wrap">
              <div class="chart-tip" id="chart_tip"></div>
            </div>
          </div>
        </section>
        <div class="ov-grid">
          <section class="card">
            <div class="card-head">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="8" rx="2"/><rect x="2" y="13" width="20" height="8" rx="2"/><path d="M6 7h.01M6 17h.01"/></svg>
              <h2>服务器</h2>
            </div>
            <div class="card-body"><div id="server_info">加载中…</div></div>
          </section>
          <section class="card">
            <div class="card-head">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/></svg>
              <h2>最近动态</h2>
              <button class="link-btn" onclick="showPage('logs')">查看全部 →</button>
            </div>
            <div class="card-body"><div id="recent_list" class="recent">加载中…</div></div>
          </section>
        </div>
      </section>

      <section class="page" data-page="users">
        <section class="card">
          <div class="card-head">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            <h2>用户与管理员</h2>
            <span class="head-pill warn" id="users_pill">—</span>
          </div>
          <div class="card-body">
            <div id="no_admin_box" class="note warn" style="display:none">
              尚无可登录管理员：此时任何人注册都会自动成为管理员。建议在下方直接创建管理员账号——创建后新注册者将默认为工程师角色。
            </div>
            <div class="create-box">
              <div class="create-title">直接创建账号（管理台可信操作，免邮箱验证；请确认邮箱拼写正确，创建后即可用邮箱 + 密码登录）</div>
              <div class="create-row">
                <input id="c_email" class="inline-input" type="text" placeholder="邮箱">
                <input id="c_password" class="inline-input" type="password" placeholder="密码（至少 8 位）">
                <input id="c_name" class="inline-input" type="text" placeholder="显示名（选填）">
                <select id="c_role" class="inline-input" style="flex:none;width:104px">
                  <option value="管理员">管理员</option>
                  <option value="工程师">工程师</option>
                </select>
                <button class="btn primary" id="c_save" onclick="createUser()">创建账号</button>
              </div>
            </div>
            <div id="user_table_wrap" class="log" style="max-height:300px">加载中…</div>
          </div>
        </section>
      </section>

      <section class="page" data-page="roles">
        <section class="card">
          <div class="card-head">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
            <h2>角色与权限</h2>
            <span class="head-pill ok" id="roles_pill">—</span>
          </div>
          <div class="card-body">
            <div class="create-box">
              <div class="create-title">新建角色（创建后可在下方权限矩阵中勾选其在客户端可见的功能）</div>
              <div class="create-row">
                <input id="r_name" class="inline-input" type="text" placeholder="角色名称（如：审核员）">
                <input id="r_desc" class="inline-input" type="text" placeholder="角色描述（选填）">
                <button class="btn primary" id="r_save" onclick="createRole()">新建角色</button>
              </div>
            </div>
            <div id="roles_wrap" style="margin-bottom:16px">加载中…</div>
            <div class="create-title" style="margin-bottom:8px">权限矩阵（管理员始终拥有全部权限；勾选决定各角色在客户端可见的功能）</div>
            <div id="perm_wrap" class="log" style="max-height:320px">加载中…</div>
          </div>
        </section>
      </section>

      <section class="page" data-page="mail">
        <section class="card">
          <div class="card-head">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="3"/><path d="m2 7 10 6 10-6"/></svg>
            <h2>邮件配置</h2>
            <span class="head-pill warn" id="mail_pill">—</span>
          </div>
          <div class="card-body">
            <div class="form-row">
              <label>启用发信</label>
              <label class="switch"><input type="checkbox" id="m_enabled"><span class="track"></span></label>
              <span class="form-note">关闭时验证码打印在服务器控制台兜底</span>
            </div>
            <div class="form-row"><label>SMTP 服务器</label><input id="m_host" type="text" placeholder="如 smtp.qq.com / smtp.exmail.qq.com"></div>
            <div class="row2">
              <div class="form-row"><label>端口</label><input id="m_port" type="number" value="465"></div>
              <div class="form-row"><label>加密方式</label><select id="m_secure" class="inline-input" style="flex:1"><option value="ssl">SSL/TLS（端口 465）</option><option value="starttls">STARTTLS（端口 587）</option></select></div>
            </div>
            <div class="form-row"><label>发件账号</label><input id="m_user" type="text" placeholder="发件邮箱地址"></div>
            <div class="form-row"><label>密码/授权码</label><input id="m_pass" type="password" placeholder="留空 = 保持已保存的密码不变"></div>
            <div class="form-row"><label>发件人显示</label><input id="m_from" type="text" placeholder="留空 = 使用发件账号"></div>
            <div class="actions">
              <button class="btn primary" id="mail_save" onclick="saveMail()">保存配置</button>
              <div class="test-group">
                <input id="test_to" class="inline-input" type="text" placeholder="测试收件邮箱">
                <button class="btn ghost" id="mail_test" onclick="sendTest()">发送测试邮件</button>
              </div>
            </div>
            <div id="mail_result" class="result"></div>
          </div>
        </section>
      </section>

      <section class="page" data-page="backup">
        <section class="card">
          <div class="card-head">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/></svg>
            <h2>定时备份</h2>
            <span class="head-pill warn" id="backup_pill">—</span>
          </div>
          <div class="card-body">
            <div class="form-row">
              <label>启用</label>
              <label class="switch"><input type="checkbox" id="b_enabled"><span class="track"></span></label>
            </div>
            <div class="row2">
              <div class="form-row"><label>间隔（小时）</label><input id="b_hours" type="number" min="1"></div>
              <div class="form-row"><label>保留份数</label><input id="b_keep" type="number" min="1"></div>
            </div>
            <div class="actions">
              <button class="btn primary" id="bk_save" onclick="saveBackup()">保存设置</button>
              <button class="btn ghost" id="bk_run" onclick="runBackupNow()">立即备份</button>
            </div>
            <div id="bk_result" class="result"></div>
          </div>
        </section>
      </section>

      <section class="page" data-page="security">
        <section class="card">
          <div class="card-head">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8zm0 0L15 8m-3.6 3.6L19 4"/></svg>
            <h2>团队访问 Token</h2>
            <span class="head-pill warn" id="token_pill">—</span>
          </div>
          <div class="card-body">
            <div class="form-row"><label>Token</label><input id="token" type="text" placeholder="留空 = 不鉴权（仅建议纯内网）"></div>
            <div class="actions"><button class="btn primary" id="token_save" onclick="saveToken()">保存 Token</button></div>
            <div class="note warn">修改后所有成员需在客户端「数据库连接」中同步更新同一 Token，否则将无法连接服务器。</div>
          </div>
        </section>
      </section>

      <section class="page" data-page="database">
        <section class="card">
          <div class="card-head">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
            <h2>数据库</h2>
            <span class="head-pill ok" id="db_pill">—</span>
          </div>
          <div class="card-body">
            <div class="actions" style="margin:0 0 12px">
              <button class="btn ghost" id="integrity_btn" onclick="checkIntegrity()">完整性检查</button>
              <span id="integrity_result" class="result" style="margin:0"></span>
              <span class="hint" id="dbsize_text" style="margin:0 0 0 auto"></span>
            </div>
            <div class="dbstats" id="db_stats">加载中…</div>
            <div class="create-title" style="margin:14px 0 8px">备份历史（在线恢复有损坏风险，请停服后用备份文件替换数据库文件再启动）</div>
            <div id="bk_history" class="log bk-list" style="max-height:200px">加载中…</div>
          </div>
        </section>
      </section>

      <section class="page" data-page="logs">
        <section class="card">
          <div class="card-head">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/></svg>
            <h2>审计日志</h2>
            <div class="filters">
              <button id="f_all" class="on" onclick="setFilter('all', this)">全部</button>
              <button id="f_auth" onclick="setFilter('auth', this)">认证</button>
              <button id="f_gateway" onclick="setFilter('gateway', this)">网关</button>
              <button class="ghost" onclick="loadLogs()" style="border:none">刷新</button>
            </div>
          </div>
          <div class="card-body"><div id="logs" class="log">加载中…</div></div>
        </section>
      </section>
    </div>
  </main>
</div>
<div class="toast" id="toast"></div>
<script>
var logFilter = 'all';
var logRows = [];

function toast(msg, isErr) {
  var el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(el._timer);
  el._timer = setTimeout(function () { el.className = 'toast'; }, 3200);
}

async function api(path, body) {
  var opt = body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : {};
  var res = await fetch(path, opt);
  return res.json();
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function loadStatus() {
  try {
    var r = await api('/admin/api/status');
    if (!r.success) throw new Error(r.error || '加载失败');

    document.getElementById('top_status').innerHTML =
      '<span class="dot ok"></span>服务运行中 · ' + esc(r.uptimeText);

    document.getElementById('stat_users').innerHTML =
      '<div class="num">' + esc(r.users.active) + '</div><div class="lbl">注册用户</div>' +
      '<div class="meta">管理员 ' + esc(r.users.loginableAdmins) + ' 人' +
      (r.users.loginableAdmins === 0 ? ' · 首位注册者将自动成为管理员' : '') + '</div>';

    document.getElementById('stat_online').innerHTML =
      '<div class="num">' + esc(r.online.count) + '</div><div class="lbl">在线成员</div>' +
      '<div class="meta">' + (r.online.names.length ? esc(r.online.names.join('、')) : '暂无') + '</div>';

    document.getElementById('stat_mail').innerHTML =
      '<div class="num"><span class="dot ' + (r.mail.enabled ? 'ok' : 'warn') + '"></span>' +
      (r.mail.enabled ? '已启用' : '未配置') + '</div><div class="lbl">邮件服务</div>' +
      '<div class="meta">' + (r.mail.enabled ? esc(r.mail.host) : '验证码打印在服务器控制台') + '</div>';

    var bk = r.backup.last;
    document.getElementById('stat_backup').innerHTML =
      '<div class="num"><span class="dot ' + (r.backup.enabled ? 'ok' : 'warn') + '"></span>' +
      (r.backup.enabled ? esc(r.backup.intervalHours) + 'h' : '已停用') + '</div><div class="lbl">定时备份</div>' +
      '<div class="meta">' + (bk ? '最近 ' + esc(bk.time) : '暂无备份') + '</div>';

    document.getElementById('server_info').innerHTML = ''
      + '<div class="kv"><span class="k">服务地址</span><span class="v">http://localhost:' + esc(r.port) + ' <span class="meta">(重启修改)</span></span></div>'
      + '<div class="kv"><span class="k">数据库</span><span class="v">' + esc(r.dbPath) + '</span></div>'
      + '<div class="kv"><span class="k">驱动</span><span class="v">' + esc(r.driver) + '</span></div>'
      + '<div class="kv"><span class="k">团队 Token</span><span class="v ' + (r.tokenSet ? 'ok' : 'warn') + '">' + (r.tokenSet ? '已启用' : '未启用') + '</span></div>';

    setPill('mail_pill', r.mail.enabled, r.mail.enabled ? '已启用' : '未配置');
    setPill('token_pill', r.tokenSet, r.tokenSet ? '已启用' : '未启用');
    setPill('backup_pill', r.backup.enabled, r.backup.enabled ? r.backup.intervalHours + 'h' : '已停用');

    document.getElementById('m_enabled').checked = r.mail.enabled;
    document.getElementById('m_host').value = r.mail.host;
    document.getElementById('m_port').value = r.mail.port;
    document.getElementById('m_secure').value = r.mail.secure ? 'ssl' : 'starttls';
    document.getElementById('m_user').value = r.mail.user;
    document.getElementById('m_from').value = r.mail.from;
    document.getElementById('m_pass').placeholder = r.mail.passSet ? '已保存（留空则不修改）' : 'SMTP 授权码/密码';
    document.getElementById('token').placeholder = r.tokenSet ? '已设置（输入新值可更换）' : '留空 = 不鉴权（仅建议纯内网）';
    document.getElementById('b_enabled').checked = r.backup.enabled;
    document.getElementById('b_hours').value = r.backup.intervalHours;
    document.getElementById('b_keep').value = r.backup.keep;
  } catch (e) {
    document.getElementById('server_info').innerHTML = '<span class="err">加载失败：' + esc(e.message) + '</span>';
  }
}

function setPill(id, ok, text) {
  var el = document.getElementById(id);
  el.className = 'head-pill ' + (ok ? 'ok' : 'warn');
  el.textContent = text;
}

async function loadLogs() {
  try {
    var r = await api('/admin/api/logs');
    if (!r.success) throw new Error(r.error || '加载失败');
    logRows = r.rows || [];
    renderLogs();
  } catch (e) {
    document.getElementById('logs').innerHTML = '<span class="err">' + esc(e.message) + '</span>';
  }
}

function renderLogs() {
  var el = document.getElementById('logs');
  var rows = logRows.filter(function (x) { return logFilter === 'all' || x.category === logFilter; });
  if (!rows.length) { el.innerHTML = '<span class="err">暂无记录</span>'; return; }
  el.innerHTML = rows.map(function (x) {
    return '<div><span class="t">' + esc(x.created_at) + '</span><span class="c ' + esc(x.category) + '">' +
      (x.category === 'auth' ? '认证' : '网关') + '</span><span class="m">' +
      esc(x.source) + ' · ' + esc(x.message) + '</span></div>';
  }).join('');
}

function setFilter(f, btn) {
  logFilter = f;
  var btns = document.querySelectorAll('.filters button');
  for (var i = 0; i < btns.length; i++) btns[i].className = btns[i] === btn ? 'on' : '';
  renderLogs();
}

async function saveMail() {
  var btn = document.getElementById('mail_save');
  btn.disabled = true;
  try {
    var r = await api('/admin/api/mail', {
      enabled: document.getElementById('m_enabled').checked,
      host: document.getElementById('m_host').value.trim(),
      port: document.getElementById('m_port').value,
      secure: document.getElementById('m_secure').value,
      user: document.getElementById('m_user').value.trim(),
      pass: document.getElementById('m_pass').value,
      from: document.getElementById('m_from').value.trim(),
    });
    var res = document.getElementById('mail_result');
    res.textContent = r.success ? '已保存并即时生效。' : ('保存失败：' + (r.error || ''));
    res.className = 'result ' + (r.success ? 'ok' : 'err');
    if (r.success) { document.getElementById('m_pass').value = ''; toast('邮件配置已保存'); loadStatus(); }
    else toast(r.error || '保存失败', true);
  } finally { btn.disabled = false; }
}

async function sendTest() {
  var btn = document.getElementById('mail_test');
  var to = document.getElementById('test_to').value.trim();
  if (!to) { toast('请填写测试收件邮箱', true); return; }
  btn.disabled = true;
  var res = document.getElementById('mail_result');
  res.textContent = '发送中…';
  res.className = 'result';
  try {
    var r = await api('/admin/api/mail/test', { to: to });
    res.textContent = r.success ? '测试邮件已发送，请查收（若未收到请检查垃圾箱/授权码）。' : ('发送失败：' + (r.error || ''));
    res.className = 'result ' + (r.success ? 'ok' : 'err');
  } finally { btn.disabled = false; }
}

async function saveToken() {
  var btn = document.getElementById('token_save');
  btn.disabled = true;
  try {
    var r = await api('/admin/api/token', { token: document.getElementById('token').value.trim() });
    if (r.success) { toast('Token 已保存并即时生效'); document.getElementById('token').value = ''; loadStatus(); }
    else toast(r.error || '保存失败', true);
  } finally { btn.disabled = false; }
}

async function saveBackup() {
  var btn = document.getElementById('bk_save');
  btn.disabled = true;
  try {
    var r = await api('/admin/api/backup', {
      enabled: document.getElementById('b_enabled').checked,
      intervalHours: document.getElementById('b_hours').value,
      keep: document.getElementById('b_keep').value,
    });
    if (r.success) { toast('备份设置已保存并即时生效'); loadStatus(); }
    else toast(r.error || '保存失败', true);
  } finally { btn.disabled = false; }
}

async function runBackupNow() {
  var btn = document.getElementById('bk_run');
  btn.disabled = true;
  try {
    var r = await api('/admin/api/backup/run', {});
    var res = document.getElementById('bk_result');
    res.textContent = r.success ? '备份完成。' : ('备份失败：' + (r.error || ''));
    res.className = 'result ' + (r.success ? 'ok' : 'err');
    loadStatus();
  } finally { btn.disabled = false; }
}

async function loadUsers() {
  try {
    var r = await api('/admin/api/users');
    if (!r.success) throw new Error(r.error || '加载失败');
    setPill('users_pill', r.loginableAdmins > 0, '可登录管理员 ' + r.loginableAdmins + ' 人');
    document.getElementById('no_admin_box').style.display = r.loginableAdmins === 0 ? '' : 'none';
    document.getElementById('c_role').value = r.loginableAdmins === 0 ? '管理员' : '工程师';
    var rows = r.rows || [];
    var html = '<table class="utable"><thead><tr><th>用户</th><th>邮箱</th><th>部门</th><th>角色</th><th>状态</th><th>在线</th><th>最后登录</th><th>操作</th></tr></thead><tbody>';
    var deptList = [];
    for (var d = 0; d < rows.length; d++) {
      if (rows[d].department && deptList.indexOf(rows[d].department) === -1) deptList.push(rows[d].department);
    }
    for (var i = 0; i < rows.length; i++) {
      var u = rows[i];
      html += '<tr>'
        + '<td>' + esc(u.display_name || u.username) + '</td>'
        + '<td class="u-mail">' + esc(u.email || '—') + '</td>'
        + '<td><select onchange="changeDept(' + u.id + ', this.value)">'
        + '<option value=""' + (!u.department ? ' selected' : '') + '>— 未分配 —</option>'
        + deptList.map(function (dp) {
          return '<option value="' + esc(dp) + '"' + (u.department === dp ? ' selected' : '') + '>' + esc(dp) + '</option>';
        }).join('')
        + '</select></td>'
        + '<td><select onchange="changeRole(' + u.id + ', this.value)">'
        + '<option value="管理员"' + (u.role_name === '管理员' ? ' selected' : '') + '>管理员</option>'
        + '<option value="工程师"' + (u.role_name === '工程师' ? ' selected' : '') + '>工程师</option>'
        + '</select></td>'
        + '<td><button class="mini-btn st ' + (u.status === 'active' ? 'active' : 'locked') + '" data-id="' + u.id + '" data-next="' + (u.status === 'active' ? 'locked' : 'active') + '" onclick="toggleStatus(Number(this.dataset.id), this.dataset.next)">' + (u.status === 'active' ? '启用中' : '已停用') + '</button></td>'
        + '<td><span class="u-online ' + (u.online ? 'ok' : 'off') + '">' + (u.online ? '● 在线' : '○ 离线') + '</span></td>'
        + '<td class="u-mail">' + esc(u.last_login || '—') + '</td>'
        + '<td><button class="mini-btn" onclick="sendResetCode(' + u.id + ')">发重置码</button> <button class="mini-btn" data-id="' + u.id + '" data-name="' + esc(u.display_name || u.username) + '" onclick="deleteUser(Number(this.dataset.id), this.dataset.name)">删除</button></td>'
        + '</tr>';
    }
    html += '</tbody></table>';
    document.getElementById('user_table_wrap').innerHTML = rows.length ? html : '暂无用户——在上方创建第一个账号，或在客户端自行注册';
  } catch (e) {
    document.getElementById('user_table_wrap').innerHTML = '<span class="err">' + esc(e.message) + '</span>';
  }
}

async function createUser() {
  var btn = document.getElementById('c_save');
  btn.disabled = true;
  try {
    var r = await api('/admin/api/users/create', {
      email: document.getElementById('c_email').value.trim(),
      password: document.getElementById('c_password').value,
      displayName: document.getElementById('c_name').value.trim(),
      role: document.getElementById('c_role').value,
    });
    if (r.success) {
      toast('账号已创建，可用邮箱 + 密码直接登录');
      document.getElementById('c_email').value = '';
      document.getElementById('c_password').value = '';
      document.getElementById('c_name').value = '';
      loadUsers();
      loadStatus();
    } else toast(r.error || '创建失败', true);
  } finally { btn.disabled = false; }
}

async function changeRole(id, role) {
  var r = await api('/admin/api/users/role', { id: id, role: role });
  if (r.success) { toast('角色已更新为' + role); loadUsers(); loadStatus(); }
  else { toast(r.error || '操作失败', true); loadUsers(); }
}

async function toggleStatus(id, status) {
  var r = await api('/admin/api/users/status', { id: id, status: status });
  if (r.success) { toast(status === 'active' ? '账号已启用' : '账号已停用（令牌已吊销）'); loadUsers(); loadStatus(); }
  else { toast(r.error || '操作失败', true); loadUsers(); }
}

async function sendResetCode(id) {
  var r = await api('/admin/api/users/reset-code', { id: id });
  if (r.success) toast('重置验证码已发送至该用户邮箱');
  else toast(r.error || '发送失败', true);
}

async function changeDept(id, dept) {
  var r = await api('/admin/api/users/dept', { id: id, department: dept });
  if (r.success) toast('部门已更新');
  else { toast(r.error || '操作失败', true); loadUsers(); }
}

async function deleteUser(id, name) {
  if (!confirm('确定删除账号「' + name + '」？该操作不可恢复（历史审计记录中仍会保留其用户名显示）。')) return;
  var r = await api('/admin/api/users/delete', { id: id });
  if (r.success) { toast('账号已删除'); loadUsers(); loadStatus(); }
  else { toast(r.error || '删除失败', true); loadUsers(); }
}

var PERMS = [
  { key: 'debug', label: '串口调试' },
  { key: 'protocols', label: '协议配置' },
  { key: 'audit', label: '变更审核' },
  { key: 'users', label: '人员管理' },
  { key: 'permissions', label: '权限管理' },
  { key: 'database', label: '数据库管理' },
  { key: 'connection', label: '数据库连接' },
  { key: 'export', label: '协议导出' },
  { key: 'view_logs', label: '查看日志' },
];
var rolesCache = [];

function parsePerms(role) {
  try {
    return typeof role.permissions === 'string' ? JSON.parse(role.permissions || '{}') : (role.permissions || {});
  } catch (e) { return {}; }
}

async function loadRoles() {
  try {
    var r = await api('/admin/api/roles');
    if (!r.success) throw new Error(r.error || '加载失败');
    rolesCache = r.rows || [];
    var pill = document.getElementById('roles_pill');
    pill.textContent = rolesCache.length + ' 个角色';
    pill.className = 'head-pill ok';

    var html = '<table class="utable"><thead><tr><th>角色</th><th>描述</th><th>人数</th><th style="width:80px">操作</th></tr></thead><tbody>';
    for (var i = 0; i < rolesCache.length; i++) {
      var ro = rolesCache[i];
      html += '<tr><td><strong>' + esc(ro.name) + '</strong></td>'
        + '<td><input class="inline-input" style="width:100%" value="' + esc(ro.description || '') + '" placeholder="角色描述" onchange="updateRoleDesc(' + ro.id + ', this.value)"></td>'
        + '<td>' + esc(ro.count) + '</td>'
        + '<td><button class="mini-btn" data-id="' + ro.id + '" data-name="' + esc(ro.name) + '" onclick="deleteRole(Number(this.dataset.id), this.dataset.name)"' + (ro.count > 0 ? ' disabled' : '') + '>删除</button></td></tr>';
    }
    html += '</tbody></table>';
    document.getElementById('roles_wrap').innerHTML = html;

    var mh = '<table class="utable perm-table"><thead><tr><th>功能</th>';
    for (var j = 0; j < rolesCache.length; j++) {
      mh += '<th>' + esc(rolesCache[j].name) + (rolesCache[j].name === '管理员' ? '<div class="meta">全部权限</div>' : '') + '</th>';
    }
    mh += '</tr></thead><tbody>';
    for (var k = 0; k < PERMS.length; k++) {
      mh += '<tr><td>' + PERMS[k].label + '</td>';
      for (var m = 0; m < rolesCache.length; m++) {
        var rl = rolesCache[m];
        if (rl.name === '管理员') {
          mh += '<td><input type="checkbox" checked disabled></td>';
        } else {
          var on = !!parsePerms(rl)[PERMS[k].key];
          mh += '<td><input type="checkbox" data-rid="' + rl.id + '" data-key="' + PERMS[k].key + '"' + (on ? ' checked' : '') + ' onchange="togglePerm(Number(this.dataset.rid), this.dataset.key)"></td>';
        }
      }
      mh += '</tr>';
    }
    mh += '</tbody></table>';
    document.getElementById('perm_wrap').innerHTML = mh;
  } catch (e) {
    document.getElementById('roles_wrap').innerHTML = '<span class="err">' + esc(e.message) + '</span>';
    document.getElementById('perm_wrap').innerHTML = '';
  }
}

async function createRole() {
  var btn = document.getElementById('r_save');
  btn.disabled = true;
  try {
    var r = await api('/admin/api/roles/create', {
      name: document.getElementById('r_name').value.trim(),
      description: document.getElementById('r_desc').value.trim(),
    });
    if (r.success) {
      toast('角色已创建');
      document.getElementById('r_name').value = '';
      document.getElementById('r_desc').value = '';
      loadRoles();
    } else toast(r.error || '创建失败', true);
  } finally { btn.disabled = false; }
}

async function updateRoleDesc(id, desc) {
  var r = await api('/admin/api/roles/update', { id: id, description: desc });
  if (r.success) toast('描述已更新');
  else toast(r.error || '更新失败', true);
}

async function deleteRole(id, name) {
  if (!confirm('确定删除角色「' + name + '」？')) return;
  var r = await api('/admin/api/roles/delete', { id: id });
  if (r.success) { toast('角色已删除'); loadRoles(); }
  else { toast(r.error || '删除失败', true); loadRoles(); }
}

async function togglePerm(id, key) {
  var role = null;
  for (var i = 0; i < rolesCache.length; i++) {
    if (rolesCache[i].id === id) role = rolesCache[i];
  }
  if (!role) return;
  var perms = parsePerms(role);
  perms[key] = !perms[key];
  var r = await api('/admin/api/roles/permissions', { id: id, permissions: perms });
  if (r.success) role.permissions = JSON.stringify(perms);
  else { toast(r.error || '保存失败', true); loadRoles(); }
}

async function loadDb() {
  try {
    var r = await api('/admin/api/db/stats');
    if (!r.success) throw new Error(r.error || '加载失败');
    document.getElementById('db_pill').textContent = '正常';
    document.getElementById('db_pill').className = 'head-pill ok';
    document.getElementById('dbsize_text').textContent = '库文件 ' + (r.dbSize / 1024).toFixed(1) + ' KB';
    document.getElementById('db_stats').innerHTML = r.tables.map(function (t) {
      return '<div class="dbstat"><div class="n">' + esc(t.rows) + '</div><div class="l">' + esc(t.name) + '</div></div>';
    }).join('');
  } catch (e) {
    document.getElementById('db_pill').textContent = '异常';
    document.getElementById('db_pill').className = 'head-pill warn';
    document.getElementById('db_stats').innerHTML = '<span class="err">' + esc(e.message) + '</span>';
  }
  try {
    var b = await api('/admin/api/db/backups');
    if (!b.success) throw new Error(b.error || '加载失败');
    var el = document.getElementById('bk_history');
    el.innerHTML = b.rows.length ? b.rows.map(function (f) {
      return '<div><span>' + esc(f.file) + '</span><span class="t">' + esc(f.time) + ' · ' + (f.size / 1024).toFixed(1) + ' KB</span></div>';
    }).join('') : '暂无备份文件';
  } catch (e) {
    document.getElementById('bk_history').innerHTML = '<span class="err">' + esc(e.message) + '</span>';
  }
}

async function checkIntegrity() {
  var btn = document.getElementById('integrity_btn');
  btn.disabled = true;
  try {
    var r = await api('/admin/api/db/integrity');
    var el = document.getElementById('integrity_result');
    el.textContent = r.result === 'ok' ? '完整性检查通过 ✓' : '结果：' + r.result;
    el.className = 'result ' + (r.result === 'ok' ? 'ok' : 'err');
  } finally { btn.disabled = false; }
}

/* ── 概览：活动趋势图 + 最近动态（数据来自审计日志） ── */
var actRows = [];
var actPts = [], actKeys = [], actLabels = [], actTot = [], actAuth = [], actGw = [];

async function loadActivity() {
  try {
    var r = await api('/admin/api/logs');
    actRows = r.rows || [];
  } catch (e) { actRows = []; }
  renderActivity();
  renderRecent();
}

function renderActivity() {
  var wrap = document.getElementById('chart_wrap');
  if (!wrap || !wrap.clientWidth) return;
  var oldSvg = wrap.querySelector('svg');
  if (oldSvg) oldSvg.parentNode.removeChild(oldSvg);
  var oldEmpty = wrap.querySelector('.chart-empty');
  if (oldEmpty) oldEmpty.parentNode.removeChild(oldEmpty);
  var W = wrap.clientWidth, H = 232, padT = 18, padB = 30, padX = 18, n = 12;
  var start = new Date(); start.setMinutes(0, 0, 0);
  actLabels = []; actKeys = [];
  for (var i = n - 1; i >= 0; i--) {
    var d = new Date(start.getTime() - i * 3600000);
    actKeys.push(d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2) + ' ' + ('0' + d.getHours()).slice(-2));
    actLabels.push(('0' + d.getHours()).slice(-2) + ':00');
  }
  actAuth = []; actGw = []; actTot = [];
  for (var bi = 0; bi < n; bi++) { actAuth.push(0); actGw.push(0); actTot.push(0); }
  for (var ri = 0; ri < actRows.length; ri++) {
    var k = String(actRows[ri].created_at || '').slice(0, 13);
    var idx = actKeys.indexOf(k);
    if (idx === -1) continue;
    if (actRows[ri].category === 'auth') actAuth[idx]++; else actGw[idx]++;
    actTot[idx]++;
  }
  var anyData = false;
  for (var zi = 0; zi < n; zi++) if (actTot[zi] > 0) { anyData = true; break; }
  if (!actRows.length || !anyData) {
    wrap.insertAdjacentHTML('beforeend', '<div class="chart-empty">近 12 小时暂无活动记录</div>');
    actPts = [];
    return;
  }
  var max = 4;
  for (var mi = 0; mi < n; mi++) if (actTot[mi] > max) max = actTot[mi];
  max = Math.ceil(max / 4) * 4;
  var innerW = W - padX * 2, innerH = H - padT - padB;
  actPts = [];
  for (var pi = 0; pi < n; pi++) actPts.push([padX + pi * innerW / (n - 1), padT + innerH - actTot[pi] / max * innerH]);
  function smooth(pp) {
    var st = 'M' + pp[0][0].toFixed(1) + ' ' + pp[0][1].toFixed(1);
    for (var j = 0; j < pp.length - 1; j++) {
      var p0 = pp[Math.max(0, j - 1)], p1 = pp[j], p2 = pp[j + 1], p3 = pp[Math.min(pp.length - 1, j + 2)];
      st += ' C' + (p1[0] + (p2[0] - p0[0]) / 6).toFixed(1) + ' ' + (p1[1] + (p2[1] - p0[1]) / 6).toFixed(1)
        + ' ' + (p2[0] - (p3[0] - p1[0]) / 6).toFixed(1) + ' ' + (p2[1] - (p3[1] - p1[1]) / 6).toFixed(1)
        + ' ' + p2[0].toFixed(1) + ' ' + p2[1].toFixed(1);
    }
    return st;
  }
  var line = smooth(actPts);
  var baseY = padT + innerH;
  var area = line + ' L' + actPts[n - 1][0].toFixed(1) + ' ' + baseY + ' L' + actPts[0][0].toFixed(1) + ' ' + baseY + ' Z';
  var axis = '';
  for (var ai = 0; ai < n; ai += 3) axis += '<text class="chart-axis" x="' + actPts[ai][0].toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle">' + actLabels[ai] + '</text>';
  var svg = '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">'
    + '<defs><linearGradient id="actgrad" x1="0" y1="0" x2="0" y2="1">'
    + '<stop class="gstop-a" offset="0"/><stop class="gstop-b" offset="1"/></linearGradient></defs>'
    + '<path class="chart-area" d="' + area + '"/><path class="chart-line" d="' + line + '"/>'
    + axis
    + '<circle class="chart-dot" id="chart_dot" r="4.5" cx="0" cy="0" style="display:none"/></svg>';
  wrap.insertAdjacentHTML('afterbegin', svg);
}

function showActivityTip(i) {
  var tip = document.getElementById('chart_tip');
  var dot = document.getElementById('chart_dot');
  if (!tip || !dot || !actPts[i]) return;
  tip.innerHTML = '<div class="tt-h">' + esc(actKeys[i].slice(5, 13)) + '时</div>'
    + '<div class="tt-r"><span>全部 ' + actTot[i] + '</span>'
    + '<span class="tc-auth">认证 ' + actAuth[i] + '</span>'
    + '<span class="tc-gw">网关 ' + actGw[i] + '</span></div>';
  var hw = tip.offsetWidth / 2;
  tip.style.left = Math.max(hw + 2, Math.min(wrapW() - hw - 2, actPts[i][0])) + 'px';
  tip.style.top = (actPts[i][1] - 12) + 'px';
  tip.style.opacity = '1';
  dot.setAttribute('cx', actPts[i][0]);
  dot.setAttribute('cy', actPts[i][1]);
  dot.style.display = '';
}

function wrapW() {
  var wrap = document.getElementById('chart_wrap');
  return wrap ? wrap.clientWidth : 0;
}

function hideActivityTip() {
  var tip = document.getElementById('chart_tip');
  var dot = document.getElementById('chart_dot');
  if (tip) tip.style.opacity = '0';
  if (dot) dot.style.display = 'none';
}

function renderRecent() {
  var el = document.getElementById('recent_list');
  if (!el) return;
  var rows = actRows.slice(0, 7);
  if (!rows.length) {
    el.innerHTML = '<div class="recent-empty">暂无动态——团队成员的登录与数据操作会显示在这里</div>';
    return;
  }
  var html = '';
  for (var i = 0; i < rows.length; i++) {
    var x = rows[i];
    var isAuth = x.category === 'auth';
    html += '<div class="act-row' + (i === rows.length - 1 ? ' last' : '') + '">'
      + '<span class="act-ico ' + esc(x.category) + '">' + (isAuth ? '认' : '网') + '</span>'
      + '<span class="act-main"><span class="act-msg">' + esc(x.source) + ' · ' + esc(x.message) + '</span>'
      + '<span class="act-sub">' + esc(String(x.created_at || '').slice(5, 10)) + '</span></span>'
      + '<span class="act-time">' + esc(String(x.created_at || '').slice(11, 16)) + '</span></div>';
  }
  el.innerHTML = html;
}

var THEMES = ['orange', 'blue', 'green', 'cyan', 'purple', 'rose'];
function setTheme(t) {
  if (THEMES.indexOf(t) === -1) t = 'orange';
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('spm-admin-theme', t); } catch (e) { /* 隐私模式等场景忽略 */ }
  var dots = document.querySelectorAll('.tdot');
  for (var i = 0; i < dots.length; i++) {
    dots[i].className = 'tdot' + (dots[i].getAttribute('data-t') === t ? ' on' : '');
  }
}
(function () {
  var saved = 'orange';
  try { saved = localStorage.getItem('spm-admin-theme') || 'orange'; } catch (e) { /* ignore */ }
  setTheme(saved);
})();

/* ── 侧边导航：页面切换与折叠（记忆到 localStorage） ── */
var PAGE_TITLES = { overview:'概览', users:'用户管理', roles:'角色权限', mail:'邮件服务',
  backup:'定时备份', security:'访问控制', database:'数据库', logs:'审计日志' };
var PAGE_LOADERS = { overview:function(){ loadStatus(); loadActivity(); }, users:loadUsers, roles:loadRoles, mail:loadStatus,
  backup:loadStatus, security:loadStatus, database:loadDb, logs:loadLogs };

function showPage(p) {
  if (!PAGE_TITLES[p]) p = 'overview';
  var pages = document.querySelectorAll('.page');
  for (var i = 0; i < pages.length; i++)
    pages[i].className = 'page' + (pages[i].getAttribute('data-page') === p ? ' active' : '');
  var items = document.querySelectorAll('.nav-item');
  for (var j = 0; j < items.length; j++)
    items[j].className = 'nav-item' + (items[j].getAttribute('data-page') === p ? ' active' : '');
  document.getElementById('page_title').textContent = PAGE_TITLES[p];
  try { localStorage.setItem('spm-admin-page', p); } catch (e) { /* 隐私模式等场景忽略 */ }
  if (PAGE_LOADERS[p]) PAGE_LOADERS[p]();
  document.querySelector('.content').scrollTop = 0;
}

function toggleSide() {
  var collapsed = document.body.classList.toggle('side-collapsed');
  try { localStorage.setItem('spm-admin-side', collapsed ? '1' : ''); } catch (e) { /* ignore */ }
}

(function () {
  var collapsed = '';
  try { collapsed = localStorage.getItem('spm-admin-side'); } catch (e) { /* ignore */ }
  if (collapsed === '1') document.body.classList.add('side-collapsed');
  var p = 'overview';
  try { p = localStorage.getItem('spm-admin-page') || 'overview'; } catch (e) { /* ignore */ }
  showPage(p);
})();

(function () {
  var wrap = document.getElementById('chart_wrap');
  if (wrap) {
    wrap.addEventListener('mousemove', function (e) {
      if (!actPts.length) return;
      var rect = wrap.getBoundingClientRect();
      var mx = e.clientX - rect.left;
      var best = 0, bd = Infinity;
      for (var i = 0; i < actPts.length; i++) {
        var dist = Math.abs(actPts[i][0] - mx);
        if (dist < bd) { bd = dist; best = i; }
      }
      showActivityTip(best);
    });
    wrap.addEventListener('mouseleave', hideActivityTip);
  }
  window.addEventListener('resize', function () {
    clearTimeout(window.__actRsz);
    window.__actRsz = setTimeout(renderActivity, 180);
  });
})();

setInterval(loadStatus, 15000);
setInterval(loadUsers, 15000);
setInterval(loadRoles, 15000);
setInterval(loadDb, 15000);
setInterval(loadActivity, 15000);
</script>
</body>
</html>`;

/* ---------------- 请求处理 ---------------- */
const server = http.createServer(async (req, res) => {
  const url = (req.url || '').split('?')[0];

  try {
    if (req.method === 'GET' && url === '/api/health') {
      if (!checkAuth(req)) return sendJson(res, 401, { success: false, error: '访问令牌无效' });
      const cnt = db.prepare('SELECT COUNT(*) AS cnt FROM protocols').get().cnt;
      /* 附带最新备份信息，客户端/巡检可据此判断灾备是否正常运转 */
      const lastBackup = lastBackupInfo();
      return sendJson(res, 200, {
        success: true,
        protocolCount: cnt,
        serverTime: new Date().toLocaleString('zh-CN', { hour12: false }),
        mail: { enabled: MAIL_CFG.enabled, host: MAIL_CFG.enabled ? MAIL_CFG.host : '' },
        backup: backupCfg.enabled ? { enabled: true, intervalHours: backupCfg.intervalHours, keep: backupCfg.keep, last: lastBackup } : { enabled: false },
      });
    }

    /* ───── 本机管理台（仅 localhost；配置热生效并写回文件） ───── */
    if (url === '/admin' || url.startsWith('/admin/')) {
      if (!isLocalRequest(req)) return sendJson(res, 403, { success: false, error: '管理台仅限服务器本机访问' });

      if (req.method === 'GET' && url === '/admin') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(ADMIN_HTML);
        return;
      }

      if (req.method === 'GET' && url === '/admin/api/status') {
        cleanStaleOnlineUsers();
        const names = Array.from(onlineUsers.keys());
        return sendJson(res, 200, {
          success: true,
          port: PORT,
          dbPath: path.relative(__dirname, DB_PATH) || DB_PATH,
          driver: useBuiltinSqlite ? 'Node 内置 SQLite（免依赖）' : 'better-sqlite3',
          uptimeText: (() => {
            const s = Math.round(process.uptime());
            const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
            return (h > 0 ? h + ' 小时 ' : '') + m + ' 分钟';
          })(),
          tokenSet: !!TOKEN,
          users: {
            active: db.prepare("SELECT COUNT(*) AS c FROM users WHERE status = 'active'").get().c,
            loginableAdmins: countLoginableAdmins(),
          },
          online: { count: names.length, names },
          mail: {
            enabled: MAIL_CFG.enabled, host: MAIL_CFG.host, port: MAIL_CFG.port,
            secure: MAIL_CFG.secure, user: MAIL_CFG.user, from: MAIL_CFG.from,
            passSet: !!MAIL_CFG.pass,
          },
          backup: {
            enabled: backupCfg.enabled, intervalHours: backupCfg.intervalHours, keep: backupCfg.keep,
            last: lastBackupInfo(),
          },
        });
      }

      if (req.method === 'GET' && url === '/admin/api/logs') {
        const rows = db.prepare(`
          SELECT created_at, category, source, message FROM app_logs
          WHERE category IN ('auth', 'gateway') ORDER BY id DESC LIMIT 150
        `).all();
        return sendJson(res, 200, { success: true, rows });
      }

      let adminBody = {};
      if (req.method === 'POST') {
        try {
          adminBody = JSON.parse(await readBody(req));
        } catch {
          return sendJson(res, 400, { success: false, error: '请求体解析失败' });
        }
      }

      if (req.method === 'POST' && url === '/admin/api/mail') {
        const mail = Object.assign({}, config.mail);
        mail.enabled = !!adminBody.enabled;
        mail.host = String(adminBody.host || '').trim();
        mail.port = parseInt(adminBody.port, 10) || 465;
        mail.secure = adminBody.secure !== 'starttls';
        mail.user = String(adminBody.user || '').trim();
        /* 授权码留空 = 保持已保存密码不变，避免回显明文 */
        if (String(adminBody.pass || '') !== '') mail.pass = String(adminBody.pass);
        mail.from = String(adminBody.from || '').trim();
        if (!saveConfigPatch({ mail })) return sendJson(res, 200, { success: false, error: '配置写回失败，请检查文件权限' });
        MAIL_CFG = computeMailCfg(mail);
        logServer(`邮件配置已通过管理台更新: ${MAIL_CFG.enabled ? `启用（${MAIL_CFG.host}）` : '停用'}`);
        return sendJson(res, 200, { success: true });
      }

      if (req.method === 'POST' && url === '/admin/api/mail/test') {
        const to = String(adminBody.to || '').trim();
        if (!isEmail(to)) return sendJson(res, 200, { success: false, error: '收件邮箱格式不正确' });
        if (!MAIL_CFG.enabled) return sendJson(res, 200, { success: false, error: '邮件服务未启用，请先填写并保存 SMTP 配置' });
        try {
          await sendMail({
            to,
            subject: '【串口协议管理工具】测试邮件',
            text: '这是一封来自团队服务器管理台的测试邮件。\n收到即说明 SMTP 配置正确，注册/找回密码的验证码将正常送达。',
          });
          logServer(`管理台测试邮件已发送 → ${C.gray}${to}${C.reset}`);
          return sendJson(res, 200, { success: true });
        } catch (e) {
          logError(`管理台测试邮件发送失败(${to}): ${e.message}`);
          return sendJson(res, 200, { success: false, error: e.message });
        }
      }

      if (req.method === 'POST' && url === '/admin/api/token') {
        TOKEN = String(adminBody.token || '').trim();
        if (!saveConfigPatch({ token: TOKEN })) return sendJson(res, 200, { success: false, error: '配置写回失败' });
        logServer(TOKEN ? '团队 Token 已通过管理台更新（成员客户端需同步）' : '团队 Token 已清除（不鉴权模式）');
        return sendJson(res, 200, { success: true });
      }

      if (req.method === 'POST' && url === '/admin/api/backup') {
        applyBackupSettings(adminBody.enabled, adminBody.intervalHours, adminBody.keep);
        const backup = Object.assign({}, config.backup);
        backup.enabled = backupCfg.enabled;
        backup.intervalHours = backupCfg.intervalHours;
        backup.keep = backupCfg.keep;
        if (!saveConfigPatch({ backup })) return sendJson(res, 200, { success: false, error: '配置写回失败' });
        return sendJson(res, 200, { success: true });
      }

      if (req.method === 'POST' && url === '/admin/api/backup/run') {
        const ok = runBackup();
        return sendJson(res, 200, ok ? { success: true, file: '已生成最新备份' } : { success: false, error: '备份失败，请查看服务器控制台' });
      }

      /* ── 用户与管理员（控制台直管；受"最后一个可登录管理员"死锁保护） ── */
      if (req.method === 'GET' && url === '/admin/api/users') {
        cleanStaleOnlineUsers();
        const rows = db.prepare(`
          SELECT u.id, u.username, u.display_name, u.email, u.department, u.status, u.email_verified, u.last_login,
                 r.name AS role_name
          FROM users u LEFT JOIN roles r ON u.role_id = r.id
          ORDER BY u.id
        `).all();
        for (const u of rows) u.online = onlineUsers.has(u.username);
        return sendJson(res, 200, { success: true, rows, loginableAdmins: countLoginableAdmins() });
      }

      if (req.method === 'POST' && url === '/admin/api/users/create') {
        const email = normEmail(adminBody.email);
        const password = String(adminBody.password || '');
        const displayName = String(adminBody.displayName || '').trim().slice(0, 50);
        const roleName = adminBody.role === '工程师' ? '工程师' : '管理员';
        if (!isEmail(email)) return sendJson(res, 200, { success: false, error: '邮箱格式不正确' });
        if (password.length < MIN_PASSWORD_LEN) return sendJson(res, 200, { success: false, error: `密码至少 ${MIN_PASSWORD_LEN} 位` });
        if (findUserByEmail(email)) return sendJson(res, 200, { success: false, error: '该邮箱已注册' });
        let username = email.split('@')[0].replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'user';
        const base = username;
        for (let n = 2; db.prepare('SELECT id FROM users WHERE username = ?').get(username); n++) {
          username = `${base}-${n}`;
        }
        const role = db.prepare('SELECT id FROM roles WHERE name = ?').get(roleName) || null;
        try {
          const ins = db.prepare(`
            INSERT INTO users (username, display_name, email, password_hash, role_id, email_verified, status)
            VALUES (?, ?, ?, ?, ?, 1, 'active')
          `).run(username, displayName || username, email, hashPassword(password), role ? role.id : null);
          auditAuth('管理台', `直接创建账号 ${email}（角色：${roleName}）`);
          return sendJson(res, 200, { success: true, id: Number(ins.lastInsertRowid) });
        } catch (e) {
          const dup = String(e.message).includes('UNIQUE');
          return sendJson(res, 200, { success: false, error: dup ? '邮箱或用户名已存在' : '创建失败：' + e.message });
        }
      }

      if (req.method === 'POST' && url === '/admin/api/users/role') {
        const id = Number(adminBody.id);
        const roleName = adminBody.role === '工程师' ? '工程师' : '管理员';
        const target = db.prepare(`
          SELECT u.*, r.name AS role_name FROM users u LEFT JOIN roles r ON u.role_id = r.id WHERE u.id = ?
        `).get(id);
        if (!target) return sendJson(res, 200, { success: false, error: '用户不存在' });
        if (target.role_name !== roleName) {
          /* 收回最后一个可登录管理员的管理员身份 → 死锁防护 */
          if (target.role_name === '管理员' && target.status === 'active'
            && Number(target.email_verified) === 1 && target.password_hash
            && countLoginableAdmins() <= 1) {
            return sendJson(res, 200, { success: false, error: '不能收回最后一个可登录管理员的管理员身份' });
          }
          const role = db.prepare('SELECT id FROM roles WHERE name = ?').get(roleName);
          if (!role) return sendJson(res, 200, { success: false, error: '角色不存在' });
          db.prepare('UPDATE users SET role_id = ? WHERE id = ?').run(role.id, id);
          auditAuth('管理台', `调整 ${target.username} 角色为 ${roleName}`);
        }
        return sendJson(res, 200, { success: true });
      }

      if (req.method === 'POST' && url === '/admin/api/users/status') {
        const id = Number(adminBody.id);
        const status = adminBody.status === 'active' ? 'active' : 'locked';
        const target = db.prepare(`
          SELECT u.*, r.name AS role_name FROM users u LEFT JOIN roles r ON u.role_id = r.id WHERE u.id = ?
        `).get(id);
        if (!target) return sendJson(res, 200, { success: false, error: '用户不存在' });
        if (target.status !== status) {
          /* 停用最后一个可登录管理员 → 死锁防护 */
          if (status !== 'active' && target.role_name === '管理员' && target.status === 'active'
            && Number(target.email_verified) === 1 && target.password_hash
            && countLoginableAdmins() <= 1) {
            return sendJson(res, 200, { success: false, error: '不能停用最后一个可登录管理员' });
          }
          db.prepare('UPDATE users SET status = ?, api_token = ?, api_token_expires = 0 WHERE id = ?')
            .run(status, '', id);
          auditAuth('管理台', `${status === 'active' ? '启用' : '停用'}账号 ${target.username}${status !== 'active' ? '（令牌吊销）' : ''}`);
        }
        return sendJson(res, 200, { success: true });
      }

      if (req.method === 'POST' && url === '/admin/api/users/reset-code') {
        const id = Number(adminBody.id);
        const target = db.prepare('SELECT id, username, email, status, email_verified FROM users WHERE id = ?').get(id);
        if (!target || !target.email) return sendJson(res, 200, { success: false, error: '用户不存在或未绑定邮箱' });
        if (target.status !== 'active' || Number(target.email_verified) !== 1) {
          return sendJson(res, 200, { success: false, error: '仅可对邮箱已验证的启用账号发送重置验证码' });
        }
        try {
          const code = issueCode(normEmail(target.email), 'reset');
          await sendCodeMail(normEmail(target.email), code, 'reset');
          auditAuth(target.username, '管理员通过控制台触发密码重置验证码');
          return sendJson(res, 200, { success: true });
        } catch (e) {
          return sendJson(res, 200, { success: false, error: e.client ? e.message : '验证码发送失败，请查看服务器控制台' });
        }
      }

      /* ── 角色与权限（数据格式与客户端人员管理页一致：roles.permissions 为 JSON 串） ── */
      if (req.method === 'GET' && url === '/admin/api/roles') {
        const rows = db.prepare(`
          SELECT r.id, r.name, r.description, r.permissions, COUNT(u.id) AS count
          FROM roles r LEFT JOIN users u ON u.role_id = r.id
          GROUP BY r.id ORDER BY r.id
        `).all();
        return sendJson(res, 200, { success: true, rows });
      }

      if (req.method === 'POST' && url === '/admin/api/roles/create') {
        const name = String(adminBody.name || '').trim();
        const description = String(adminBody.description || '').trim().slice(0, 200);
        if (!name || name.length > 50) return sendJson(res, 200, { success: false, error: '角色名称必填且不超过 50 字' });
        if (db.prepare('SELECT id FROM roles WHERE name = ?').get(name)) {
          return sendJson(res, 200, { success: false, error: '角色名称已存在' });
        }
        try {
          const ins = db.prepare('INSERT INTO roles (name, description) VALUES (?, ?)').run(name, description);
          auditAuth('管理台', `新建角色 ${name}`);
          return sendJson(res, 200, { success: true, id: Number(ins.lastInsertRowid) });
        } catch (e) {
          return sendJson(res, 200, { success: false, error: String(e.message).includes('UNIQUE') ? '角色名称已存在' : '创建失败：' + e.message });
        }
      }

      if (req.method === 'POST' && url === '/admin/api/roles/update') {
        const id = Number(adminBody.id);
        const description = String(adminBody.description || '').trim().slice(0, 200);
        const role = db.prepare('SELECT id FROM roles WHERE id = ?').get(id);
        if (!role) return sendJson(res, 200, { success: false, error: '角色不存在' });
        db.prepare('UPDATE roles SET description = ? WHERE id = ?').run(description, id);
        return sendJson(res, 200, { success: true });
      }

      if (req.method === 'POST' && url === '/admin/api/roles/delete') {
        const id = Number(adminBody.id);
        const role = db.prepare('SELECT id, name FROM roles WHERE id = ?').get(id);
        if (!role) return sendJson(res, 200, { success: false, error: '角色不存在' });
        const used = db.prepare('SELECT COUNT(*) AS c FROM users WHERE role_id = ?').get(id).c;
        if (used > 0) return sendJson(res, 200, { success: false, error: `该角色下仍有 ${used} 个用户，无法删除` });
        db.prepare('DELETE FROM roles WHERE id = ?').run(id);
        auditAuth('管理台', `删除角色 ${role.name}`);
        return sendJson(res, 200, { success: true });
      }

      if (req.method === 'POST' && url === '/admin/api/roles/permissions') {
        const id = Number(adminBody.id);
        const perms = adminBody.permissions;
        if (typeof perms !== 'object' || perms === null || Array.isArray(perms)) {
          return sendJson(res, 200, { success: false, error: '权限数据格式错误' });
        }
        const role = db.prepare('SELECT id, name FROM roles WHERE id = ?').get(id);
        if (!role) return sendJson(res, 200, { success: false, error: '角色不存在' });
        if (role.name === '管理员') return sendJson(res, 200, { success: false, error: '管理员角色始终拥有全部权限，不可修改' });
        db.prepare('UPDATE roles SET permissions = ? WHERE id = ?').run(JSON.stringify(perms), id);
        auditAuth('管理台', `更新角色 ${role.name} 的权限矩阵`);
        return sendJson(res, 200, { success: true });
      }

      /* ── 用户扩展操作 ── */
      if (req.method === 'POST' && url === '/admin/api/users/delete') {
        const id = Number(adminBody.id);
        const target = db.prepare(`
          SELECT u.*, r.name AS role_name FROM users u LEFT JOIN roles r ON u.role_id = r.id WHERE u.id = ?
        `).get(id);
        if (!target) return sendJson(res, 200, { success: false, error: '用户不存在' });
        if (target.role_name === '管理员' && target.status === 'active'
          && Number(target.email_verified) === 1 && target.password_hash
          && countLoginableAdmins() <= 1) {
          return sendJson(res, 200, { success: false, error: '不能删除最后一个可登录管理员' });
        }
        db.prepare('DELETE FROM users WHERE id = ?').run(id);
        auditAuth('管理台', `删除账号 ${target.username}（${target.email || '无邮箱'}）`);
        return sendJson(res, 200, { success: true });
      }

      if (req.method === 'POST' && url === '/admin/api/users/dept') {
        const id = Number(adminBody.id);
        const dept = String(adminBody.department || '').trim().slice(0, 50);
        const target = db.prepare('SELECT id, username FROM users WHERE id = ?').get(id);
        if (!target) return sendJson(res, 200, { success: false, error: '用户不存在' });
        db.prepare('UPDATE users SET department = ? WHERE id = ?').run(dept, id);
        return sendJson(res, 200, { success: true });
      }

      /* ── 数据库维护 ── */
      if (req.method === 'GET' && url === '/admin/api/db/stats') {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
        const stats = tables.map(t => ({ name: t.name, rows: db.prepare(`SELECT COUNT(*) AS cnt FROM "${t.name}"`).get().cnt }));
        let dbSize = 0;
        try { dbSize = fs.statSync(DB_PATH).size; } catch { /* 文件不存在等场景 */ }
        return sendJson(res, 200, { success: true, tables: stats, dbSize });
      }

      if (req.method === 'GET' && url === '/admin/api/db/integrity') {
        const row = db.prepare('PRAGMA integrity_check').get();
        const result = row ? String(Object.values(row)[0]) : 'unknown';
        return sendJson(res, 200, { success: true, result });
      }

      if (req.method === 'GET' && url === '/admin/api/db/backups') {
        let files = [];
        try {
          files = fs.readdirSync(backupCfg.dir)
            .filter(f => f.startsWith(BACKUP_PREFIX) && f.endsWith(BACKUP_SUFFIX))
            .map(f => {
              const st = fs.statSync(path.join(backupCfg.dir, f));
              return { file: f, size: st.size, time: new Date(st.mtimeMs).toLocaleString('zh-CN', { hour12: false }) };
            })
            .sort((a, b) => (a.file < b.file ? 1 : -1));
        } catch { /* 备份目录不存在等场景 */ }
        return sendJson(res, 200, { success: true, rows: files, dir: backupCfg.dir });
      }

      return sendJson(res, 404, { success: false, error: '接口不存在' });
    }

    /* ───── 自动更新：静态文件服务 ───── */
    if (req.method === 'GET' && url.startsWith('/updates/')) {
      const updatesDir = path.join(__dirname, 'updates');
      const reqFile = url.slice('/updates/'.length);
      /* 防止路径穿越 */
      const filePath = path.join(updatesDir, reqFile);
      if (!filePath.startsWith(updatesDir)) return sendJson(res, 403, { error: '禁止访问' });
      if (!fs.existsSync(filePath)) return sendJson(res, 404, { error: '文件不存在' });

      const ext = path.extname(filePath).toLowerCase();
      const mime = { '.yml': 'text/yaml; charset=utf-8', '.exe': 'application/octet-stream', '.blockmap': 'application/octet-stream' };
      const stat = fs.statSync(filePath);
      res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream', 'Content-Length': stat.size, 'Cache-Control': 'no-cache' });
      fs.createReadStream(filePath).pipe(res);
      logUpdates(`已服务: ${C.bold}${reqFile}${C.reset} ${C.gray}(${(stat.size / 1024 / 1024).toFixed(1)} MB)${C.reset}`);
      return;
    }

    /* ───── 心跳：客户端上报在线状态 ───── */
    if (req.method === 'POST' && url === '/api/heartbeat') {
      if (!checkAuth(req)) return sendJson(res, 401, { success: false, error: '访问令牌无效' });

      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return sendJson(res, 400, { success: false, error: '请求体解析失败' });
      }

      const username = String(body.username || '');
      if (!username) return sendJson(res, 400, { success: false, error: '缺少 username 字段' });

      onlineUsers.set(username, {
        displayName: String(body.displayName || username),
        lastSeen: Date.now(),
      });
      cleanStaleOnlineUsers();
      return sendJson(res, 200, { success: true });
    }

    /* ───── 查询在线用户列表 ───── */
    if (req.method === 'GET' && url === '/api/online-users') {
      if (!checkAuth(req)) return sendJson(res, 401, { success: false, error: '访问令牌无效' });

      cleanStaleOnlineUsers();
      const list = [];
      for (const [name, info] of onlineUsers) {
        list.push({ username: name, displayName: info.displayName, lastSeen: info.lastSeen });
      }
      return sendJson(res, 200, { success: true, users: list });
    }

    /* ───── 版本推送：SSE 长连接 ───── */
    if (req.method === 'GET' && url === '/api/update/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`: connected ${Date.now()}\n\n`);

      const clientId = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      sseClients.set(clientId, res);
      sseClientCount++;

      logUpdates(`SSE 客户端接入: ${C.cyan}${clientId}${C.reset} ${C.gray}(在线: ${sseClientCount})${C.reset}`);

      /* 心跳，防止连接超时断开 */
      const heartbeat = setInterval(() => {
        if (!res.writableEnded) {
          res.write(`: ping ${Date.now()}\n\n`);
        }
      }, 30000);

      req.on('close', () => {
        clearInterval(heartbeat);
        sseClients.delete(clientId);
        sseClientCount--;
        logUpdates(`SSE 客户端断开: ${C.gray}${clientId}${C.reset} ${C.gray}(在线: ${sseClientCount})${C.reset}`);
      });
      return;
    }

    /* ───── 版本推送：广播新版本 ───── */
    if (req.method === 'POST' && url === '/api/update/broadcast') {
      if (!checkAuth(req)) return sendJson(res, 401, { success: false, error: '访问令牌无效' });

      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (e) {
        return sendJson(res, 400, { success: false, error: `请求体解析失败: ${e.message}` });
      }

      const version = body.version;
      const releaseNotes = body.releaseNotes || '';
      if (!version) return sendJson(res, 400, { success: false, error: '缺少 version 字段' });

      const pushed = broadcastUpdate(version, releaseNotes);
      logUpdates(`${C.orange}${C.bold}▶ 推送新版本 v${version}${C.reset} ${C.gray}(在线: ${pushed} 台)${C.reset}`);
      return sendJson(res, 200, { success: true, pushed, online: sseClientCount });
    }

    /* ───── 用户级令牌签发（兼容端点：用户名 + 密码换令牌，保留一个版本供未升级客户端） ───── */
    if (req.method === 'POST' && url === '/api/auth/user-token') {
      if (!checkAuth(req)) return sendJson(res, 401, { success: false, error: '访问令牌无效' });

      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return sendJson(res, 400, { success: false, error: '请求体解析失败' });
      }

      const username = String(body.username || '');
      const password = String(body.password || '');
      if (!username) return sendJson(res, 400, { success: false, error: '缺少 username 字段' });

      const user = db.prepare(`
        SELECT u.id, u.username, u.password_hash, u.status, r.name AS role_name
        FROM users u LEFT JOIN roles r ON u.role_id = r.id
        WHERE u.username = ?
      `).get(username);
      if (!user || user.status !== 'active') {
        return sendJson(res, 403, { success: false, error: '用户不存在或已禁用' });
      }
      /* 一律验密后签发：无密码的旧身份行不能再凭用户名领令牌（防冒领） */
      if (!verifyPassword(password, user.password_hash)) {
        return sendJson(res, 403, { success: false, error: '密码错误' });
      }

      const { token, expiresAt } = issueUserToken(user.id);
      try {
        db.prepare('INSERT INTO app_logs (level, category, source, message) VALUES (?, ?, ?, ?)')
          .run('info', 'gateway', user.username, `签发用户令牌（有效期至 ${new Date(expiresAt).toLocaleString('zh-CN', { hour12: false })}）`);
      } catch { /* 审计失败不影响业务 */ }
      return sendJson(res, 200, { success: true, token, expiresAt, role: user.role_name || '' });
    }

    /* ===================== 邮箱注册 / 登录 / 找回 =====================
     * 新版认证模型：邮箱 = 登录标识；注册需邮箱验证码 + 设置密码。
     *  - 防枚举：登录/找回统一文案；注册在邮箱已注册时明确提示
     *    （接口需团队 Token 才可达，枚举面仅限持有团队凭据的内部人员）
     *  - 限流：验证码同邮箱同用途 60s 冷却、错 5 次作废；登录不设重试限制（按需求取消）
     *  - 落库：验证码与用户令牌均只存 SHA-256 哈希
     *  - 引导：无可登录管理员时，首位注册者自动授予管理员角色
     */
    if (req.method === 'POST' && url === '/api/auth/register-request') {
      if (!checkAuth(req)) return sendJson(res, 401, { success: false, error: '访问令牌无效' });
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return sendJson(res, 400, { success: false, error: '请求体解析失败' });
      }
      const email = normEmail(body.email);
      if (!isEmail(email)) return sendJson(res, 400, { success: false, error: '邮箱格式不正确' });

      /* 邮箱已注册（含被禁用）直接提示：接口需团队 Token 才可达，枚举面可控；
       * 统一文案会让"已注册"用户拿不到码卡死在注册表单，故此处选择明确提示 */
      const existing = findUserByEmail(email);
      if (existing) {
        return sendJson(res, 200, {
          success: false,
          error: existing.status === 'active' ? '该邮箱已注册，请直接登录或找回密码' : '该邮箱已注册但已被禁用，请联系管理员',
        });
      }

      try {
        const code = issueCode(email, 'register');
        await sendCodeMail(email, code, 'register');
        auditAuth(email, `注册验证码已发出（${MAIL_CFG.enabled ? '邮件' : '控制台兜底'}）`);
      } catch (e) {
        return sendJson(res, 200, { success: false, error: e.client ? e.message : '验证码发送失败，请联系服务器管理员' });
      }
      return sendJson(res, 200, { success: true, message: '验证码已发送，请查收邮箱（10 分钟内有效）' });
    }

    /* ───── 注册·第二步：验证码 + 设置密码 → 建号并签发令牌 ───── */
    if (req.method === 'POST' && url === '/api/auth/register-verify') {
      if (!checkAuth(req)) return sendJson(res, 401, { success: false, error: '访问令牌无效' });
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return sendJson(res, 400, { success: false, error: '请求体解析失败' });
      }
      const email = normEmail(body.email);
      const code = String(body.code || '').trim();
      const password = String(body.password || '');
      const displayName = String(body.displayName || '').trim().slice(0, 50);
      if (!isEmail(email)) return sendJson(res, 400, { success: false, error: '邮箱格式不正确' });
      if (!/^\d{6}$/.test(code)) return sendJson(res, 200, { success: false, error: '请输入 6 位数字验证码' });
      if (password.length < MIN_PASSWORD_LEN) {
        return sendJson(res, 200, { success: false, error: `密码至少 ${MIN_PASSWORD_LEN} 位` });
      }

      const existing = findUserByEmail(email);
      if (existing) {
        return sendJson(res, 200, {
          success: false,
          error: existing.status === 'active' ? '该邮箱已注册，请直接登录' : '该邮箱已注册但已被禁用，请联系管理员',
        });
      }
      try {
        consumeCode(email, 'register', code);
      } catch (e) {
        return sendJson(res, 200, { success: false, error: e.client ? e.message : '验证码校验失败' });
      }

      /* username 取邮箱前缀（系统内部身份键：审计/通知/网关透传仍用 username），撞名追加序号 */
      const base = email.split('@')[0].replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'user';
      let username = base;
      for (let n = 2; db.prepare('SELECT id FROM users WHERE username = ?').get(username); n++) {
        username = `${base}-${n}`;
      }

      /* 管理员引导：当前无可登录管理员时，首位注册者授予管理员角色 */
      let roleName = '工程师';
      if (countLoginableAdmins() === 0) roleName = '管理员';
      const role = db.prepare('SELECT id FROM roles WHERE name = ?').get(roleName)
        || db.prepare('SELECT id FROM roles WHERE name = ?').get('管理员')
        || null;

      const ins = db.prepare(`
        INSERT INTO users (username, display_name, email, password_hash, role_id, email_verified, status)
        VALUES (?, ?, ?, ?, ?, 1, 'active')
      `).run(username, displayName || username, email, hashPassword(password), role ? role.id : null);
      const userId = Number(ins.lastInsertRowid);
      const { token, expiresAt } = issueUserToken(userId);
      auditAuth(username, `新用户注册（${email}，角色：${roleName}${roleName === '管理员' ? '，首位注册者引导' : ''}）`);

      const row = db.prepare(`
        SELECT u.*, r.name AS role_name FROM users u LEFT JOIN roles r ON u.role_id = r.id WHERE u.id = ?
      `).get(userId);
      return sendJson(res, 200, { success: true, token, expiresAt, user: toAuthUser(row) });
    }

    /* ───── 登录（防枚举：无论邮箱是否存在，统一文案） ───── */
    if (req.method === 'POST' && url === '/api/auth/login') {
      if (!checkAuth(req)) return sendJson(res, 401, { success: false, error: '访问令牌无效' });
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return sendJson(res, 400, { success: false, error: '请求体解析失败' });
      }
      const email = normEmail(body.email);
      const password = String(body.password || '');
      if (!email || !password) return sendJson(res, 200, { success: false, error: '请输入邮箱和密码' });

      const user = findUserByEmail(email);
      const ok = !!(user && user.status === 'active'
        && Number(user.email_verified) === 1
        && user.password_hash
        && verifyPassword(password, user.password_hash));
      if (!ok) {
        /* 不设重试限制（按需求取消）；统一文案防枚举 */
        return sendJson(res, 200, { success: false, error: '邮箱或密码错误' });
      }

      const { token, expiresAt } = issueUserToken(user.id);
      db.prepare("UPDATE users SET last_login = datetime('now','localtime') WHERE id = ?").run(user.id);
      auditAuth(user.username, `邮箱登录成功（令牌有效期至 ${new Date(expiresAt).toLocaleString('zh-CN', { hour12: false })}）`);
      return sendJson(res, 200, { success: true, token, expiresAt, user: toAuthUser(user) });
    }

    /* ───── 找回密码·第一步：发送验证码（防枚举：无论是否注册统一文案） ───── */
    if (req.method === 'POST' && url === '/api/auth/forgot-request') {
      if (!checkAuth(req)) return sendJson(res, 401, { success: false, error: '访问令牌无效' });
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return sendJson(res, 400, { success: false, error: '请求体解析失败' });
      }
      const email = normEmail(body.email);
      if (!isEmail(email)) return sendJson(res, 400, { success: false, error: '邮箱格式不正确' });

      const user = findUserByEmail(email);
      if (user && user.status === 'active' && Number(user.email_verified) === 1) {
        try {
          const code = issueCode(email, 'reset');
          await sendCodeMail(email, code, 'reset');
          auditAuth(user.username, `重置密码验证码已发出（${MAIL_CFG.enabled ? '邮件' : '控制台兜底'}）`);
        } catch (e) {
          if (e.client) return sendJson(res, 200, { success: false, error: e.message });
          return sendJson(res, 200, { success: false, error: '验证码发送失败，请联系服务器管理员' });
        }
      }
      return sendJson(res, 200, { success: true, message: '如果该邮箱已注册，验证码已发送（10 分钟内有效）' });
    }

    /* ───── 找回密码·第二步：验证码 + 新密码 → 重置并吊销全部旧令牌 ───── */
    if (req.method === 'POST' && url === '/api/auth/reset-password') {
      if (!checkAuth(req)) return sendJson(res, 401, { success: false, error: '访问令牌无效' });
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return sendJson(res, 400, { success: false, error: '请求体解析失败' });
      }
      const email = normEmail(body.email);
      const code = String(body.code || '').trim();
      const password = String(body.password || '');
      if (!isEmail(email)) return sendJson(res, 400, { success: false, error: '邮箱格式不正确' });
      if (password.length < MIN_PASSWORD_LEN) {
        return sendJson(res, 200, { success: false, error: `密码至少 ${MIN_PASSWORD_LEN} 位` });
      }

      const user = findUserByEmail(email);
      if (!user || user.status !== 'active' || Number(user.email_verified) !== 1) {
        /* 不区分"未注册/未验证/被禁用"，统一按验证码口径返回 */
        return sendJson(res, 200, { success: false, error: '验证码无效，请重新获取' });
      }
      try {
        consumeCode(email, 'reset', code);
      } catch (e) {
        return sendJson(res, 200, { success: false, error: e.client ? e.message : '验证码校验失败' });
      }
      db.prepare("UPDATE users SET password_hash = ?, api_token = '', api_token_expires = 0 WHERE id = ?")
        .run(hashPassword(password), user.id);
      auditAuth(user.username, '密码已重置（邮箱验证码），全部旧令牌吊销');
      return sendJson(res, 200, { success: true, message: '密码已重置，请使用新密码登录', userId: user.id });
    }

    /* ───── 会话有效性确认（客户端启动恢复会话时调用） ───── */
    if (req.method === 'POST' && url === '/api/auth/session-check') {
      if (!checkAuth(req)) return sendJson(res, 401, { success: false, error: '访问令牌无效' });
      const op = getOperator(req);
      if (!op) return sendJson(res, 200, { success: false, error: '会话无效或已过期' });
      const row = db.prepare(`
        SELECT u.*, r.name AS role_name FROM users u LEFT JOIN roles r ON u.role_id = r.id WHERE u.id = ?
      `).get(op.id);
      if (!row || row.status !== 'active') {
        return sendJson(res, 200, { success: false, error: '会话无效或已过期' });
      }
      return sendJson(res, 200, { success: true, user: toAuthUser(row) });
    }

    if (req.method === 'POST' && (url === '/api/query' || url === '/api/execute' || url === '/api/batch')) {
      if (!checkAuth(req)) return sendJson(res, 401, { success: false, error: '访问令牌无效' });

      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (e) {
        return sendJson(res, 400, { success: false, error: `请求体解析失败: ${e.message}` });
      }

      try {
        if (url === '/api/query') {
          if (typeof body.sql !== 'string') return sendJson(res, 400, { success: false, error: '缺少 sql 字段' });
          /* 只读端点：仅允许 SELECT，且表必须全在白名单内 */
          const { verb } = parseSqlStatement(body.sql);
          if (verb !== 'SELECT') return sendJson(res, 403, { success: false, error: '只读接口仅允许 SELECT 查询' });
          const rows = db.prepare(body.sql).all(...(body.params || []));
          return sendJson(res, 200, { success: true, rows });
        }
        if (url === '/api/execute') {
          if (typeof body.sql !== 'string') return sendJson(res, 400, { success: false, error: '缺少 sql 字段' });
          /* 写端点：必须携带有效操作人身份 */
          const op = getOperator(req);
          if (!op) {
            return sendJson(res, 403, { success: false, error: '缺少有效的操作人身份，请重新切换用户或升级客户端' });
          }
          const { verb, tables } = parseSqlStatement(body.sql);
          for (const t of tables) checkWritePermission(op, verb, t, body.sql, body.params);
          const r = db.prepare(body.sql).run(...(body.params || []));
          for (const t of tables) logGatewayWrite(op.username, verb, t, body.sql);
          return sendJson(res, 200, { success: true, changes: r.changes, lastInsertRowid: Number(r.lastInsertRowid) });
        }
        /* batch：逐条校验后整体事务执行 */
        const stmts = Array.isArray(body.statements) ? body.statements : [];
        const op = getOperator(req);
        if (!op) {
          return sendJson(res, 403, { success: false, error: '缺少有效的操作人身份，请重新切换用户或升级客户端' });
        }
        const parsed = stmts.map(({ sql, params }) => {
          const { verb, tables } = parseSqlStatement(sql);
          for (const t of tables) checkWritePermission(op, verb, t, sql, params);
          return { verb, tables, sql };
        });
        const results = runBatch(stmts);
        parsed.forEach(p => p.tables.forEach(t => logGatewayWrite(op.username, p.verb, t, p.sql)));
        return sendJson(res, 200, { success: true, results });
      } catch (err) {
        logError(`SQL 执行失败: ${C.gray}${err.message}${C.reset}`);
        return sendJson(res, 200, { success: false, error: err.message });
      }
    }

    return sendJson(res, 404, { success: false, error: '接口不存在' });
  } catch (err) {
    logError(`请求处理异常: ${C.gray}${err.message}${C.reset}`);
    return sendJson(res, 500, { success: false, error: err.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = getLanIps();
  // 数据库路径用相对路径，避免面板过宽
  const dbDisplay = path.relative(__dirname, DB_PATH) || DB_PATH;
  const rows = [
    { label: '本机地址', val: `http://localhost:${PORT}`, color: C.cyan },
    ...ips.map((ip, i) => ({ label: i === 0 ? '局域网地址' : '         ', val: `http://${ip}:${PORT}${i === 0 ? `  ${C.green}← 成员填这个${C.reset}` : ''}`, color: i === 0 ? C.bold + C.green : C.cyan })),
    ...ips.length === 0 ? [{ label: '局域网地址', val: '未检测到（请检查网络）', color: C.yellow }] : [],
    { label: '数据库', val: dbDisplay, color: C.gray },
    { label: '驱动', val: useBuiltinSqlite ? 'Node 内置 SQLite（免依赖）' : 'better-sqlite3', color: useBuiltinSqlite ? C.green : C.yellow },
    { label: '鉴权', val: TOKEN ? '已启用（团队 Token + 用户级令牌）' : '未启用（建议配置 token）', color: TOKEN ? C.green : C.yellow },
    { label: 'SQL 网关', val: '白名单模式（DML + 业务表校验）', color: C.green },
    { label: '邮件', val: MAIL_CFG.enabled ? `已启用（${MAIL_CFG.host}）` : '未配置（验证码打印在本控制台）', color: MAIL_CFG.enabled ? C.green : C.yellow },
    { label: '传输', val: '局域网明文 HTTP（TODO: 后续引入 HTTPS）', color: C.yellow },
    { label: '管理台', val: `http://localhost:${PORT}/admin（仅本机浏览器打开）`, color: C.cyan },
  ];
  const labelW = 10;
  const maxValLen = Math.max(...rows.map(r => [...stripAnsi(r.val)].length));
  const innerW = Math.min(Math.max(maxValLen + labelW + 2, 44), 72);
  const footer = '关闭本窗口或按 Ctrl+C 停止服务';

  const lines = [
    '',
    `${C.green}╔${W.repeat(innerW)}╗${C.reset}`,
    `${C.green}║${C.reset}${center(C.bold + '📡 团队数据共享服务器' + C.reset, innerW)}${C.green}║${C.reset}`,
    `${C.green}╟${HW.repeat(innerW)}╢${C.reset}`,
  ];
  rows.forEach(r => {
    const gap = innerW - labelW - 2 - [...stripAnsi(r.val)].length;
    lines.push(`${C.green}║${C.reset} ${C.gray}${pad(r.label, labelW)}${C.reset} ${r.color}${r.val}${C.reset}${' '.repeat(Math.max(0, gap))} ${C.green}║${C.reset}`);
  });
  lines.push(`${C.green}╟${HW.repeat(innerW)}╢${C.reset}`);
  lines.push(`${C.green}║${C.reset}${center(C.gray + footer + C.reset, innerW)}${C.green}║${C.reset}`);
  lines.push(`${C.green}╚${W.repeat(innerW)}╝${C.reset}`);
  lines.push('');
  lines.forEach(l => console.log(l));

  /* 自动打开管理台：交互式控制台（双击 .bat）启动时弹出浏览器；
   * 开机自启/守护进程（非 TTY）默认不弹，需要时配置 "autoOpenAdmin": true 强制打开 */
  if (config.autoOpenAdmin !== false && process.stdout.isTTY) {
    const adminUrl = `http://localhost:${PORT}/admin`;
    const opener = process.platform === 'win32'
      ? `explorer "${adminUrl}"`
      : (process.platform === 'darwin' ? `open "${adminUrl}"` : `xdg-open "${adminUrl}"`);
    try {
      exec(opener, () => {});
      logServer(`正在打开管理台: ${C.cyan}${adminUrl}${C.reset}`);
    } catch { /* 打开失败不影响服务 */ }
  }
});

function shutdown() {
  if (backupTimer) clearInterval(backupTimer);
  if (limiterTimer) clearInterval(limiterTimer);
  server.close();
  db.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
