/**
 * 用户认证模块（主进程）
 *
 * 认证模型（v2，一刀切）：邮箱 + 密码登录，注册需邮箱验证码
 *   - 注册 / 登录 / 找回全部由团队服务器完成（SMTP 配置在服务器侧），
 *     本模块只负责调用服务器 /api/auth/* 接口并维护本机会话
 *   - 会话持久化：data/session.json（登录一次，本机后续启动自动恢复）
 *   - 记住密码：data/remember.json（safeStorage/DPAPI 本机加密；
 *     令牌过期后静默重登，重置密码后自动失效）
 *   - 本地模式（未连接团队服务器）没有邮件通道，不支持邮箱登录/注册，
 *     通过 auth:local-enter 选择/添加"本地身份"进入（无密码，仅存在于本机
 *     SQLite，不签发服务器令牌，无法访问团队数据）。本地身份与会话文件中的
 *     服务器身份字段分开存储，重连团队后邮箱会话仍可自动续上
 *
 * 旧"选择身份 / 快速添加用户"模型已移除：无密码身份行不能再进入团队模式
 */
const fs = require('fs');
const path = require('path');

const electron = require('electron');
const ipcMainApi = electron.ipcMain || null;
const safeStorage = electron.safeStorage || null;

let db = null;
let dataDir = '';
let sessionFile = '';
let rememberFile = '';
let currentSession = null;
let remoteActiveFn = null;
let remoteRequestFn = null;

let rememberStore = { version: 1, credentials: {} };

/* 用户行 → 渲染层用户对象 */
function toUserInfo(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.display_name || row.username,
    username: row.username,
    email: row.email || '',
    department: row.department || '',
    project: row.project || '',
    module: row.module || '',
    role: row.role_name || '',
    isAdmin: row.role_name === '管理员',
    hasPassword: !!row.password_hash,
    status: row.status,
  };
}

/* ==================== 记住密码（本机免验证） ==================== */

function loadRememberStore() {
  try {
    if (rememberFile && fs.existsSync(rememberFile)) {
      const data = JSON.parse(fs.readFileSync(rememberFile, 'utf8'));
      if (data && data.credentials) rememberStore = data;
    }
  } catch { /* 文件损坏时视为无记住凭据 */ }
}

function saveRememberStore() {
  try {
    fs.writeFileSync(rememberFile, JSON.stringify(rememberStore), 'utf8');
  } catch (e) {
    console.warn('[Auth] 记住密码写入失败:', e.message);
  }
}

/** 保存免验证凭据（safeStorage/DPAPI 本机加密，仅本机当前系统用户可解） */
function rememberPasswordFor(userId, username, password) {
  if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
    console.warn('[Auth] 系统不支持安全加密，无法记住密码');
    return;
  }
  try {
    const enc = safeStorage.encryptString(String(password)).toString('base64');
    rememberStore.credentials[String(userId)] = { username, enc, savedAt: Date.now() };
    saveRememberStore();
  } catch (e) {
    console.warn('[Auth] 记住密码保存失败:', e.message);
  }
}

function clearRememberedPassword(userId) {
  const key = String(userId);
  if (rememberStore.credentials[key]) {
    delete rememberStore.credentials[key];
    saveRememberStore();
  }
}

/** 取出本机记住的凭据（明文密码）；解密失败视为无凭据并清除 */
function getRememberedPassword(userId) {
  const entry = rememberStore.credentials[String(userId)];
  if (!entry || !entry.enc) return null;
  try {
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) return null;
    return safeStorage.decryptString(Buffer.from(entry.enc, 'base64'));
  } catch {
    clearRememberedPassword(userId);
    return null;
  }
}

/* ==================== 会话文件 ==================== */

function writeSession(userId, username, token, tokenExpires, displayName) {
  currentSession = {
    userId,
    username,
    token: token || '',
    tokenExpires: tokenExpires || 0,
    loginAt: Date.now(),
    displayName: displayName || '',
  };
  persistSession();
}

function persistSession() {
  if (!currentSession) return;
  try {
    fs.writeFileSync(sessionFile, JSON.stringify(currentSession), 'utf8');
  } catch (e) {
    console.warn('[Auth] 会话写入失败:', e.message);
  }
}

