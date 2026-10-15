'use strict';

/**
 * 内嵌团队服务器（客户端「作为局域网主机」）
 *
 * 背景：波特律动默认单机使用；多人共享协议数据时原本需要管理员单独部署
 * BaudLab-Server.zip 并安装 Node.js。本模块让任意一台客户端一键把同一个
 * 服务端程序（server.js）跑起来，作为局域网内的数据服务器：
 *
 *   - 复用与独立部署完全相同的 server.js（同一份代码、同一套 API），
 *     通过 ELECTRON_RUN_AS_NODE 用 Electron 自带运行时启动，无需另装 Node.js；
 *   - 开发环境直接从项目目录启动；打包后从 resources/server/ 启动（由
 *     scripts/afterPack.js 拷贝，含 better-sqlite3 原生模块，自包含）；
 *   - 数据与配置落到可写的用户数据目录（只读安装目录无法写入）；
 *   - 通过环境变量 BAUDLAB_SERVER_* 覆盖路径/端口，server.js 保持零依赖不变。
 *
 * 与 server.js 的约定（机器可读输出）：
 *   BAUDLAB_SERVER_READY {"port":3010,"dbPath":"...","token":true}
 *   BAUDLAB_SERVER_ADDR  http://192.168.1.100:3010
 *   BAUDLAB_SERVER_ERROR {"code":"EADDRINUSE","message":"..."}
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const os = require('os');
const crypto = require('crypto');

const READY_RE = /BAUDLAB_SERVER_READY\s+(\{.*\})/;
const ADDR_RE = /BAUDLAB_SERVER_ADDR\s+(\S+)/;
const ERROR_RE = /BAUDLAB_SERVER_ERROR\s+(\{.*\})/;

function defaultConfig() {
  return {
    port: 3010,
    token: '',
    dbPath: 'server-data/serial_protocol.db',
    backup: { enabled: true, dir: 'server-data/backups', intervalHours: 24, keep: 14 },
  };
}

/* 端口占用探测：以 0.0.0.0 尝试监听，能绑定即视为空闲（与服务端监听方式一致） */
function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    try {
      srv.listen(port, '0.0.0.0');
    } catch {
      resolve(false);
    }
  });
}

/** 枚举本机局域网 IPv4 地址（排除回环） */
function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      if (info.family === 'IPv4' && !info.internal) out.push(info.address);
    }
  }
  return out;
}

/**
 * 创建内嵌服务器控制器
 * @param {object} deps
 * @param {string} deps.dataRoot      可写数据目录（配置/数据库/备份的基准目录）
 * @param {string} deps.appDir        __dirname（开发环境 server.js 所在目录）
 * @param {string} [deps.resourcesPath] process.resourcesPath（打包环境）
 * @param {boolean} deps.isPackaged   app.isPackaged
 * @param {string} deps.execPath      process.execPath（Electron 可执行文件）
 * @param {string} [deps.version]     应用版本（写入 mDNS/日志用）
 * @param {(line:string)=>void} [deps.onLog]
 * @param {(state:object)=>void} [deps.onState]
 */
