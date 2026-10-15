const { app, BrowserWindow, ipcMain, nativeTheme, dialog, shell, Tray, Menu, nativeImage, Notification, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { SerialPort, ReadlineParser } = require('serialport');
const Database = require('better-sqlite3');
const { initSchema, logEvent } = require('./db-schema');
const { initAuth, getSessionUser } = require('./auth');
const { registerAiIpc } = require('./ai-assistant');
const { registerMcpBridge } = require('./mcp-bridge');
const { autoUpdater } = require('electron-updater');
const { createUpdateController } = require('./update-controller');
const { createTeamServer } = require('./server-embed');
const { createDiscovery } = require('./mdns');

/* 自动更新配置 */
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

// 全局变量
let mainWindow = null;
let tray = null;
let isQuitting = false;
let updateNotifyEnabled = true; // 更新系统通知开关
let db = null;
const activePorts = new Map(); // portPath -> { port, parser }

// 多实例隔离：--instance=名称 为每个实例分配独立的数据目录
// （Chromium 缓存 + 本地数据库/草稿 + 登录会话各自独立），
// 同一台电脑可双开不同账号互不干扰；不传参数时行为与单实例完全一致
const instanceArg = process.argv.slice(1).find(a => a.startsWith('--instance='));
const INSTANCE_NAME = instanceArg
  ? instanceArg.slice('--instance='.length).trim().replace(/[^0-9A-Za-z_-]/g, '').slice(0, 32)
  : '';
if (INSTANCE_NAME) {
  /* 必须在 ready 之前设置：Chromium 缓存/会话路径由此决定（解决双开时 cache 拒绝访问） */
  app.setPath('userData', path.join(app.getPath('userData'), 'instances', INSTANCE_NAME));
}

// 数据目录：打包后 app.asar 为只读，数据存入用户数据目录；开发环境保持项目 data/
// 多实例时本地数据（数据库/草稿/会话）落在 data/instances/<名称>/ 下各自独立
const baseDataDir = app.isPackaged
  ? path.join(app.getPath('userData'), 'data')
  : path.join(__dirname, 'data');
const defaultDataDir = INSTANCE_NAME
  ? path.join(baseDataDir, 'instances', INSTANCE_NAME)
  : baseDataDir;

/* 用户自定义的数据/数据库保存目录（更新下载时可浏览选择）。
 * 指针文件固定放在 userData 下：不能放进数据目录，否则换到新目录后旧指针就跟着搬走了。
 * 目标必须仍存在且是目录才生效，否则回退默认目录，避免数据库落到一个已不存在的路径。 */
const dataDirPointerPath = path.join(app.getPath('userData'), 'data-dir.json');
function readCustomDataDir() {
  try {
    if (fs.existsSync(dataDirPointerPath)) {
      const parsed = JSON.parse(fs.readFileSync(dataDirPointerPath, 'utf-8')) || {};
      const dir = String(parsed.dataDir || '').trim();
      if (dir && fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return dir;
      if (dir) console.warn('[DB] 自定义数据目录不可用，回退默认:', dir);
    }
  } catch (e) {
    console.warn('[DB] 读取自定义数据目录失败:', e.message);
  }
  return '';
}
const customDataDir = readCustomDataDir();
const dataDir = customDataDir || defaultDataDir;

// ---------------------------------------------------------------------------
// 数据库初始化
// ---------------------------------------------------------------------------
function initDatabase() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  const dbPath = path.join(dataDir, 'serial_protocol.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  /* 表结构与默认数据（与团队服务器 server.js 共享同一份 schema） */
  initSchema(db);

  /* 写入启动日志 */
  logEvent(db, 'info', 'system', 'main', `应用启动 v${app.getVersion()}${INSTANCE_NAME ? ` (实例 ${INSTANCE_NAME})` : ''}`);

  /* 清空 serial_logs 中的旧假数据 */
  db.prepare('DELETE FROM serial_logs').run();

  if (INSTANCE_NAME) console.log('[DB] 多实例模式:', INSTANCE_NAME, '→ 独立数据目录', dataDir);
  console.log('[DB] 初始化完成:', dbPath);
}

// ---------------------------------------------------------------------------
// 数据源模式：本地 SQLite / 团队服务器（远程 HTTP 转发）
// ---------------------------------------------------------------------------
let dbMode = 'remote'; // 'local' | 'remote'（默认团队模式，未配置服务器地址时实际走本地）
let remoteDb = { url: '', token: '' };
/* 数据源配置全实例共享（存基础数据目录）：双开实例连接同一台服务器，无需各自配置 */
const dbConfigPath = path.join(baseDataDir, 'db-config.json');

// 实际生效的数据源：团队模式必须已配置服务器地址
function isRemoteActive() {
  return dbMode === 'remote' && /^https?:\/\//.test(remoteDb.url);
}

function loadDbConfig() {
  try {
    if (fs.existsSync(dbConfigPath)) {
      const cfg = JSON.parse(fs.readFileSync(dbConfigPath, 'utf-8'));
      dbMode = cfg.mode === 'remote' ? 'remote' : 'local';
      remoteDb = { url: String(cfg.url || ''), token: String(cfg.token || '') };
      console.log('[DB] 数据源模式:', dbMode, dbMode === 'remote' ? remoteDb.url : '');
    }
  } catch (e) {
    console.warn('[DB] 读取数据源配置失败:', e.message);
  }
}

function persistDbConfig() {
  try {
    fs.mkdirSync(path.dirname(dbConfigPath), { recursive: true });
    fs.writeFileSync(dbConfigPath, JSON.stringify({
      mode: dbMode,
      url: remoteDb.url,
      token: remoteDb.token,
    }, null, 2));
  } catch (e) {
    console.warn('[DB] 写入数据源配置失败:', e.message);
  }
}

// ---------------------------------------------------------------------------
// 离线修改标记（防脑裂）：服务器不可达回退本地期间，追踪有业务意义的本地写入。
// 标记持久化到 data/offline-mark.json，跨会话存活；服务器恢复后启动时据此提醒
// 用户"本地有未合并到团队服务器的修改"，避免离线修改被静默遗忘。
// ---------------------------------------------------------------------------
const offlineMarkPath = path.join(dataDir, 'offline-mark.json');
let offlineMark = null; // { pending, since, writes, lastWriteAt, tables: { 表名: 语句数 } }

function loadOfflineMark() {
  try {
    if (fs.existsSync(offlineMarkPath)) {
      offlineMark = JSON.parse(fs.readFileSync(offlineMarkPath, 'utf-8'));
    }
  } catch (e) {
    console.warn('[DB] 读取离线修改标记失败:', e.message);
    offlineMark = null;
  }
}

function saveOfflineMark() {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(offlineMarkPath, JSON.stringify(offlineMark, null, 2));
  } catch (e) {
    console.warn('[DB] 写入离线修改标记失败:', e.message);
  }
}

/* 计入标记的业务表（serial_logs 通信日志每次收发都写，不计入） */
const OFFLINE_TRACK_TABLES = new Set(['protocols', 'commands', 'modules', 'protocol_versions', 'audit_logs', 'users', 'roles']);

/** 从 SQL 提取写入目标表名；非写入语句返回 null */
function extractWriteTable(sql) {
  const m = /^\s*(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+["'`\[]?(\w+)/i.exec(sql || '');
  return m ? m[1].toLowerCase() : null;
}

/** 本地写入成功后调用：目标表在白名单内则计数（内存 + 落盘）
 *  表级明细（tables: { 表名: 语句数 }）供离线横幅展示，用户可据此判断
 *  需要合并哪些数据，而不是只看到一个总数 */
function trackOfflineWrite(sqls) {
  if (!offlineMark || !offlineMark.pending) return;
  const list = Array.isArray(sqls) ? sqls : [sqls];
  const tableCounts = {};
  let touched = false;
  for (const s of list) {
    const table = extractWriteTable(typeof s === 'string' ? s : s.sql);
    if (table && OFFLINE_TRACK_TABLES.has(table)) {
      tableCounts[table] = (tableCounts[table] || 0) + 1;
      touched = true;
    }
  }
  if (!touched) return;
  if (!offlineMark.tables || typeof offlineMark.tables !== 'object') offlineMark.tables = {};
  for (const [table, n] of Object.entries(tableCounts)) {
    offlineMark.tables[table] = (offlineMark.tables[table] || 0) + n;
  }
  offlineMark.writes += 1;
  offlineMark.lastWriteAt = Date.now();
  saveOfflineMark();
}

/**
 * 向团队服务器发送请求（15 秒超时）
 * 返回值结构与本地 db 操作一致，渲染层无感知
 */
async function remoteDbRequest(endpoint, body) {
  const base = remoteDb.url.replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json' };
  if (remoteDb.token) headers['Authorization'] = `Bearer ${remoteDb.token}`;
  /* 网关身份透传（修复报告问题 #2）：写端点由服务端校验 X-User + X-User-Token，
   * 操作人身份与令牌均来自主进程会话，渲染层无法伪造/篡改 */
  const sessionUser = getSessionUser();
  if (sessionUser?.username) headers['X-User'] = sessionUser.username;
  if (sessionUser?.token) headers['X-User-Token'] = sessionUser.token;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(base + endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const j = await res.json();
        if (j && j.error) detail = j.error;
      } catch { /* 忽略非 JSON 响应 */ }
      return { success: false, error: `团队服务器请求失败: ${detail}` };
    }
    return await res.json();
  } catch (e) {
    const msg = e.name === 'AbortError'
      ? '连接团队服务器超时（15 秒）'
      : `无法连接团队服务器: ${e.message}`;
    return { success: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/* ===================== 串口日志批量写入 =====================
 * 修复报告问题：串口 data 回调高频触发，逐条 INSERT 同步落库会拖慢主进程事件循环
 * （高波特率下每秒数百次 fsync）。改为内存缓冲 + 定时/定量批量落库：
 *   - 每 1 秒 或 缓冲满 500 条 时单事务批量写入
 *   - 应用退出/串口关闭前强制 flush，保证不丢尾部数据
 */
const SERIAL_LOG_FLUSH_MS = 1000;
const SERIAL_LOG_MAX_BUFFER = 500;
let serialLogBuffer = [];
let serialLogTimer = null;
let serialLogStmt = null;
let serialLogTx = null;

function enqueueSerialLog(portPath, direction, dataHex, dataText) {
  if (!db) return;
  serialLogBuffer.push([portPath, direction, dataHex, dataText]);
  if (serialLogBuffer.length >= SERIAL_LOG_MAX_BUFFER) {
    flushSerialLogs();
    return;
  }
  if (!serialLogTimer) {
    serialLogTimer = setTimeout(flushSerialLogs, SERIAL_LOG_FLUSH_MS);
  }
}

function flushSerialLogs() {
  if (serialLogTimer) {
    clearTimeout(serialLogTimer);
    serialLogTimer = null;
  }
  if (!db || serialLogBuffer.length === 0) return;
  const batch = serialLogBuffer;
  serialLogBuffer = [];
  try {
    if (!serialLogStmt) {
      serialLogStmt = db.prepare('INSERT INTO serial_logs (port_path, direction, data_hex, data_text) VALUES (?, ?, ?, ?)');
      serialLogTx = db.transaction((rows) => {
        for (const r of rows) serialLogStmt.run(...r);
      });
    }
    serialLogTx(batch);
  } catch (e) {
    console.error('[DB] 批量写入串口日志失败:', e.message);
  }
}

/* ===================== 内容安全策略（CSP）=====================
 * 修复报告问题：渲染进程此前无 CSP，一旦发生 XSS，注入脚本可外连任意源窃取数据。
 * 生产模式注入严格策略：
 *   - script-src 'self'：脚本只允许应用自身，杜绝内联/eval 注入
 *   - connect-src 'self'：渲染层禁止直连外部网络（远程请求全部经主进程 IPC）
 *   - 样式/字体仅放开 Google Fonts（index.html 引用）
 * 开发模式跳过（Vite HMR 依赖 ws://localhost 与内联脚本）。
 */
function installCsp() {
  if (process.argv.includes('--dev') || !app.isPackaged) return;
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
  ].join('; ');
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });
}

// ---------------------------------------------------------------------------
// 窗口创建
// ---------------------------------------------------------------------------
function createWindow() {
  /* 检测是否为开机自启（隐藏启动） */
  const isAutoLaunch = process.argv.includes('--hidden') || process.argv.includes('--systray');

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    frame: false,
    transparent: false,
    backgroundColor: '#11131a',
    titleBarStyle: 'hidden',
    icon: path.join(__dirname, 'assets', 'app.ico'),
    show: !isAutoLaunch, // 开机自启时先不显示
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  // Vite 集成：dev 模式加载开发服务器，生产模式加载构建产物
  const isDev = process.argv.includes('--dev');
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, 'dist', 'renderer', 'index.html'));
  }

  // 生产模式下按 F12 打开开发者工具
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12') {
      mainWindow.webContents.toggleDevTools();
    }
  });

  /* 多实例：标题追加实例名，便于区分同开的多个窗口 */
  if (INSTANCE_NAME) {
    const titledTitle = `串口协议管理工具 · ${INSTANCE_NAME}`;
    mainWindow.setTitle(titledTitle);
    mainWindow.on('page-title-updated', (e) => {
      e.preventDefault();
      mainWindow.setTitle(titledTitle);
    });
  }

  /* 关闭按钮 → 最小化到托盘，不退出 */
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      if (mainWindow.isFullScreen()) {
        mainWindow.setFullScreen(false);
      }
      mainWindow.hide();
      showTrayBalloon('已最小化到托盘', '程序继续在后台运行，点击托盘图标恢复窗口');
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/* ── 系统托盘 ── */
function createTray() {
  if (tray) return;

  const iconPath = path.join(__dirname, 'assets', 'app.ico');
  let trayIcon;
  try {
    trayIcon = nativeImage.createFromPath(iconPath);
    if (trayIcon.isEmpty()) {
      trayIcon = nativeImage.createEmpty();
    }
  } catch (_) {
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  tray.setToolTip(INSTANCE_NAME ? `BaudLab · ${INSTANCE_NAME}` : 'BaudLab');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '打开主窗口',
      click: () => showMainWindow(),
    },
    { type: 'separator' },
    {
      label: '检查更新',
      click: () => {
        showMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('tray:check-update');
        }
      },
    },
    { type: 'separator' },
    {
      label: '退出程序',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  /* 左键单击显示/隐藏窗口 */
  tray.on('click', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        showMainWindow();
      }
    }
  });

  /* 双击也显示窗口 */
  tray.on('double-click', () => {
    showMainWindow();
  });
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  mainWindow.show();
  mainWindow.focus();
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
}