function clearSession() {
  currentSession = null;
  try {
    if (fs.existsSync(sessionFile)) fs.unlinkSync(sessionFile);
  } catch (e) {
    console.warn('[Auth] 会话清除失败:', e.message);
  }
}

/** 同步读取会话文件（currentSession 未初始化时的冷启动回退） */
function readSessionFile() {
  try {
    if (sessionFile && fs.existsSync(sessionFile)) {
      return JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    }
  } catch { /* 会话文件损坏时视为无会话 */ }
  return null;
}

/**
 * 写入本地身份字段（不动服务器身份字段：userId/username/token 原样保留，
 * 重连团队服务器后邮箱会话仍可自动续上）
 */
function writeLocalSession(userId, username, displayName) {
  currentSession = currentSession || readSessionFile() || {
    userId: 0, username: '', token: '', tokenExpires: 0, loginAt: Date.now(),
  };
  currentSession.localUserId = userId;
  currentSession.localUsername = username;
  if (displayName) currentSession.localDisplayName = displayName;
  currentSession.localLoginAt = Date.now();
  persistSession();
}

/** 网关身份透传：返回当前操作人 { username, token }；未登录返回 null */
function getSessionUser() {
  if (currentSession && currentSession.username) {
    return { username: currentSession.username, token: currentSession.token || '' };
  }
  /* 冷启动回退：主进程初始化尚未跑完时同步读会话文件，
   * 只取身份字段做请求头透传，不做远程校验（那条路径走 readSession） */
  try {
    if (sessionFile && fs.existsSync(sessionFile)) {
      const s = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
      if (s && s.username) return { username: s.username, token: s.token || '' };
    }
  } catch { /* 会话文件损坏时视为未登录 */ }
  return null;
}

/* ==================== 远程请求 ==================== */

/** 团队模式才可用；返回请求函数或 null */
function requireRemote() {
  if (remoteActiveFn && remoteActiveFn() && remoteRequestFn) return remoteRequestFn;
  return null;
}

/* ==================== 会话恢复 ==================== */

/**
 * 启动时恢复会话
 * @returns {Promise<{status: 'none'|'logged-in'|'expired'|'unreachable', user: object|null, error?: string}>}
 *   - none：本机无会话（首启/已退出）
 *   - logged-in：会话有效（令牌有效或记住密码静默续期成功）
 *   - expired：会话失效，需要重新登录（不区分密码错误/被禁用，客户端统一提示）
 *   - unreachable：服务器暂时不可达（保留会话文件，恢复后可自动续上）
 */