function createTeamServer(deps) {
  /* 数据根目录 = 配置 / 数据库 / 备份的基准目录。用户可在「创建团队」弹窗里浏览改选，
   * 故必须可变：子进程启动时按当时的值生成 BAUDLAB_SERVER_CONFIG / BAUDLAB_SERVER_DIR，
   * 运行中改会让配置和数据库指向两个不同目录，因此 setDataRoot 仅在服务端未运行时允许。 */
  let dataRoot = deps.dataRoot;
  let configPath = path.join(dataRoot, 'server.config.json');
  const { appDir, resourcesPath, isPackaged, execPath, version } = deps;
  const onLog = deps.onLog || (() => {});
  const onState = deps.onState || (() => {});

  let child = null;
  let stopping = false;
  let pending = null; // 启动握手的 resolve/reject
  const state = {
    running: false,
    starting: false,
    port: null,
    url: null,      // 主机自身使用（localhost）
    host: null,     // 局域网首个地址（供成员填写）
    addresses: [],  // 全部局域网地址
    token: '',
    error: null,
  };

  function emit() { onState({ ...state, addresses: [...state.addresses] }); }
  function log(line) { onLog(String(line).replace(/\x1b\[[0-9;]*m/g, '')); }

  function loadConfig() {
    const def = defaultConfig();
    try {
      if (fs.existsSync(configPath)) {
        const c = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        return { ...def, ...c, backup: { ...def.backup, ...(c.backup || {}) } };
      }
    } catch (e) {
      log(`[embed] 配置解析失败，使用默认值: ${e.message}`);
    }
    return def;
  }

  function saveConfig(cfg) {
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
  }

  /** 打包环境用 resources/server/（自包含），开发环境用项目目录 */
  function serverPaths() {
    if (isPackaged && resourcesPath) {
      const dir = path.join(resourcesPath, 'server');
      return { dir, script: path.join(dir, 'server.js') };
    }
    return { dir: appDir, script: path.join(appDir, 'server.js') };
  }

  async function start(opts = {}) {
    if (state.running) return { success: true, ...state };
    if (state.starting) return { success: false, error: '服务器正在启动中，请稍候' };

    const { dir, script } = serverPaths();
    if (!fs.existsSync(script)) {
      state.error = `未找到服务端程序：${script}（打包环境请确认 resources/server/ 已生成）`;
      emit();
      return { success: false, error: state.error };
    }

    const cfg = loadConfig();
    if (opts.port) cfg.port = parseInt(opts.port, 10) || cfg.port;
    if (opts.token !== undefined) cfg.token = String(opts.token);
    /* 内嵌默认强制随机令牌：局域网明文 HTTP 下空 token 等于无鉴权，不安全 */
    if (!cfg.token) cfg.token = crypto.randomBytes(24).toString('hex');
    if (opts.persist !== false) saveConfig(cfg);

    // 端口选择：优先配置端口，被占用则顺延到 3011–3099
    let port = parseInt(cfg.port, 10) || 3010;
    if (!(await isPortFree(port))) {
      let found = 0;
      for (let p = 3011; p <= 3099; p++) {
        if (await isPortFree(p)) { found = p; break; }
      }
      if (!found) {
        state.error = '端口 3010–3099 均被占用，无法启动内嵌服务器';
        emit();
        return { success: false, error: state.error };
      }
      port = found;
      cfg.port = port;
      if (opts.persist !== false) saveConfig(cfg);
    }

    stopping = false;
    state.starting = true;
    state.error = null;
    state.addresses = [];
    emit();

    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      BAUDLAB_EMBEDDED: '1',
      BAUDLAB_SERVER_CONFIG: configPath,
      BAUDLAB_SERVER_DIR: dataRoot,
      BAUDLAB_PORT: String(port),
    };

    log(`[embed] 启动服务端: ${script} (port=${port}, cwd=${dir})`);
    child = spawn(execPath, [script], {
      cwd: dir,
      env,
      windowsHide: true,
      /* stdin 保持管道：宿主客户端退出时管道关闭，服务端据此自动退出，避免留下孤儿进程 */
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const ready = new Promise((resolve, reject) => { pending = { resolve, reject }; });

    const handleLine = (line) => {
      if (!line.trim()) return;
      log(line);
      const mReady = READY_RE.exec(line);
      if (mReady) {
        let info = {};
        try { info = JSON.parse(mReady[1]); } catch { /* 忽略解析失败 */ }
        state.port = info.port || port;
        if (pending) { pending.resolve(info); pending = null; }
        return;
      }
      const mAddr = ADDR_RE.exec(line);
      if (mAddr) { if (!state.addresses.includes(mAddr[1])) state.addresses.push(mAddr[1]); return; }
      const mErr = ERROR_RE.exec(line);
      if (mErr) {
        let info = {};
        try { info = JSON.parse(mErr[1]); } catch { /* 忽略 */ }
        if (pending) { pending.reject(new Error(info.message || '服务端启动失败')); pending = null; }
      }
    };

    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { handleLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    child.stderr.on('data', (d) => log('[stderr] ' + d.toString()));

    child.on('exit', (code) => {
      const wasActive = state.running || state.starting;
      child = null;
      state.running = false;
      state.starting = false;
      if (pending) { pending.reject(new Error(`服务端进程退出（code=${code}）`)); pending = null; }
      if (wasActive && !stopping) {
        state.error = `服务端进程意外退出（code=${code}）`;
        log('[embed] ' + state.error);
      }
      stopping = false;
      emit();
    });

    const timer = setTimeout(() => {
      if (pending) { pending.reject(new Error('服务端启动超时（15 秒）')); pending = null; }
    }, 15000);

    try {
      await ready;
    } catch (e) {
      clearTimeout(timer);
      state.starting = false;
      state.error = e.message;
      try { if (child) child.kill(); } catch { /* 忽略 */ }
      emit();
      return { success: false, error: e.message };
    }
    clearTimeout(timer);

    state.running = true;
    state.starting = false;
    state.port = state.port || port;
    state.token = cfg.token;
    state.url = `http://localhost:${state.port}`;
    if (!state.addresses.length) {
      state.addresses = lanAddresses().map((ip) => `http://${ip}:${state.port}`);
    }
    state.host = state.addresses[0] || state.url;
    emit();
    log(`[embed] 服务端就绪: ${state.url}（成员填写 ${state.host}）`);
    return { success: true, ...state, addresses: [...state.addresses] };
  }

  function stop() {
    return new Promise((resolve) => {
      if (!child) {
        state.running = false;
        state.starting = false;
        emit();
        return resolve({ success: true });
      }
      stopping = true;
      const c = child;
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve({ success: true }); } };
      c.once('exit', finish);
      try { c.kill(); } catch { /* 忽略 */ }
      setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* 忽略 */ } finish(); }, 3000);
      state.running = false;
      state.starting = false;
      emit();
    });
  }

  async function restart() {
    await stop();
    return start({});
  }

  function status() {
    const cfg = loadConfig();
    return {
      ...state,
      addresses: [...state.addresses],
      token: state.running ? state.token : (cfg.token || ''),
      configuredPort: cfg.port,
      version: version || '',
    };
  }

  function getConfig() { return loadConfig(); }

  function setConfig(patch = {}) {
    const cfg = { ...loadConfig(), ...patch };
    if (patch.backup) cfg.backup = { ...loadConfig().backup, ...patch.backup };
    saveConfig(cfg);
    return cfg;
  }

  function regenerateToken() {
    const cfg = loadConfig();
    cfg.token = crypto.randomBytes(24).toString('hex');
    saveConfig(cfg);
    if (state.running) state.token = cfg.token;
    return cfg.token;
  }

  function getDataRoot() { return dataRoot; }

  /* 用户浏览选择新的数据目录（创建团队时的弹窗）。
   * 迁移规则：不删除源目录；目标已存在的同名文件一律保留，绝不覆盖另一个团队的数据。
   * 令牌（server.config.json）是成员已授权的凭证，只有在目标没有自己的团队时才随数据一起搬，
   * 否则会出现「A 的令牌打开 B 的数据库」的串台。 */
  function setDataRoot(dir) {
    const target = String(dir || '').trim();
    if (!target) return { success: false, error: '目录不能为空' };
    if (!path.isAbsolute(target)) return { success: false, error: '请选择一个绝对路径' };

    const resolved = path.resolve(target);
    const current = path.resolve(dataRoot);
    /* 与当前一致就直接放行：重进「创建团队」时路径没改，不能被下面的运行中限制挡住 */
    if (resolved === current) return { success: true, changed: false, dataRoot, notes: [] };
    /* 目标落在当前目录里会导致 server-data 复制到自身内部 */
    if (resolved.startsWith(current + path.sep)) {
      return { success: false, error: '不能选择当前数据目录内部的子目录' };
    }
    /* 换目录才需要停机：运行中改会让 BAUDLAB_SERVER_CONFIG 与 BAUDLAB_SERVER_DIR 对不上。
     * code 供调用方判断是否可先 stop 再重试。 */
    if (state.running || state.starting) {
      return { success: false, code: 'running', error: '团队服务器正在运行，请先停止再修改数据目录' };
    }

    const notes = [];
    fs.mkdirSync(resolved, { recursive: true });
    const srcDb = path.join(current, 'server-data');
    const dstDb = path.join(resolved, 'server-data');
    const srcCfg = path.join(current, 'server.config.json');
    const dstCfg = path.join(resolved, 'server.config.json');
    const targetHasDb = fs.existsSync(path.join(dstDb, 'serial_protocol.db'));

    if (targetHasDb) {
      notes.push('目标目录已有团队数据库，已直接使用它（未覆盖）');
    } else {
      if (fs.existsSync(srcDb)) {
        fs.cpSync(srcDb, dstDb, { recursive: true });
        notes.push('已复制团队数据 server-data');
      }
      if (fs.existsSync(srcCfg) && !fs.existsSync(dstCfg)) {
        fs.copyFileSync(srcCfg, dstCfg);
        notes.push('已复制服务端配置（保留令牌）');
      }
    }

    dataRoot = resolved;
    configPath = path.join(dataRoot, 'server.config.json');
    log(`[embed] 数据目录已切换 → ${dataRoot}`);
    return { success: true, changed: true, dataRoot, notes };
  }

  return {
    start,
    stop,
    restart,
    status,
    getConfig,
    setConfig,
    regenerateToken,
    getDataRoot,
    setDataRoot,
    get running() { return state.running; },
  };
}

module.exports = { createTeamServer, lanAddresses };