function showTrayBalloon(title, content) {
  if (!tray) return;
  /* Windows 上优先使用系统通知 */
  if (Notification.isSupported()) {
    const n = new Notification({
      title: title,
      body: content,
      icon: path.join(__dirname, 'assets', 'app.ico'),
      silent: false,
    });
    n.on('click', () => showMainWindow());
    n.show();
  } else {
    try {
      tray.displayBalloon({
        title: title,
        content: content,
        icon: path.join(__dirname, 'assets', 'app.ico'),
      });
      tray.once('balloon-click', () => showMainWindow());
    } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// 串口 IPC
// ---------------------------------------------------------------------------

// 列出可用串口
ipcMain.handle('serial:list', async () => {
  try {
    const ports = await SerialPort.list();
    return ports.map(p => ({
      path: p.path,
      manufacturer: p.manufacturer || '',
      vendorId: p.vendorId || '',
      productId: p.productId || ''
    }));
  } catch (err) {
    console.error('[Serial] 列出串口失败:', err);
    return [];
  }
});

/**
 * 刷新串口列表并通过 IPC 推送给渲染进程
 */
async function refreshAndNotifyPorts() {
  try {
    const ports = await SerialPort.list();
    const portList = ports.map(p => ({
      path: p.path,
      manufacturer: p.manufacturer || '',
      vendorId: p.vendorId || '',
      productId: p.productId || '',
    }));
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('serial:ports-changed', portList);
    }
  } catch {
    /* ignore */
  }
}

/* 串口热插拔检测：低频轮询 + diff 对比，仅在端口列表变化时推送 */
let lastPortPaths = '';
let portPollTimer = null;

async function checkPortChange() {
  try {
    const ports = await SerialPort.list();
    const currentPaths = ports.map(p => p.path).sort().join(',');
    if (currentPaths !== lastPortPaths) {
      lastPortPaths = currentPaths;
      const portList = ports.map(p => ({
        path: p.path,
        manufacturer: p.manufacturer || '',
        vendorId: p.vendorId || '',
        productId: p.productId || '',
      }));
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('serial:ports-changed', portList);
      }
    }
  } catch {
    /* ignore */
  }
}

/* 窗口创建后启动轮询 */
app.on('ready', () => {
  /* 初始记录一次端口列表 */
  SerialPort.list().then(ports => {
    lastPortPaths = ports.map(p => p.path).sort().join(',');
  }).catch(() => {});

  /* 每 2 秒检测一次端口变化，仅在列表变化时推送 IPC */
  portPollTimer = setInterval(checkPortChange, 2000);
});

app.on('before-quit', () => {
  isQuitting = true;
  if (portPollTimer) clearInterval(portPollTimer);
  stopAutoUpdateCheck();
  stopSsePush();

  // 停止内嵌团队服务器 + 撤销 mDNS 广播（同步发出 kill，stdin 管道关闭兜底）
  try { teamServer.stop(); } catch (_) {}
  try { discovery.destroy(); } catch (_) {}

  // 关闭 MCP 桥（清理 mcp-bridge.json 并释放端口）
  if (mcpBridgeHandle) {
    try { mcpBridgeHandle.stop(); } catch (_) {}
    mcpBridgeHandle = null;
  }

  // 关闭所有串口
  for (const [path, entry] of activePorts) {
    try { entry.port.close(); } catch (_) {}
  }
  activePorts.clear();

  // 关闭数据库前先落盘串口日志缓冲，避免丢失最后 1 秒内的通信记录
  flushSerialLogs();

  // 关闭数据库
  if (db) {
    db.close();
    db = null;
  }

  if (tray) {
    tray.destroy();
    tray = null;
  }
});

// 打开串口
/* MCP 等帧钩子：serial_wait_frame 工具登记等待者，RX 数据到达时按序喂给 */
const mcpRxWaiters = [];

function feedSerialWaiters(portPath, data) {
  if (!mcpRxWaiters.length) return;
  const hex = Buffer.from(data).toString('hex').match(/.{1,2}/g).join(' ').toUpperCase();
  for (const w of mcpRxWaiters.slice()) {
    if (w.portPath === portPath) w.resolve({ hex });
  }
}

function mcpWaitForRx(portPath, timeoutMs) {
  return new Promise((resolve) => {
    const waiter = { portPath, resolve: null, timer: null };
    const finish = (v) => {
      const i = mcpRxWaiters.indexOf(waiter);
      if (i >= 0) mcpRxWaiters.splice(i, 1);
      if (waiter.timer) clearTimeout(waiter.timer);
      resolve(v);
    };
    waiter.resolve = finish;
    waiter.timer = setTimeout(() => finish(null), Math.max(100, Math.min(timeoutMs || 2000, 130000)));
    mcpRxWaiters.push(waiter);
  });
}