async function readSession() {
  try {
    if (!fs.existsSync(sessionFile)) return { status: 'none', user: null };
    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    /* 纯本地会话（从未邮箱登录）没有 userId，只有 localUserId，同样走本地恢复 */
    if (!session || (!session.userId && !session.localUserId)) return { status: 'none', user: null };

    const remote = requireRemote();
    if (remote) {
      if (!session.userId) return { status: 'none', user: null };
      const q = await remote('/api/query', {
        sql: `SELECT u.*, r.name AS role_name
              FROM users u LEFT JOIN roles r ON u.role_id = r.id
              WHERE u.id = ?`,
        params: [session.userId],
      });
      /* 网络故障 ≠ 会话失效：保留会话文件，服务器恢复后自动续上 */
      if (!q.success) return { status: 'unreachable', user: null, error: q.error || '无法连接团队服务器' };
      const user = q.rows && q.rows[0];
      if (!user || user.status !== 'active') {
        clearSession();
        return { status: 'expired', user: null };
      }
      currentSession = {
        ...session,
        userId: session.userId,
        username: user.username,
        token: session.token || '',
        tokenExpires: session.tokenExpires || 0,
        loginAt: session.loginAt || Date.now(),
      };

      const tokenUsable = currentSession.token && currentSession.tokenExpires > Date.now();
      if (tokenUsable) {
        /* 服务端二次确认：用户可能已被禁用/令牌已被吊销 */
        const check = await remote('/api/auth/session-check', {});
        if (check.success && check.user) {
          persistSession();
          return { status: 'logged-in', user: toUserInfo(user) };
        }
      }

      /* 令牌失效：勾选过"记住密码"时用本机凭据静默重登 */
      const remembered = getRememberedPassword(user.id);
      if (remembered && user.email) {
        const login = await remote('/api/auth/login', { email: user.email, password: remembered });
        if (login.success && login.token) {
          currentSession.token = login.token;
          currentSession.tokenExpires = login.expiresAt || 0;
          persistSession();
          return { status: 'logged-in', user: toUserInfo(user) };
        }
        /* 记住的密码已失效（服务端改密/重置）：清除本地凭据，要求重新登录 */
        clearRememberedPassword(user.id);
      }
      return { status: 'expired', user: null };
    }

    /* 本地模式：恢复本地身份（不签发令牌，无法访问团队数据）。
     * id + username 双重匹配：本地库与服务器库各自独立自增，仅按 id 匹配
     * 可能命中同 id 的另一人。身份缺失时保留会话文件（服务器字段不动），
     * 返回 none 静默进入本地身份选择，绝不因本地身份缺失销毁服务器会话 */
    if (!db) return { status: 'none', user: null };
    const localId = session.localUserId || session.userId;
    const localName = session.localUsername || session.username;
    if (localId && localName) {
      const user = db.prepare(`
        SELECT u.*, r.name AS role_name
        FROM users u LEFT JOIN roles r ON u.role_id = r.id
        WHERE u.id = ? AND u.username = ?
      `).get(localId, localName);
      if (user && user.status === 'active') {
        currentSession = session;
        currentSession.localLoginAt = Date.now();
        persistSession();
        return { status: 'logged-in', user: toUserInfo(user) };
      }
    }
    return { status: 'none', user: null };
  } catch (e) {
    console.warn('[Auth] 会话恢复失败:', e.message);
    return { status: 'expired', user: null };
  }
}

/* ==================== 用户列表（人员管理页用） ==================== */

async function handleListUsers(params) {
  const forceLocal = !!(params && params.forceLocal);
  const sql = `
    SELECT u.*, r.name AS role_name
    FROM users u LEFT JOIN roles r ON u.role_id = r.id
    WHERE u.status = 'active'
    ORDER BY u.id
  `;
  try {
    let rows;
    if (!forceLocal && requireRemote()) {
      const result = await remoteRequestFn('/api/query', { sql, params: [] });
      if (!result.success) return { success: false, error: result.error, users: [] };
      rows = result.rows || [];
    } else if (db) {
      rows = db.prepare(sql).all();
    } else {
      return { success: false, error: '数据源未就绪', users: [] };
    }
    return { success: true, users: rows.map(toUserInfo) };
  } catch (e) {
    return { success: false, error: e.message, users: [] };
  }
}

/* ==================== 本地身份（本地模式进入） ==================== */

const USER_SELECT_SQL = `
  SELECT u.*, r.name AS role_name
  FROM users u LEFT JOIN roles r ON u.role_id = r.id
  WHERE u.id = ?
`;

/**
 * 本地模式进入/建立身份（不经过服务器，无密码，仅本机 SQLite）
 * @param {object} params
 *   - { userId }：选择已有本地身份
 *   - { username, displayName?, project?, module? }：选择或创建同名本地身份
 *   - {}（auto）：从会话恢复本地身份；仅有服务器会话时按用户名在本机落一行同名身份
 * 成功后写入会话的本地身份字段（服务器令牌字段不动）
 */
async function handleLocalEnter(params) {
  if (requireRemote()) return { success: false, error: '团队模式请使用邮箱登录' };
  if (!db) return { success: false, error: '本地数据库未就绪' };
  const p = params || {};
  try {
    if (p.userId) {
      const user = db.prepare(USER_SELECT_SQL).get(Number(p.userId));
      if (!user || user.status !== 'active') return { success: false, error: '该本地身份不可用' };
      writeLocalSession(user.id, user.username, user.display_name || user.username);
      return { success: true, user: toUserInfo(user) };
    }

    const username = String(p.username || '').trim();
    if (username) {
      if (username.length > 32) return { success: false, error: '用户名过长（最多 32 字）' };
      let user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
      if (!user) {
        const role = db.prepare("SELECT id FROM roles WHERE name = '工程师'").get()
          || db.prepare('SELECT id FROM roles ORDER BY id LIMIT 1').get();
        const displayName = String(p.displayName || '').trim() || username;
        const info = db.prepare(`
          INSERT INTO users (username, display_name, email, role_id, project, module, status)
          VALUES (?, ?, NULL, ?, ?, ?, 'active')
        `).run(username, displayName, role ? role.id : null,
          String(p.project || '').trim(), String(p.module || '').trim());
        user = db.prepare(USER_SELECT_SQL).get(info.lastInsertRowid);
      } else if (user.status !== 'active') {
        return { success: false, error: '同名本地身份已被停用' };
      }
      writeLocalSession(user.id, user.username, user.display_name || user.username);
      return { success: true, user: toUserInfo(user) };
    }

    /* auto：优先恢复上次本地身份；否则沿用会话里的用户名（邮箱登录过的账号）在本机建立同名身份 */
    const session = readSessionFile();
    if (session) {
      if (session.localUserId && session.localUsername) {
        const user = db.prepare(USER_SELECT_SQL).get(session.localUserId);
        if (user && user.username === session.localUsername && user.status === 'active') {
          writeLocalSession(user.id, user.username, user.display_name || user.username);
          return { success: true, user: toUserInfo(user) };
        }
      }
      const carried = String(session.localUsername || session.username || '').trim();
      if (carried) {
        return handleLocalEnter({ username: carried, displayName: session.localDisplayName || session.displayName || '' });
      }
    }
    return { success: false, error: '本机还没有本地身份' };
  } catch (e) {
    return { success: false, error: e.message || String(e) };
  }
}

/* ==================== 邮箱登录 / 注册 / 找回 ==================== */

/** 登录：邮箱 + 密码 → 令牌 + 会话；勾选记住密码时本机加密保存 */
async function handleLogin(params) {
  const remote = requireRemote();
  if (!remote) return { success: false, error: '邮箱登录需要连接团队服务器' };
  const email = String((params && params.email) || '').trim();
  const password = String((params && params.password) || '');
  const remember = !!(params && params.remember);
  if (!email || !password) return { success: false, error: '请输入邮箱和密码' };

  let result;
  try {
    result = await remote('/api/auth/login', { email, password });
  } catch (e) {
    return { success: false, error: '无法连接团队服务器：' + (e.message || e) };
  }
  if (!result.success || !result.token) {
    return { success: false, error: result.error || '邮箱或密码错误' };
  }
  if (remember && result.user && result.user.id) {
    rememberPasswordFor(result.user.id, result.user.username, password);
  }
  writeSession(result.user.id, result.user.username, result.token, result.expiresAt || 0, result.user.name || '');
  return { success: true, user: result.user };
}

/** 注册·第一步：请求发送邮箱验证码 */
async function handleRegisterRequest(params) {
  const remote = requireRemote();
  if (!remote) return { success: false, error: '注册需要连接团队服务器' };
  try {
    return await remote('/api/auth/register-request', { email: String((params && params.email) || '').trim() });
  } catch (e) {
    return { success: false, error: '无法连接团队服务器：' + (e.message || e) };
  }
}

/** 注册·第二步：验证码 + 设置密码 → 建号；成功即登录 */
async function handleRegisterVerify(params) {
  const remote = requireRemote();
  if (!remote) return { success: false, error: '注册需要连接团队服务器' };
  let result;
  try {
    result = await remote('/api/auth/register-verify', {
      email: String((params && params.email) || '').trim(),
      code: String((params && params.code) || '').trim(),
      password: String((params && params.password) || ''),
      displayName: String((params && params.displayName) || '').trim(),
    });
  } catch (e) {
    return { success: false, error: '无法连接团队服务器：' + (e.message || e) };
  }
  if (!result.success || !result.token) {
    return { success: false, error: result.error || '注册失败' };
  }
  writeSession(result.user.id, result.user.username, result.token, result.expiresAt || 0, result.user.name || '');
  return { success: true, user: result.user };
}

/** 找回密码·第一步：请求发送重置验证码（服务端防枚举，文案统一） */
async function handleForgotRequest(params) {
  const remote = requireRemote();
  if (!remote) return { success: false, error: '找回密码需要连接团队服务器' };
  try {
    return await remote('/api/auth/forgot-request', { email: String((params && params.email) || '').trim() });
  } catch (e) {
    return { success: false, error: '无法连接团队服务器：' + (e.message || e) };
  }
}