/* MCP 写操作确认策略：用户勾选"不再询问"后记住"允许执行"选择。
 * 存储 <数据目录>/mcp-policy.json，键为操作维度（如 serial_send:COM1），
 * 可在系统设置 → MCP 接入面板重置 */
let mcpPolicyCache = null;
function loadMcpPolicy() {
  if (mcpPolicyCache) return mcpPolicyCache;
  try { mcpPolicyCache = JSON.parse(fs.readFileSync(path.join(dataDir, 'mcp-policy.json'), 'utf8')) || {}; }
  catch { mcpPolicyCache = {}; }
  return mcpPolicyCache;
}
function saveMcpPolicy(policy) {
  mcpPolicyCache = policy;
  try { fs.writeFileSync(path.join(dataDir, 'mcp-policy.json'), JSON.stringify(policy, null, 2)); } catch { /* 写失败仅影响记忆 */ }
}

/* MCP 写操作人工确认：向渲染层发起自绘确认弹窗（与应用风格一致），
 * 30 秒无响应视为拒绝；应用最小化时闪烁任务栏图标提醒。
 * question.policyKey 已记住"允许"时直接放行；勾选"不再询问"+允许 会记住（拒绝不记忆） */
let mcpConfirmSeq = 0;
const mcpConfirmPending = new Map();

ipcMain.handle('mcp:confirm-response', (_e, { id, allowed, remember } = {}) => {
  const pending = mcpConfirmPending.get(id);
  if (!pending) return { success: false };
  mcpConfirmPending.delete(id);
  try { mainWindow?.flashFrame(false); } catch { /* ignore */ }
  if (allowed && remember && pending.policyKey) {
    saveMcpPolicy({ ...loadMcpPolicy(), [pending.policyKey]: 'allow' });
  }
  pending.resolve(!!allowed);
  return { success: true };
});

function confirmInWindow(question) {
  const { title, message, detail, policyKey, checkboxLabel } = question || {};
  return new Promise((resolve) => {
    if (policyKey && loadMcpPolicy()[policyKey] === 'allow') {
      resolve(true);
      return;
    }
    if (!mainWindow || mainWindow.isDestroyed()) {
      resolve(false);
      return;
    }
    const id = `mcp-confirm-${Date.now()}-${++mcpConfirmSeq}`;
    const timer = setTimeout(() => {
      const pending = mcpConfirmPending.get(id);
      if (pending) {
        mcpConfirmPending.delete(id);
        try { mainWindow?.flashFrame(false); } catch { /* ignore */ }
        pending.resolve(false);
      }
    }, 30000);
    mcpConfirmPending.set(id, { policyKey, resolve: (v) => { clearTimeout(timer); resolve(v); } });
    mainWindow.webContents.send('mcp:confirm-request', {
      id,
      title: title || 'MCP 操作确认',
      message: message || '允许执行？',
      detail: detail || '',
      checkboxLabel: checkboxLabel || '记住"允许执行"，此后不再询问',
    });
    try { mainWindow.flashFrame(true); } catch { /* ignore */ }
  });
}

/* 打开串口设备：IPC 与 MCP 桥共用；等待 open 回调拿到真实结果。
 * source='mcp' 时向渲染层广播打开事件，调试页据此镜像出 AI 的会话 */
async function openSerialDevice({ portPath, baudRate, dataBits, stopBits, parity, source }) {
  if (activePorts.has(portPath)) {
    return { success: false, error: '端口已打开' };
  }

  try {
    const port = new SerialPort({
      path: portPath,
      baudRate: baudRate || 115200,
      dataBits: dataBits || 8,
      stopBits: stopBits || 1,
      parity: parity || 'none',
      autoOpen: false
    });

    const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));

    port.on('error', (err) => {
      console.error(`[Serial] ${portPath} 错误:`, err.message);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('serial:error', { port: portPath, error: err.message });
      }
    });

    port.on('data', (data) => {
      const hex = data.toString('hex').match(/.{1,2}/g).join(' ').toUpperCase();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('serial:data', {
          port: portPath,
          hex: hex,
          length: data.length
        });
      }

      // 喂给 MCP 的等待帧钩子（无等待者时为空操作）
      feedSerialWaiters(portPath, data);

      // 写入数据库日志（批量缓冲，定时落库）
      enqueueSerialLog(portPath, 'rx', hex, data.toString('utf8'));
    });

    const opened = await new Promise((resolve) => {
      port.open((err) => resolve(err || null));
    });
    if (opened) {
      console.error(`[Serial] 打开 ${portPath} 失败:`, opened.message);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('serial:error', { port: portPath, error: opened.message });
      }
      return { success: false, error: opened.message };
    }

    console.log(`[Serial] ${portPath} 已打开${source === 'mcp' ? '（MCP）' : ''}`);
    activePorts.set(portPath, { port, parser, source: source || 'ui' });
    if (source === 'mcp' && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('serial:mcp-opened', {
        port: portPath, baudRate: baudRate || 115200, dataBits: dataBits || 8, stopBits: stopBits || 1, parity: parity || 'none',
      });
    }
    return { success: true, baudRate: baudRate || 115200, dataBits: dataBits || 8, stopBits: stopBits || 1, parity: parity || 'none' };
  } catch (err) {
    console.error(`[Serial] 打开 ${portPath} 异常:`, err);
    return { success: false, error: err.message };
  }
}

ipcMain.handle('serial:open', async (event, options) => {
  const { path: portPath, baudRate, dataBits, stopBits, parity } = options;
  return openSerialDevice({ portPath, baudRate, dataBits, stopBits, parity });
});

/* 关闭串口设备：IPC 与 MCP 桥共用。
 * 关闭的是 MCP 打开的端口且由 MCP 发起时，广播给调试页同步会话状态 */