/** 找回密码·第二步：验证码 + 新密码；成功后清除本机记住的旧凭据 */
async function handleResetPassword(params) {
  const remote = requireRemote();
  if (!remote) return { success: false, error: '找回密码需要连接团队服务器' };
  let result;
  try {
    result = await remote('/api/auth/reset-password', {
      email: String((params && params.email) || '').trim(),
      code: String((params && params.code) || '').trim(),
      password: String((params && params.password) || ''),
    });
  } catch (e) {
    return { success: false, error: '无法连接团队服务器：' + (e.message || e) };
  }
  if (!result.success) return { success: false, error: result.error || '重置失败' };
  if (result.userId) clearRememberedPassword(result.userId);
  return { success: true, message: result.message || '密码已重置，请使用新密码登录' };
}

/* ==================== 修改密码（登录后自助） ==================== */

async function handleChangePassword(userId, oldPassword, newPassword) {
  const id = Number(userId);
  if (!Number.isFinite(id)) return { success: false, error: '参数错误' };
  if (String(newPassword || '').length < 8) {
    return { success: false, error: '新密码至少 8 位' };
  }

  let user;
  if (requireRemote()) {
    const result = await remoteRequestFn('/api/query', {
      sql: 'SELECT id, password_hash FROM users WHERE id = ?',
      params: [id],
    });
    if (!result.success || !result.rows || result.rows.length === 0) {
      return { success: false, error: '用户不存在' };
    }
    user = result.rows[0];
  } else if (db) {
    user = db.prepare('SELECT id, password_hash FROM users WHERE id = ?').get(id);
  }
  if (!user) return { success: false, error: '用户不存在' };
  if (!user.password_hash) return { success: false, error: '当前用户未设置密码' };

  const { hashPassword, verifyPassword } = require('./db-schema');
  if (!verifyPassword(String(oldPassword || ''), user.password_hash)) {
    return { success: false, error: '旧密码错误' };
  }

  const sql = 'UPDATE users SET password_hash = ? WHERE id = ?';
  const params = [hashPassword(String(newPassword)), id];
  if (requireRemote()) {
    const result = await remoteRequestFn('/api/execute', { sql, params });
    if (!result.success) return { success: false, error: result.error || '修改失败' };
  } else {
    db.prepare(sql).run(...params);
  }
  /* 旧密码的记住凭据随即失效 */
  clearRememberedPassword(id);
  return { success: true };
}

/* ==================== 模块初始化 ==================== */

function initAuth(dbHandle, dataDirPath, remoteFns = {}) {
  db = dbHandle;
  dataDir = dataDirPath;
  sessionFile = path.join(dataDir, 'session.json');
  rememberFile = path.join(dataDir, 'remember.json');
  loadRememberStore();
  remoteActiveFn = remoteFns.isRemoteActive || null;
  remoteRequestFn = remoteFns.remoteDbRequest || null;

  if (ipcMainApi) {
    ipcMainApi.handle('auth:list-users', (event, params) => handleListUsers(params || {}));
    ipcMainApi.handle('auth:get-session', () => readSession());
    ipcMainApi.handle('auth:local-enter', (event, params) => handleLocalEnter(params || {}));
    ipcMainApi.handle('auth:logout', () => {
      clearSession();
      return { success: true };
    });
    ipcMainApi.handle('auth:login', (event, params) => handleLogin(params || {}));
    ipcMainApi.handle('auth:register-request', (event, params) => handleRegisterRequest(params || {}));
    ipcMainApi.handle('auth:register-verify', (event, params) => handleRegisterVerify(params || {}));
    ipcMainApi.handle('auth:forgot-request', (event, params) => handleForgotRequest(params || {}));
    ipcMainApi.handle('auth:reset-password', (event, params) => handleResetPassword(params || {}));
    ipcMainApi.handle('auth:change-password', (event, params) => {
      return handleChangePassword(params.userId, params.oldPassword, params.newPassword);
    });
  }
}

module.exports = { initAuth, handleListUsers, readSession, handleLocalEnter, clearSession, getSessionUser };