function closeSerialDevice(portPath, source) {
  const entry = activePorts.get(portPath);
  if (!entry) {
    return { success: false, error: '端口未打开' };
  }

  try {
    entry.port.close();
    activePorts.delete(portPath);
    console.log(`[Serial] ${portPath} 已关闭${entry.source === 'mcp' ? '（MCP）' : ''}`);
    if (entry.source === 'mcp' && source === 'mcp' && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('serial:mcp-closed', { port: portPath });
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

ipcMain.handle('serial:close', async (event, portPath) => {
  return closeSerialDevice(portPath);
});

/* 发送数据：IPC 与 MCP 桥共用。MCP 发送广播给调试页，终端里能看到 AI 发的帧 */
function sendSerialData({ portPath, data, format, source }) {
  const entry = activePorts.get(portPath);
  if (!entry) {
    return { success: false, error: '端口未打开' };
  }

  try {
    let buffer;
    if (format === 'hex') {
      // 去除空格后校验：必须为偶数位纯十六进制
      // Buffer.from 对奇数位会静默截断末尾字符（"440" 只发 44），必须拦截
      const hexStr = data.replace(/\s/g, '');
      if (!/^[0-9a-fA-F]+$/.test(hexStr) || hexStr.length % 2 !== 0) {
        return { success: false, error: `HEX 数据无效（需偶数位纯十六进制，如 04 40）: ${data}` };
      }
      buffer = Buffer.from(hexStr, 'hex');
    } else {
      buffer = Buffer.from(data, 'utf8');
    }

    entry.port.write(buffer, (err) => {
      if (err) {
        console.error(`[Serial] 发送到 ${portPath} 失败:`, err.message);
      }
    });

    // 写入数据库日志（批量缓冲，定时落库）
    const hex = buffer.toString('hex').match(/.{1,2}/g).join(' ').toUpperCase();
    enqueueSerialLog(portPath, 'tx', hex, data);

    // MCP 发送实时镜像到调试页（渲染层自己的发送由渲染层自行入账，避免重复）
    if (source === 'mcp' && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('serial:mcp-tx', { port: portPath, hex, length: buffer.length });
    }

    return { success: true, bytesWritten: buffer.length };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// 发送数据
ipcMain.handle('serial:send', async (event, { portPath, data, format }) => {
  return sendSerialData({ portPath, data, format });
});

// MCP 打开的串口列表（调试页挂载时重同步镜像会话）
ipcMain.handle('serial:mcp-ports', async () => {
  return Array.from(activePorts.entries())
    .filter(([, entry]) => entry.source === 'mcp')
    .map(([portPath, entry]) => ({
      port: portPath,
      baudRate: entry.port?.baudRate || 115200,
      dataBits: entry.port?.dataBits || 8,
      stopBits: entry.port?.stopBits || 1,
      parity: entry.port?.parity || 'none',
    }));
});

// 获取所有活跃端口
ipcMain.handle('serial:active', async () => {
  return Array.from(activePorts.keys());
});

// ---------------------------------------------------------------------------
// 数据库 IPC（本地 SQLite 直连 / 团队服务器 HTTP 转发，渲染层无感知）
// ---------------------------------------------------------------------------

// 执行查询（只读）：本地 SQLite / 团队服务器统一入口（AI 工具调用也走这里）
async function queryDatabase(sql, params = []) {
  if (isRemoteActive()) return remoteDbRequest('/api/query', { sql, params });
  if (!db) return { success: false, error: '数据库未初始化' };
  try {
    const stmt = db.prepare(sql);
    const rows = stmt.all(...params);
    return { success: true, rows };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

ipcMain.handle('db:query', async (event, { sql, params }) => queryDatabase(sql, params));

// 执行写入
ipcMain.handle('db:execute', async (event, { sql, params }) => {
  if (isRemoteActive()) return remoteDbRequest('/api/execute', { sql, params });
  if (!db) return { success: false, error: '数据库未初始化' };
  try {
    const stmt = db.prepare(sql);
    const result = stmt.run(...(params || []));
    trackOfflineWrite(sql); // 离线追踪：业务表写入计数（serial_logs 等日志表不计入）
    return { success: true, changes: result.changes, lastInsertRowid: result.lastInsertRowid };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 批量执行
// 每条语句支持可选的 expectChanges 字段（CAS 乐观锁校验）：
//   实际影响行数与预期不符时抛错，整个事务回滚，用于关闭"检查-写入"竞态窗口
//   错误信息带 CAS_CONFLICT: 前缀，渲染层据此区分冲突与其他故障
ipcMain.handle('db:batch', async (event, statements) => {
  if (isRemoteActive()) return remoteDbRequest('/api/batch', { statements });
  if (!db) return { success: false, error: '数据库未初始化' };
  try {
    const transaction = db.transaction((stmts) => {
      const results = [];
      for (const { sql, params, expectChanges } of stmts) {
        const result = db.prepare(sql).run(...(params || []));
        if (expectChanges !== undefined && result.changes !== expectChanges) {
          throw new Error(`CAS_CONFLICT: 语句影响 ${result.changes} 行，预期 ${expectChanges} 行（数据已被其他用户/窗口修改）`);
        }
        results.push({ changes: result.changes, lastInsertRowid: result.lastInsertRowid });
      }
      return results;
    });
    const results = transaction(statements);
    trackOfflineWrite(statements); // 离线追踪：本事务含业务表写入则计 1 次
    return { success: true, results };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

/* ---- 协议草稿（远程模式下本地暂存，审核通过后发布到服务器） ---- */

/**
 * 保存协议草稿到本地数据库（远程模式下使用，不写入服务器）
 * 接收与 saveConfig 相同的 statements 数组，本地事务写入
 */
ipcMain.handle('draft:save', async (event, { statements, protoName }) => {
  if (!db) return { success: false, error: '数据库未初始化' };
  try {
    const transaction = db.transaction((stmts) => {
      const results = [];
      for (const { sql, params, expectChanges } of stmts) {
        const result = db.prepare(sql).run(...(params || []));
        if (expectChanges !== undefined && result.changes !== expectChanges) {
          throw new Error(`CAS_CONFLICT: 语句影响 ${result.changes} 行，预期 ${expectChanges} 行`);
        }
        results.push({ changes: result.changes, lastInsertRowid: result.lastInsertRowid });
      }
      return results;
    });
    const results = transaction(statements);
    /* 草稿标记：用 created_by 字段的前缀标识草稿（不新增表字段，最小侵入） */
    try {
      db.prepare("UPDATE protocols SET created_by = 'draft:' || COALESCE(created_by, '') WHERE name = ?").run(protoName);
    } catch { /* 忽略：旧 schema 可能无 created_by 字段 */ }
    return { success: true, results };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

/**
 * 列出所有本地草稿（协议名列表）
 */
ipcMain.handle('draft:list', async () => {
  if (!db) return { success: false, error: '数据库未初始化', rows: [] };
  try {
    const rows = db.prepare(`
      SELECT p.id, p.name, p.version, p.byte_order, p.check_method, p.check_start, p.check_end, p.config_json, p.created_at, p.updated_at
      FROM protocols p
      ORDER BY p.name
    `).all();
    return { success: true, rows };
  } catch (err) {
    return { success: false, error: err.message, rows: [] };
  }
});

/**
 * 获取单个草稿详情（含命令字、模块地址）
 */
ipcMain.handle('draft:get', async (event, name) => {
  if (!db) return { success: false, error: '数据库未初始化' };
  try {
    const proto = db.prepare('SELECT * FROM protocols WHERE name = ?').get(name);
    if (!proto) return { success: false, error: '草稿不存在' };
    const commands = db.prepare('SELECT * FROM commands WHERE protocol_id = ? ORDER BY id').all(proto.id);
    const modules = db.prepare('SELECT * FROM modules WHERE protocol_id = ? ORDER BY id').all(proto.id);
    return { success: true, proto, commands, modules };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

/**
 * 删除本地草稿
 */
ipcMain.handle('draft:delete', async (event, name) => {
  if (!db) return { success: false, error: '数据库未初始化' };
  try {
    const proto = db.prepare('SELECT id FROM protocols WHERE name = ?').get(name);
    if (proto) {
      db.prepare('DELETE FROM commands WHERE protocol_id = ?').run(proto.id);
      db.prepare('DELETE FROM modules WHERE protocol_id = ?').run(proto.id);
      db.prepare('DELETE FROM protocols WHERE id = ?').run(proto.id);
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

/**
 * 发布草稿到服务器（审核通过后调用）
 * 将本地草稿的完整内容推送到服务器数据库
 */
/* 发布草稿到团队服务器：IPC 与 MCP 桥共用（仅远程数据源模式） */
async function publishDraft(name) {
  if (!isRemoteActive()) return { success: false, error: '仅远程模式下可发布草稿' };
  if (!db) return { success: false, error: '数据库未初始化' };
  try {
    /* 1. 从本地读取草稿完整内容 */
    const proto = db.prepare('SELECT * FROM protocols WHERE name = ?').get(name);
    if (!proto) return { success: false, error: '草稿不存在' };
    const commands = db.prepare('SELECT * FROM commands WHERE protocol_id = ? ORDER BY id').all(proto.id);
    const modules = db.prepare('SELECT * FROM modules WHERE protocol_id = ? ORDER BY id').all(proto.id);

    /* 2. 构造服务器端写入语句（先删除同名旧协议，再插入新的） */
    const statements = [];
    /* 使用子查询删除旧协议的子表数据 */
    statements.push({ sql: 'DELETE FROM commands WHERE protocol_id IN (SELECT id FROM protocols WHERE name = ?)', params: [name] });
    statements.push({ sql: 'DELETE FROM modules WHERE protocol_id IN (SELECT id FROM protocols WHERE name = ?)', params: [name] });
    statements.push({ sql: 'DELETE FROM protocols WHERE name = ?', params: [name] });
    /* 插入新协议 */
    statements.push({
      sql: `INSERT INTO protocols (name, version, byte_order, check_method, check_start, check_end, config_json)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      params: [proto.name, proto.version, proto.byte_order, proto.check_method, proto.check_start, proto.check_end, proto.config_json],
    });
    /* 插入命令字 */
    for (const cmd of commands) {
      statements.push({
        sql: `INSERT INTO commands (protocol_id, code, name, sender, receiver, period_ms, direction, config_json)
              VALUES ((SELECT id FROM protocols WHERE name = ?), ?, ?, ?, ?, ?, ?, ?)`,
        params: [proto.name, cmd.code, cmd.name, cmd.sender || '', cmd.receiver || '', cmd.period_ms || 0, cmd.direction || 'send', cmd.config_json],
      });
    }
    /* 插入模块地址 */
    for (const mod of modules) {
      statements.push({
        sql: 'INSERT INTO modules (protocol_id, name, address) VALUES ((SELECT id FROM protocols WHERE name = ?), ?, ?)',
        params: [proto.name, mod.name, mod.address],
      });
    }

    /* 3. 提交到服务器 */
    const result = await remoteDbRequest('/api/batch', { statements });
    return result;
  } catch (err) {
    return { success: false, error: err.message };
  }
}

ipcMain.handle('draft:publish', async (event, name) => publishDraft(name));

/* ---- 管理员：数据库管理 IPC ---- */

// 手动备份（VACUUM INTO 创建一致性快照）
/* 数据库备份：IPC 与 MCP 桥共用（VACUUM INTO，不影响现有连接） */
async function backupDatabase() {
  if (!db) return { success: false, error: '数据库未初始化' };
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupPath = path.join(dataDir, `backup-${ts}.db`);
    db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
    const stat = fs.statSync(backupPath);
    return { success: true, path: backupPath, size: stat.size, time: stat.mtime.toISOString() };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

ipcMain.handle('db:backup', async () => backupDatabase());

// 数据库统计（表名 + 行数 + 大小估算）
ipcMain.handle('db:stats', async () => {
  if (!db) return { success: false, error: '数据库未初始化' };
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const stats = tables.map(t => {
      const count = db.prepare(`SELECT COUNT(*) as cnt FROM "${t.name}"`).get();
      return { name: t.name, rows: count.cnt };
    });
    const dbPath = path.join(dataDir, 'serial_protocol.db');
    let dbSize = 0;
    try { dbSize = fs.statSync(dbPath).size; } catch {}
    return { success: true, tables: stats, dbSize };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 备份文件列表
ipcMain.handle('db:backup-list', async () => {
  try {
    const files = fs.readdirSync(dataDir)
      .filter(f => /^backup-.+\.db$/.test(f))
      .map(f => {
        const fp = path.join(dataDir, f);
        const stat = fs.statSync(fp);
        return { name: f, size: stat.size, time: stat.mtime.toISOString() };
      })
      .sort((a, b) => b.time.localeCompare(a.time));
    return { success: true, backups: files };
  } catch (err) {
    return { success: false, error: err.message, backups: [] };
  }
});

/* =========================================================================
 * 数据/数据库保存目录：查询、浏览选择、切换（重启应用后生效）
 * ===================================================================== */

/* 把当前数据迁到用户选定目录。
 * 数据库运行期间是打开的，直接复制 .db/.wal 会拿到不一致副本，
 * 因此用 VACUUM INTO 生成一致性快照；草稿/配置/令牌等其余文件直接复制。
 * 目标目录里已存在的同名文件一律保留，绝不覆盖用户已有数据。 */
function migrateDataTo(targetDir) {
  const notes = [];
  const skipped = [];
  fs.mkdirSync(targetDir, { recursive: true });

  const targetDb = path.join(targetDir, 'serial_protocol.db');
  if (fs.existsSync(targetDb)) {
    notes.push('目标目录已有数据库文件，已直接使用它（未覆盖）');
  } else if (db) {
    db.exec(`VACUUM INTO '${targetDb.replace(/'/g, "''")}'`);
    notes.push('已生成数据库快照 serial_protocol.db');
  } else {
    notes.push('数据库尚未初始化，未生成快照');
  }

  for (const name of fs.readdirSync(dataDir)) {
    /* 数据库本体与 wal/shm 由上面的快照逻辑负责，不能直接搬 */
    if (name.startsWith('serial_protocol.db')) continue;
    const src = path.join(dataDir, name);
    const dst = path.join(targetDir, name);
    try {
      if (fs.existsSync(dst)) { skipped.push(name); continue; }
      const stat = fs.statSync(src);
      if (stat.isDirectory()) fs.cpSync(src, dst, { recursive: true });
      else fs.copyFileSync(src, dst);
    } catch (e) {
      console.warn('[DB] 迁移数据文件失败:', name, e.message);
    }
  }
  if (skipped.length) notes.push(`保留了 ${skipped.length} 个同名文件（未覆盖）`);
  return notes;
}

ipcMain.handle('data-dir:get', () => ({
  success: true,
  dataDir,
  defaultDir: defaultDataDir,
  custom: !!customDataDir,
}));

/* 浏览：打开系统文件夹选择器 */
ipcMain.handle('data-dir:choose', async () => {
  try {
    const opts = {
      title: '选择协议数据与数据库的保存目录',
      defaultPath: dataDir,
      properties: ['openDirectory', 'createDirectory'],
    };
    const { canceled, filePaths } = (mainWindow && !mainWindow.isDestroyed())
      ? await dialog.showOpenDialog(mainWindow, opts)
      : await dialog.showOpenDialog(opts);
    if (canceled || !filePaths.length) return { success: false, canceled: true };
    return { success: true, path: filePaths[0] };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

/* 切换：校验 → 迁移数据 → 写指针（重启后生效） */
ipcMain.handle('data-dir:set', async (_event, dir) => {
  try {
    const target = String(dir || '').trim();
    if (!target) return { success: false, error: '目录不能为空' };
    if (!path.isAbsolute(target)) return { success: false, error: '请选择一个绝对路径' };
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
      return { success: false, error: '目录不存在，请先选择或新建一个目录' };
    }
    const resolved = path.resolve(target);
    const resolvedCurrent = path.resolve(dataDir);
    if (resolved === resolvedCurrent) {
      return { success: true, changed: false, dataDir, notes: [] };
    }
    // 新目录若落在当前数据目录里，迁移会变成自我复制（cpSync 直接报错），直接拒绝
    if (resolved.startsWith(resolvedCurrent + path.sep)) {
      return { success: false, error: '不能选择当前数据目录内部的子目录' };
    }
    const notes = migrateDataTo(resolved);
    fs.mkdirSync(path.dirname(dataDirPointerPath), { recursive: true });
    fs.writeFileSync(dataDirPointerPath, JSON.stringify({ dataDir: resolved }, null, 2));
    console.log('[DB] 数据目录已切换 →', resolved, '（重启应用后生效）');
    return { success: true, changed: true, dataDir: resolved, notes, requireRestart: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

/* 切换后需重启才能读到新位置（数据库句柄在启动时已绑定）。
 * 用 quit 而非 exit：before-quit 里要停团队服务器、MCP 桥，且已下载的更新会随退出一并安装。 */
ipcMain.handle('app:relaunch', () => {
  try {
    app.relaunch();
    app.quit();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 完整性检查
ipcMain.handle('db:integrity-check', async () => {
  if (!db) return { success: false, error: '数据库未初始化' };
  try {
    const result = db.prepare('PRAGMA integrity_check').all();
    return { success: true, result: result.map(r => r.integrity_check || JSON.stringify(r)).join('\n') };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

/* ───── 系统日志 ───── */
ipcMain.handle('logs:get', async (event, limit = 100, offset = 0) => {
  if (!db) return { success: false, error: '数据库未初始化' };
  try {
    const logs = db.prepare('SELECT id, level, category, source, message, created_at FROM app_logs ORDER BY id DESC LIMIT ? OFFSET ?').all(limit, offset);
    const total = db.prepare('SELECT COUNT(*) as cnt FROM app_logs').get().cnt;
    const warnCount = db.prepare("SELECT COUNT(*) as cnt FROM app_logs WHERE level = 'warn'").get().cnt;
    const errorCount = db.prepare("SELECT COUNT(*) as cnt FROM app_logs WHERE level = 'error'").get().cnt;
    return { success: true, logs, total, warnCount, errorCount };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('logs:clear', async () => {
  if (!db) return { success: false, error: '数据库未初始化' };
  try {
    db.prepare('DELETE FROM app_logs').run();
    logEvent(db, 'info', 'system', 'main', '系统日志已清空');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 读取数据源配置（effective 为实际生效的数据源）
ipcMain.handle('db-config:get', () => ({
  mode: dbMode,
  url: remoteDb.url,
  token: remoteDb.token,
  effective: isRemoteActive() ? 'remote' : 'local',
}));

// 启动时团队服务器不可达，回退本地备份（仅本次会话生效，不写入配置文件）
ipcMain.handle('db-config:fallback-local', () => {
  if (dbMode === 'remote') {
    dbMode = 'local';
    /* 开启离线写入追踪：已有未处理标记则延续（服务器连续故障的多轮回退累积计数） */
    if (!offlineMark || !offlineMark.pending) {
      offlineMark = { pending: true, since: Date.now(), writes: 0, lastWriteAt: null, tables: {} };
      saveOfflineMark();
    }
    console.log('[DB] 团队服务器不可达，本次会话回退本地 SQLite（离线写入追踪已开启）');
  }
  return { success: true, offline: dbMode === 'local' };
});

// 离线会话内重新连回团队服务器（仅本次会话生效，不写入配置文件）
ipcMain.handle('db-config:restore-remote', () => {
  if (dbMode === 'local' && /^https?:\/\//.test(remoteDb.url)) {
    dbMode = 'remote';
    console.log('[DB] 已重新连回团队服务器（离线修改标记保留，直至用户确认合并完成）');
  }
  return { success: true };
});

// 读取离线修改标记（pending && writes > 0 表示本地有未合并到团队服务器的修改）
ipcMain.handle('offline-mark:get', () => ({
  success: true,
  mark: offlineMark && offlineMark.pending
    ? { ...offlineMark, sinceText: offlineMark.since ? new Date(offlineMark.since).toLocaleString('zh-CN', { hour12: false }) : '',
        lastWriteAtText: offlineMark.lastWriteAt ? new Date(offlineMark.lastWriteAt).toLocaleString('zh-CN', { hour12: false }) : '' }
    : null,
}));

// 清除离线修改标记（用户确认本地修改已合并/留档后调用）
ipcMain.handle('offline-mark:clear', () => {
  offlineMark = null;
  try { fs.unlinkSync(offlineMarkPath); } catch { /* 文件不存在时忽略 */ }
  return { success: true };
});

/* 部分同步完成后按表裁剪标记：保留未同步/失败表的计数，全部清空则删除文件。
 * writes 重算为保留表的语句数之和（原语义为写入操作次数，裁剪后按未合并语句数展示更直观） */
ipcMain.handle('offline-mark:update', (event, keepTables) => {
  const keep = new Set(Array.isArray(keepTables) ? keepTables.map(String) : []);
  if (offlineMark && offlineMark.pending) {
    const tables = {};
    let sum = 0;
    for (const [t, n] of Object.entries(offlineMark.tables || {})) {
      if (keep.has(t)) { tables[t] = n; sum += Number(n) || 0; }
    }
    if (sum <= 0) {
      offlineMark = null;
      try { fs.unlinkSync(offlineMarkPath); } catch { /* 文件不存在时忽略 */ }
    } else {
      offlineMark.tables = tables;
      offlineMark.writes = sum;
      saveOfflineMark();
    }
  }
  return { success: true };
});

/* 读取本地 SQLite 的可同步业务表（与当前 dbMode 无关，离线修改同步用）。
 * 本地库不是服务器镜像，渲染层必须按业务键（协议名/用户名/change_id）比对，
 * 严禁按自增 id 直接比对或覆盖（两端 id 各自独立分配，同 id 可能是不同数据行） */
const SYNC_LOCAL_TABLES = ['protocols', 'commands', 'modules', 'protocol_versions', 'audit_logs', 'users', 'roles'];
ipcMain.handle('sync:read-local', () => {
  if (!db) return { success: false, error: '数据库未初始化' };
  try {
    const data = {};
    for (const t of SYNC_LOCAL_TABLES) {
      data[t] = db.prepare(`SELECT * FROM ${t}`).all();
    }
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 保存数据源配置（立即生效，持久化到 data/db-config.json）
ipcMain.handle('db-config:set', async (event, cfg) => {
  try {
    const mode = cfg && cfg.mode === 'remote' ? 'remote' : 'local';
    const url = String((cfg && cfg.url) || '').trim();
    const token = String((cfg && cfg.token) || '').trim();
    if (mode === 'remote' && !/^https?:\/\/.+/.test(url)) {
      return { success: false, error: '服务器地址必须以 http:// 或 https:// 开头' };
    }
    dbMode = mode;
    remoteDb = { url, token };
    persistDbConfig();
    console.log('[DB] 数据源已切换:', mode, mode === 'remote' ? url : '');
    /* 远程地址变化时重启 SSE 推送连接 */
    restartSsePush();
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// 测试团队服务器连接（可传待测配置，不落盘；不传则用已保存配置；timeoutMs 可选，默认 8 秒）
ipcMain.handle('db-config:test', async (event, cfg) => {
  const url = (cfg && typeof cfg.url === 'string' ? cfg.url : remoteDb.url).trim();
  const token = (cfg && typeof cfg.token === 'string' ? cfg.token : remoteDb.token).trim();
  const timeoutMs = Math.min(Math.max(Number(cfg && cfg.timeoutMs) || 8000, 1000), 15000);
  if (!/^https?:\/\/.+/.test(url)) {
    return { success: false, error: '服务器地址必须以 http:// 或 https:// 开头' };
  }

  const base = url.replace(/\/+$/, '');
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(base + '/api/health', { headers, signal: controller.signal });
    const j = await res.json().catch(() => ({}));
    if (res.status === 401) return { success: false, error: '访问令牌无效，请核对服务器配置的 token' };
    if (!res.ok) return { success: false, error: `服务器返回 HTTP ${res.status}` };
    if (!j.success) return { success: false, error: j.error || '服务器健康检查失败' };
    return {
      success: true,
      protocolCount: j.protocolCount,
      serverTime: j.serverTime,
    };
  } catch (e) {
    const msg = e.name === 'AbortError'
      ? `连接超时（${Math.round(timeoutMs / 1000)} 秒），请确认服务器已启动且地址可达`
      : `无法连接服务器: ${e.message}`;
    return { success: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
});

// ---------------------------------------------------------------------------
// 内嵌团队服务器 + 局域网零配置发现
// 客户端「作为局域网主机」一键运行与独立部署同源的 server.js（无需另装 Node.js），
// 并广播到局域网，其他成员在「数据库连接」页自动发现、一键填入地址。
// ---------------------------------------------------------------------------
/* 团队服务器数据目录：默认 userData/team-server，用户可在「创建团队」弹窗里浏览改选。
 * 指针文件同样固定放在 userData 下（与 data-dir.json 同理）：不能跟着数据目录搬，
 * 否则换过一次目录后重启就找不回原位置，已建好的团队会凭空变空的。 */
const teamServerRootPointer = path.join(app.getPath('userData'), 'team-server-dir.json');
function readTeamServerRoot() {
  try {
    if (fs.existsSync(teamServerRootPointer)) {
      const parsed = JSON.parse(fs.readFileSync(teamServerRootPointer, 'utf-8')) || {};
      const dir = String(parsed.dataRoot || '').trim();
      if (dir && fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return dir;
      if (dir) console.warn('[embed] 团队服务器数据目录不可用，回退默认:', dir);
    }
  } catch (e) {
    console.warn('[embed] 读取团队服务器数据目录失败:', e.message);
  }
  return '';
}
const teamServerDataRoot = readTeamServerRoot() || path.join(app.getPath('userData'), 'team-server');

/** 向渲染进程推送（窗口可能尚未创建或已销毁） */
function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

const discovery = createDiscovery({
  onLog: (msg) => console.log(msg),
  onUpdate: (list) => sendToRenderer('discovery:update', list),
});

const teamServer = createTeamServer({
  dataRoot: teamServerDataRoot,
  appDir: __dirname,
  resourcesPath: process.resourcesPath,
  isPackaged: app.isPackaged,
  execPath: process.execPath,
  version: app.getVersion(),
  onLog: (line) => sendToRenderer('team-server:log', { line, ts: Date.now() }),
  onState: (state) => {
    sendToRenderer('team-server:state', state);
    /* 服务器运行中自动广播，供局域网内其他成员发现；停止则撤销广播 */
    if (state.running && state.port) {
      discovery.advertise({ port: state.port, version: app.getVersion(), needToken: !!state.token });
    } else {
      discovery.stopAdvertise();
    }
  },
});

// 查询内嵌服务器状态（含可写目录、当前端口、令牌、局域网地址）
ipcMain.handle('team-server:status', () => teamServer.status());

/* ---- 团队服务器数据目录：查询 / 浏览 / 切换（「创建团队」弹窗使用） ---- */

ipcMain.handle('team-server:data-root', () => ({
  success: true,
  dataRoot: teamServer.getDataRoot(),
  defaultRoot: path.join(app.getPath('userData'), 'team-server'),
}));

ipcMain.handle('team-server:choose-data-root', async () => {
  try {
    const opts = {
      title: '选择团队服务器数据目录',
      defaultPath: teamServer.getDataRoot(),
      properties: ['openDirectory', 'createDirectory'],
    };
    const { canceled, filePaths } = (mainWindow && !mainWindow.isDestroyed())
      ? await dialog.showOpenDialog(mainWindow, opts)
      : await dialog.showOpenDialog(opts);
    if (canceled || !filePaths.length) return { success: false, canceled: true };
    return { success: true, path: filePaths[0] };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

/* 切换：由 server-embed 校验并迁移已有团队数据，成功后把选择写入指针文件，
 * 之后每次启动（含 autoStart 自动恢复）都从指针读到用户选的目录。 */
ipcMain.handle('team-server:set-data-root', (_event, dir) => {
  try {
    const r = teamServer.setDataRoot(dir);
    if (!r || !r.success) return { success: false, error: (r && r.error) || '修改数据目录失败' };
    if (r.changed) {
      fs.mkdirSync(path.dirname(teamServerRootPointer), { recursive: true });
      fs.writeFileSync(teamServerRootPointer, JSON.stringify({ dataRoot: r.dataRoot }, null, 2));
      console.log('[embed] 团队服务器数据目录已切换 →', r.dataRoot);
    }
    return r;
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 启动内嵌服务器（opts: { port?, token? }）；持久标记 autoStart，下次启动自动恢复
ipcMain.handle('team-server:start', async (event, opts) => {
  try {
    teamServer.setConfig({ autoStart: true });
    return await teamServer.start(opts || {});
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// 停止内嵌服务器；清除 autoStart，避免下次启动自动拉起
ipcMain.handle('team-server:stop', async () => {
  teamServer.setConfig({ autoStart: false });
  return teamServer.stop();
});

ipcMain.handle('team-server:restart', async () => teamServer.restart());

ipcMain.handle('team-server:get-config', () => teamServer.getConfig());

ipcMain.handle('team-server:set-config', (event, patch) => {
  try {
    return { success: true, config: teamServer.setConfig(patch || {}) };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('team-server:regen-token', () => ({ success: true, token: teamServer.regenerateToken() }));

// 在系统浏览器打开内嵌服务器的管理后台（仅本机可访问）
ipcMain.handle('team-server:open-admin', () => {
  const s = teamServer.status();
  if (!s.running || !s.port) return { success: false, error: '内嵌服务器未运行' };
  shell.openExternal(`http://localhost:${s.port}/admin`);
  return { success: true };
});

/**
 * 转发内嵌服务器的本机管理接口（/admin/api/*）。
 * 该接口在 server.js 侧仅放行 127.0.0.1/::1，而主机客户端本身即本机，
 * 因此可在客户端里直接创建成员账号（免邮箱验证），无需打开浏览器管理台、无需配置 SMTP。
 */
async function callAdminApi(pathname, { method = 'GET', body } = {}) {
  const s = teamServer.status();
  if (!s.running || !s.port) return { success: false, error: '内嵌服务器未运行，请先启动局域网主机' };
  try {
    const res = await fetch(`http://127.0.0.1:${s.port}${pathname}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return { success: false, error: `管理接口返回异常（HTTP ${res.status}）` };
    }
  } catch (e) {
    return { success: false, error: `管理接口请求失败：${e.message}` };
  }
}

ipcMain.handle('team-server:admin-users', () => callAdminApi('/admin/api/users'));
ipcMain.handle('team-server:admin-create-user', (event, payload) =>
  callAdminApi('/admin/api/users/create', { method: 'POST', body: payload || {} }));
ipcMain.handle('team-server:admin-set-role', (event, payload) =>
  callAdminApi('/admin/api/users/role', { method: 'POST', body: payload || {} }));
ipcMain.handle('team-server:admin-set-status', (event, payload) =>
  callAdminApi('/admin/api/users/status', { method: 'POST', body: payload || {} }));
ipcMain.handle('team-server:admin-delete-user', (event, payload) =>
  callAdminApi('/admin/api/users/delete', { method: 'POST', body: payload || {} }));

// 局域网发现：开始/停止浏览；列表通过 discovery:update 事件推送，也可轮询 list
ipcMain.handle('discovery:start', () => {
  discovery.startBrowse();
  return { success: true, list: discovery.list() };
});
ipcMain.handle('discovery:stop', () => {
  discovery.stopBrowse();
  return { success: true };
});
ipcMain.handle('discovery:list', () => discovery.list());

// ---------------------------------------------------------------------------
// 协议导出 IPC
// ---------------------------------------------------------------------------

/**
 * 保存导出文件：弹出原生保存对话框，用户选择路径后写入
 * PDF 格式通过隐藏 BrowserWindow 渲染 HTML 后 printToPDF 生成
 * @param {string} defaultFileName - 默认文件名（含扩展名）
 * @param {string} format - 导出格式: json | md | pdf
 * @param {string} content - 文件内容（json/md 为文本，pdf 为 HTML）
 */
ipcMain.handle('export:saveFile', async (event, { defaultFileName, format, content }) => {
  try {
    const ext = format === 'pdf' ? 'pdf' : format;
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      defaultPath: defaultFileName,
      filters: [{ name: format.toUpperCase(), extensions: [ext] }],
    });
    if (canceled || !filePath) {
      return { success: false, canceled: true };
    }

    let buffer;
    if (format === 'pdf') {
      const pdfWin = new BrowserWindow({
        show: false,
        webPreferences: { offscreen: true },
      });
      try {
        await pdfWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(content));
        buffer = await pdfWin.webContents.printToPDF({
          printBackground: true,
          pageSize: 'A4',
          margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 },
        });
      } finally {
        pdfWin.destroy();
      }
    } else {
      buffer = Buffer.from(content, 'utf-8');
    }

    fs.writeFileSync(filePath, buffer);
    return { success: true, filePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

/* 导入协议：原生打开文件对话框（限 JSON）→ 读取文件内容返回给渲染进程 */
ipcMain.handle('import:openFile', async () => {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: '导入协议',
      filters: [{ name: 'JSON 协议文件', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (canceled || !filePaths || filePaths.length === 0) {
      return { success: false, canceled: true };
    }
    const content = fs.readFileSync(filePaths[0], 'utf-8');
    return { success: true, filePath: filePaths[0], content };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ---------------------------------------------------------------------------
// 文件传输 IPC（文件发送模块）
// ---------------------------------------------------------------------------

/* 文件发送大小上限：文件经 base64 一次性读入内存分块发送 */
const FILE_TRANSFER_MAX_SIZE = 64 * 1024 * 1024;

/**
 * 读取待发送文件：返回元信息 + base64 内容（二进制安全）
 * @param {string} filePath
 */
function readFileForTransfer(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    return { success: false, error: '文件路径无效' };
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    return { success: false, error: '目标不是常规文件' };
  }
  if (stat.size > FILE_TRANSFER_MAX_SIZE) {
    return { success: false, error: `文件超出上限（最大 ${FILE_TRANSFER_MAX_SIZE / 1024 / 1024} MB）` };
  }
  const buf = fs.readFileSync(filePath);
  return {
    success: true,
    filePath,
    name: path.basename(filePath),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    base64: buf.toString('base64'),
  };
}

/* 读取指定路径的文件（拖拽进入时由渲染层先取到绝对路径） */
ipcMain.handle('fileTransfer:readFile', (event, filePath) => {
  try {
    return readFileForTransfer(filePath);
  } catch (err) {
    return { success: false, error: err.message };
  }
});

/* 原生对话框选择待发送文件（不限扩展名） */
ipcMain.handle('fileTransfer:pickFile', async () => {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: '选择要发送的文件',
      properties: ['openFile'],
    });
    if (canceled || !filePaths || filePaths.length === 0) {
      return { success: false, canceled: true };
    }
    return readFileForTransfer(filePaths[0]);
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ---------------------------------------------------------------------------
// 窗口控制 IPC
// ---------------------------------------------------------------------------

ipcMain.on('window:minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('window:maximize', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});

ipcMain.on('window:close', () => {
  if (mainWindow) mainWindow.close();
});

ipcMain.handle('window:isMaximized', () => {
  return mainWindow ? mainWindow.isMaximized() : false;
});

// ---------------------------------------------------------------------------
// 主题 IPC
// ---------------------------------------------------------------------------
ipcMain.handle('theme:set', (event, theme) => {
  nativeTheme.themeSource = theme === 'light' ? 'light' : 'dark';
  return { success: true };
});

// ---------------------------------------------------------------------------
// 自动更新 IPC
// ---------------------------------------------------------------------------
ipcMain.handle('app:get-version', () => app.getVersion());

/* 开机自启 */
ipcMain.handle('app:get-login-item-settings', () => {
  const settings = app.getLoginItemSettings();
  return {
    openAtLogin: settings.openAtLogin,
    openAsHidden: settings.openAsHidden,
  };
});

ipcMain.handle('app:set-login-item-settings', (_e, opts) => {
  try {
    app.setLoginItemSettings({
      openAtLogin: !!opts.openAtLogin,
      openAsHidden: true,
      path: process.execPath,
      args: ['--hidden'], // 开机自启时传递 --hidden 参数，启动后最小化到托盘
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

/* 更新通知开关 */
ipcMain.handle('app:set-update-notify', (_e, enabled) => {
  updateNotifyEnabled = !!enabled;
  return { success: true };
});

/* 系统通知：通用弹系统气泡 */
ipcMain.handle('app:show-notification', (_e, { title, body }) => {
  if (Notification.isSupported()) {
    const n = new Notification({
      title: title || '通知',
      body: body || '',
      icon: path.join(__dirname, 'assets', 'app.ico'),
    });
    n.show();
  }
  return { success: true };
});

// 读取 README
ipcMain.handle('app:readme', () => {
  try {
    const readmePath = path.join(__dirname, 'README.md');
    return fs.readFileSync(readmePath, 'utf8');
  } catch { return '# 暂无帮助文档'; }
});

// 打开外部链接
ipcMain.handle('shell:openExternal', (_e, url) => {
  if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
    shell.openExternal(url);
  }
});

/* ===================== GitHub Token 主进程存储 =====================
 * 修复报告问题：令牌此前存渲染层 localStorage（spm-gitee-token），
 * 任何 XSS 均可直接读取。迁移到主进程 data/github-token.json：
 *   - 渲染层只能通过 IPC 读写，无法再通过 DOM/JS 直接拿到明文
 *   - feedback:submit-issue 不再接受渲染层传入 token，一律用主进程存储的
 */
const githubTokenPath = path.join(dataDir, 'github-token.json');

function getStoredGithubToken() {
  try {
    if (!fs.existsSync(githubTokenPath)) return '';
    return String(JSON.parse(fs.readFileSync(githubTokenPath, 'utf8')).token || '');
  } catch {
    return '';
  }
}

function setStoredGithubToken(token) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    if (token) {
      fs.writeFileSync(githubTokenPath, JSON.stringify({ token }, null, 2));
    } else if (fs.existsSync(githubTokenPath)) {
      fs.unlinkSync(githubTokenPath);
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

ipcMain.handle('github-token:get', () => {
  const token = getStoredGithubToken();
  return { success: true, configured: !!token };
});

ipcMain.handle('github-token:set', (_e, token) => setStoredGithubToken(String(token || '').trim()));

/* ===================== AI 助手（OpenAI 协议兼容大模型） =====================
 * 配置（含 API Key）全部存主进程 data/ai-config.json，渲染层仅经 IPC 访问；
 * 流式增量经 ai:chunk/ai:done/ai:error 事件推回发起请求的窗口。
 * 实现见 ai-assistant.js */

/* 工具层（ai-tools.js）可用的应用能力：AI 助手与 MCP 桥共用同一份 */
const mcpAppHooks = {
  listSerialPorts: async () => {
    try { return await SerialPort.list(); } catch { return []; }
  },
  openSerial: ({ port, baudRate, dataBits, stopBits, parity }) => openSerialDevice({ portPath: port, baudRate, dataBits, stopBits, parity, source: 'mcp' }),
  closeSerial: (port) => closeSerialDevice(port, 'mcp'),
  sendSerial: ({ port, data, format }) => sendSerialData({ portPath: port, data, format, source: 'mcp' }),
  waitForRx: (port, timeoutMs) => mcpWaitForRx(port, timeoutMs),
  dbBackup: () => backupDatabase(),
  publishDraft: (name) => publishDraft(name),
};

registerAiIpc({
  dataDir,
  queryDatabase,
  app: mcpAppHooks,
  log: (level, message) => {
    try { if (db) logEvent(db, level, 'ai', 'ai-assistant', message); } catch { /* 日志失败不影响对话 */ }
  },
});

/* ===================== MCP 桥（供外部 AI 客户端在线调用工具） =====================
 * 应用运行时在 127.0.0.1 起一个带令牌的 HTTP 端点，独立 MCP 服务器
 * （mcp-server.js）发现并转发工具调用；端口与令牌写入 <数据目录>/mcp-bridge.json。
 * 写操作工具（串口收发/备份/发布）经 confirmInWindow 弹窗人工确认后才执行 */
let mcpBridgeHandle = null;
registerMcpBridge({
  dataDir,
  queryDatabase,
  app: mcpAppHooks,
  confirm: confirmInWindow,
  log: (level, message) => {
    try { if (db) logEvent(db, level, 'mcp', 'mcp-bridge', message); } catch { /* 日志失败不影响主流程 */ }
  },
}).then((handle) => { mcpBridgeHandle = handle; });

/* MCP 接入信息（系统设置页展示）：服务器脚本路径 / 数据目录 / 桥状态 */
ipcMain.handle('app:mcp-info', () => ({
  serverPath: app.isPackaged
    ? path.join(process.resourcesPath, 'mcp', 'mcp-server.js')
    : path.join(__dirname, 'mcp-server.js'),
  dataDir,
  bridgeReady: !!(mcpBridgeHandle && mcpBridgeHandle.port),
  bridgePort: (mcpBridgeHandle && mcpBridgeHandle.port) || null,
}));

/* 已记住的写操作确认策略（查看/重置，系统设置 → MCP 接入） */
ipcMain.handle('app:mcp-policies', () => loadMcpPolicy());
ipcMain.handle('app:mcp-policy-reset', (_e, key) => {
  const policy = loadMcpPolicy();
  if (key && key !== '*') delete policy[key];
  else if (key === '*') Object.keys(policy).forEach((k) => delete policy[k]);
  saveMcpPolicy(policy);
  return { success: true };
});

// 直接提交 GitHub Issue（token 一律取主进程存储，渲染层传参被忽略）
ipcMain.handle('feedback:submit-issue', async (_e, { title, description, type, priority }) => {
  const token = getStoredGithubToken();
  if (!token) {
    return { success: false, error: '未配置 GitHub Token，请先在系统设置中配置' };
  }
  const owner = 'ALVAN-1';
  const repo = 'BaudLab.io';
  const url = `https://api.github.com/repos/${owner}/${repo}/issues`;

  const typeLabel = { bug: 'Bug', feature: '功能建议', question: '疑问' }[type] || '其他';
  const priorityLabel = { low: '低', medium: '中', high: '高' }[priority] || '中';
  const body = [
    `**类型**: ${typeLabel}`,
    `**优先级**: ${priorityLabel}`,
    '',
    '### 描述',
    description,
    '',
    `---`,
    `_由 BaudLab v${app.getVersion()} 自动提交_`,
    `_提交时间: ${new Date().toLocaleString('zh-CN')}_`,
  ].join('\n');

  // GitHub Issues API：token 走 Authorization 头（经典 PAT 需 repo 权限）
  // 注意：labels 需先在仓库中创建，否则 GitHub 返回 422
  const payload = {
    title: `[${typeLabel}] ${title}`,
    body,
    labels: ['feedback', type, `p-${priority}`],
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'Serial-Protocol-Manager',
      },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!res.ok) {
      const msg = data?.message || text.slice(0, 200);
      return { success: false, error: `GitHub API 错误 (${res.status}): ${msg}` };
    }
    return {
      success: true,
      issueNumber: data?.number,
      htmlUrl: data?.html_url || `https://github.com/${owner}/${repo}/issues`,
      issueData: data,
    };
  } catch (e) {
    return { success: false, error: String(e.message || e) };
  }
});

const updateController = createUpdateController({
  app, updater: autoUpdater,
  send: (channel, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data);
  },
  prepareInstall: () => { isQuitting = true; },
  restoreInstall: () => { isQuitting = false; },
});
ipcMain.handle('update:check', () => updateController.check());
ipcMain.handle('update:download', () => updateController.download());
ipcMain.handle('update:install', () => updateController.install());

/* All modes use the GitHub source from app-update.yml. Team SSE only requests a recheck. */
let updateCheckTimer = null;
let updateInitialTimer = null;
let lastNotifiedVersion = '';
async function autoCheckForUpdate(silent = true) {
  const result = await updateController.check();
  if (!result.success) {
    if (!silent && result.error) console.error('[Update]', result.error);
    return;
  }
  if (!result.available || result.phase !== 'available' || lastNotifiedVersion === result.version) return;
  lastNotifiedVersion = result.version;
  if (!updateNotifyEnabled) return;
  if (Notification.isSupported()) {
    const notification = new Notification({
      title: '发现新版本 v' + result.version,
      body: '当前版本 v' + result.currentVersion + '，点击查看并下载更新',
      icon: path.join(__dirname, 'assets', 'app.ico'),
    });
    notification.on('click', () => {
      showMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:show-available', result);
    });
    notification.show();
  } else {
    showTrayBalloon('发现新版本 v' + result.version, '点击查看并下载更新');
  }
}
function startAutoUpdateCheck() {
  updateInitialTimer = setTimeout(() => autoCheckForUpdate(true), 10000);
  updateCheckTimer = setInterval(() => autoCheckForUpdate(true), 30 * 60 * 1000);
}
function stopAutoUpdateCheck() {
  clearTimeout(updateInitialTimer);
  clearInterval(updateCheckTimer);
  updateInitialTimer = updateCheckTimer = null;
}

/* ── SSE 版本实时推送 ── */
let sseReq = null;
let sseReconnectTimer = null;
let sseConnected = false;
/* 指数退避（修复报告问题：固定 15 秒重连对宕机服务器形成持续压力）
 *   - 连接失败后 3s → 6s → 12s → ... 指数递增，上限 5 分钟
 *   - 连接成功即归零；服务器配置变更重启时也归零 */
const SSE_BASE_DELAY_MS = 3000;
const SSE_MAX_DELAY_MS = 5 * 60 * 1000;
let sseReconnectAttempts = 0;

function startSsePush() {
  if (!app.isPackaged) return; // 开发模式不连接
  if (!isRemoteActive()) return; // 没有配置远程服务器就不连
  if (sseReq) return;

  const baseUrl = remoteDb.url.replace(/\/+$/, '');
  const sseUrl = new URL(baseUrl + '/api/update/stream');

  const protocol = sseUrl.protocol === 'https:' ? require('https') : require('http');
  const options = {
    hostname: sseUrl.hostname,
    port: sseUrl.port || (sseUrl.protocol === 'https:' ? 443 : 80),
    path: sseUrl.pathname,
    method: 'GET',
    headers: {
      'Accept': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  };

  /* 如果配置了 token，带上鉴权 */
  if (remoteDb.token) {
    options.headers['Authorization'] = `Bearer ${remoteDb.token}`;
  }

  sseReq = protocol.get(options, (res) => {
    if (res.statusCode !== 200) {
      sseReq = null;
      scheduleSseReconnect();
      return;
    }

    sseConnected = true;
    sseReconnectAttempts = 0; // 连接成功，退避归零
    let buffer = '';

    res.on('data', (chunk) => {
      buffer += chunk.toString('utf-8');
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        handleSseEvent(rawEvent);
      }
    });

    res.on('end', () => {
      sseConnected = false;
      sseReq = null;
      scheduleSseReconnect();
    });

    res.on('error', () => {
      sseConnected = false;
      sseReq = null;
      scheduleSseReconnect();
    });
  });

  sseReq.on('error', () => {
    sseReq = null;
    scheduleSseReconnect();
  });

  sseReq.setTimeout(0);
}

function handleSseEvent(raw) {
  const lines = raw.split('\n');
  let eventType = 'message';
  let dataStr = '';

  for (const line of lines) {
    if (line.startsWith('event:')) {
      eventType = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataStr += line.slice(5).trim();
    }
  }

  if (eventType === 'update' && dataStr) {
    try {
      const data = JSON.parse(dataStr);
      if (data.version) void autoCheckForUpdate(true);
    } catch { /* 解析失败忽略 */ }
  }
}

function scheduleSseReconnect() {
  if (sseReconnectTimer) return;
  const delay = Math.min(SSE_BASE_DELAY_MS * Math.pow(2, sseReconnectAttempts), SSE_MAX_DELAY_MS);
  sseReconnectAttempts = Math.min(sseReconnectAttempts + 1, 16);
  sseReconnectTimer = setTimeout(() => {
    sseReconnectTimer = null;
    startSsePush();
  }, delay);
}

function stopSsePush() {
  if (sseReq) {
    try { sseReq.destroy(); } catch (_) {}
    sseReq = null;
  }
  if (sseReconnectTimer) {
    clearTimeout(sseReconnectTimer);
    sseReconnectTimer = null;
  }
  sseConnected = false;
  sseReconnectAttempts = 0; // 主动停止（配置变更/退出）后重启走全新退避序列
}

/* 远程服务器地址变化时重启 SSE */
function restartSsePush() {
  stopSsePush();
  startSsePush();
}

/* ── 用户在线心跳 ── */
let heartbeatTimer = null;
let heartbeatUsername = '';

async function sendHeartbeat() {
  if (!isRemoteActive() || !heartbeatUsername) return;
  try {
    const base = remoteDb.url.replace(/\/+$/, '');
    const headers = { 'Content-Type': 'application/json' };
    if (remoteDb.token) headers['Authorization'] = `Bearer ${remoteDb.token}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    await fetch(base + '/api/heartbeat', {
      method: 'POST',
      headers,
      body: JSON.stringify({ username: heartbeatUsername }),
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch { /* 网络波动，忽略 */ }
}

function startHeartbeat(username) {
  stopHeartbeat();
  heartbeatUsername = username;
  sendHeartbeat();
  heartbeatTimer = setInterval(sendHeartbeat, 30000);
}

function stopHeartbeat() {
  heartbeatUsername = '';
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

/* 查询在线用户列表 */
ipcMain.handle('online-users:get', async () => {
  if (!isRemoteActive()) return { success: false, error: '未连接团队服务器' };
  try {
    const base = remoteDb.url.replace(/\/+$/, '');
    const headers = {};
    if (remoteDb.token) headers['Authorization'] = `Bearer ${remoteDb.token}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(base + '/api/online-users', { headers, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return { success: false, error: `HTTP ${res.status}` };
    return await res.json();
  } catch (e) {
    return { success: false, error: e.message };
  }
});

/* 心跳控制 */
ipcMain.handle('heartbeat:start', (event, username) => {
  startHeartbeat(username);
  return { success: true };
});
ipcMain.handle('heartbeat:stop', () => {
  stopHeartbeat();
  return { success: true };
});

// ---------------------------------------------------------------------------
// 应用生命周期
// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  initDatabase();
  initAuth(db, dataDir, { isRemoteActive, remoteDbRequest }); // 用户管理（列表/切换/会话）
  loadDbConfig();
  loadOfflineMark();
  installCsp();
  createWindow();
  createTray();
  startAutoUpdateCheck();
  startSsePush();

  /* 上次会话曾开启「作为局域网主机」则自动恢复启动内嵌服务器 */
  try {
    if (teamServer.getConfig().autoStart) {
      teamServer.start({}).catch((e) => console.log('[embed] 自动启动失败:', e.message));
    }
  } catch (e) {
    console.log('[embed] 读取内嵌服务器配置失败:', e.message);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  /* 有托盘时窗口关闭不退出程序，保持后台运行 */
  if (tray) return;

  // 关闭所有串口
  for (const [path, entry] of activePorts) {
    try {
      entry.port.close();
    } catch (e) {
      // ignore
    }
  }
  activePorts.clear();

  // 关闭数据库
  flushSerialLogs();
  if (db) {
    db.close();
    db = null;
  }

  stopAutoUpdateCheck();

  if (process.platform !== 'darwin') {
    app.quit();
  }
});
