/**
 * 数据库 Schema 共享模块
 * 桌面端 main.js 与团队服务器 server.js 共用，保证两端表结构一致
 */
const crypto = require('crypto');
const { insertDefaultProtocol } = require('./default-protocol-data');

/**
 * scrypt 加盐哈希（旧版兼容，新版用户切换模式不再使用密码）
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

/**
 * 密码校验（timingSafeEqual 防时序攻击），供桌面端与服务器端共用
 */
function verifyPassword(password, stored) {
  try {
    if (!stored || !stored.includes(':')) return false;
    const [salt, hash] = stored.split(':');
    const actual = crypto.scryptSync(password, salt, 64);
    const expected = Buffer.from(hash, 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

const DEFAULT_ADMIN_EMAIL = 'admin@local';


const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS protocols (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    version     TEXT DEFAULT 'v1.0.0',
    frame_mode  TEXT DEFAULT 'fixed',
    frame_length INTEGER DEFAULT 0,
    byte_order  TEXT DEFAULT 'little',
    check_method TEXT DEFAULT 'CRC16-MODBUS',
    check_start TEXT DEFAULT 'SOF',
    check_end   TEXT DEFAULT 'DATA',
    config_json TEXT DEFAULT '{}',
    current_version_id INTEGER DEFAULT NULL,
    created_at  TEXT DEFAULT (datetime('now','localtime')),
    updated_at  TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS commands (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    protocol_id INTEGER NOT NULL,
    code        TEXT NOT NULL,
    name        TEXT NOT NULL,
    sender      TEXT DEFAULT '',
    receiver    TEXT DEFAULT '',
    period_ms   INTEGER DEFAULT 1000,
    direction   TEXT DEFAULT 'send',
    config_json TEXT DEFAULT '{}',
    FOREIGN KEY (protocol_id) REFERENCES protocols(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS modules (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    protocol_id INTEGER NOT NULL,
    name        TEXT NOT NULL,
    address     TEXT NOT NULL,
    FOREIGN KEY (protocol_id) REFERENCES protocols(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    change_id   TEXT NOT NULL,
    protocol_name TEXT,
    change_type TEXT,
    applicant   TEXT,
    assignee    TEXT DEFAULT '',
    scope       TEXT,
    status      TEXT DEFAULT 'pending',
    diff_json   TEXT DEFAULT '{}',
    opinion     TEXT DEFAULT '',
    created_at  TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS serial_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    port_path   TEXT NOT NULL,
    direction   TEXT NOT NULL,
    data_hex    TEXT,
    data_text   TEXT,
    timestamp   TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS protocol_versions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    protocol_id   INTEGER NOT NULL,
    protocol_name TEXT NOT NULL,
    version       TEXT NOT NULL,
    config_json   TEXT NOT NULL,
    status        TEXT DEFAULT 'published',
    created_by    TEXT DEFAULT '',
    created_at    TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (protocol_id) REFERENCES protocols(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS roles (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    description TEXT DEFAULT '',
    permissions TEXT DEFAULT '{}',
    created_at  TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT NOT NULL UNIQUE,
    display_name TEXT DEFAULT '',
    email       TEXT UNIQUE,
    password_hash TEXT DEFAULT '',
    role_id     INTEGER,
    department  TEXT DEFAULT '',
    project     TEXT DEFAULT '',
    module      TEXT DEFAULT '',
    status      TEXT DEFAULT 'active',
    last_login  TEXT,
    created_at  TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS email_verifications (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    email       TEXT NOT NULL,
    purpose     TEXT NOT NULL DEFAULT 'register',
    code_hash   TEXT NOT NULL,
    expires_at  INTEGER NOT NULL,
    attempts    INTEGER DEFAULT 0,
    used_at     INTEGER DEFAULT NULL,
    created_at  INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_email_verif_lookup ON email_verifications(email, purpose);

  CREATE TABLE IF NOT EXISTS email_verifications (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    email       TEXT NOT NULL,
    purpose     TEXT NOT NULL DEFAULT 'register',
    code_hash   TEXT NOT NULL,
    expires_at  INTEGER NOT NULL,
    attempts    INTEGER DEFAULT 0,
    used_at     INTEGER DEFAULT NULL,
    created_at  INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_email_verif_lookup ON email_verifications(email, purpose);

  CREATE TABLE IF NOT EXISTS app_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    level       TEXT DEFAULT 'info',
    category    TEXT DEFAULT 'system',
    source      TEXT DEFAULT '',
    message     TEXT NOT NULL,
    created_at  TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS projects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    description TEXT DEFAULT '',
    color       TEXT DEFAULT '#3b82f6',
    created_at  TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    recipient   TEXT NOT NULL,
    type        TEXT DEFAULT 'info',
    title       TEXT NOT NULL,
    body        TEXT DEFAULT '',
    link_id     TEXT DEFAULT '',
    link_type   TEXT DEFAULT '',
    is_read     INTEGER DEFAULT 0,
    created_at  TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications(recipient);
  CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(is_read);

  CREATE INDEX IF NOT EXISTS idx_app_logs_time ON app_logs(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_app_logs_level ON app_logs(level);
`;

/**
 * 初始化表结构 + 默认数据（角色/管理员）
 * 桌面端与服务器端共用；幂等，可重复执行
 * @param {import('better-sqlite3').Database} db
 */
function initSchema(db) {
  db.exec(SCHEMA_SQL);

  /* 插入默认角色（若不存在） */
  const roleCount = db.prepare('SELECT COUNT(*) as cnt FROM roles').get();
  if (roleCount.cnt === 0) {
    const insertRole = db.prepare('INSERT INTO roles (name, description) VALUES (?, ?)');
    insertRole.run('管理员', '全部权限，包含用户管理、系统配置、数据库管理');
    insertRole.run('工程师', '协议配置、调试、提交变更');
  }

  /* 迁移旧角色名（幂等） */
  db.prepare("UPDATE roles SET name = '管理员', description = '全部权限，包含用户管理、系统配置、数据库管理' WHERE name = '系统管理员'").run();
  db.prepare("UPDATE roles SET name = '工程师', description = '协议配置、调试、提交变更' WHERE name = '协议工程师'").run();

  /* ---- users 表升级（旧库迁移，幂等） ---- */
  /* 1) 补齐新列：email / password_hash / project / module / api_token / api_token_expires */
  const userColumns = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  for (const [col, type] of [
    ['email', 'TEXT DEFAULT ""'],
    ['password_hash', 'TEXT DEFAULT ""'],
    ['project', 'TEXT DEFAULT ""'],
    ['module', 'TEXT DEFAULT ""'],
    ['api_token', 'TEXT DEFAULT ""'],
    ['api_token_expires', 'INTEGER DEFAULT 0'],
    ['email_verified', 'INTEGER DEFAULT 0'],
  ]) {
    if (!userColumns.includes(col)) {
      db.prepare(`ALTER TABLE users ADD COLUMN ${col} ${type}`).run();
    }
  }

  /* 2) 旧数据回填：早期版本 username 存的是邮箱，迁移到 email 列 */
  db.prepare("UPDATE users SET email = username WHERE (email IS NULL OR email = '') AND username LIKE '%_@_%._%'").run();

  /* 3) 旧版内置管理员停用（admin / 内置默认密码）：新版登录为邮箱 + 密码，
   * 内置账号不再有可用入口；行保留以维持历史审计/通知记录中的姓名引用，
   * 当前无可登录管理员时服务端会将首位注册者引导为管理员。
   * 必须在新列迁移之后执行（旧库此时才刚补齐 api_token 等列） */
  try {
    db.prepare(`UPDATE users SET status = 'locked', api_token = '', api_token_expires = 0
      WHERE username = 'admin' AND (email IS NULL OR email = '' OR email = ?)`)
      .run(DEFAULT_ADMIN_EMAIL);
  } catch (e) {
    console.warn('[Schema] 旧内置管理员停用失败:', e.message);
  }

  /* 4) email 唯一索引（注册查重的最终防线；SQLite 唯一索引允许多个 NULL，但不允许多个空串） */
  /* 先将空串 email 统一转为 NULL，避免迁移列 DEFAULT "" 产生多个空串导致唯一索引冲突 */
  try {
    db.prepare("UPDATE users SET email = NULL WHERE email = ''").run();
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)');
  } catch (e) {
    console.warn('[Schema] users.email 唯一索引创建失败:', e.message);
  }

  /* audit_logs 表升级：添加 assignee 列（若不存在） */
  try {
    db.prepare('ALTER TABLE audit_logs ADD COLUMN assignee TEXT DEFAULT ""').run();
  } catch {
    /* 列已存在，忽略 */
  }

  /* audit_logs 表升级：添加 snapshot_json、version、base_version_id 列 */
  try {
    db.prepare('ALTER TABLE audit_logs ADD COLUMN snapshot_json TEXT DEFAULT ""').run();
  } catch { /* 列已存在 */ }
  try {
    db.prepare('ALTER TABLE audit_logs ADD COLUMN version TEXT DEFAULT ""').run();
  } catch { /* 列已存在 */ }
  try {
    db.prepare('ALTER TABLE audit_logs ADD COLUMN base_version_id INTEGER DEFAULT NULL').run();
  } catch { /* 列已存在 */ }

  /* protocols 表升级：添加 current_version_id 列 */
  try {
    db.prepare('ALTER TABLE protocols ADD COLUMN current_version_id INTEGER DEFAULT NULL').run();
  } catch { /* 列已存在 */ }

  /* protocol_versions 表升级：添加 protocol_id、status 列 */
  try {
    db.prepare('ALTER TABLE protocol_versions ADD COLUMN protocol_id INTEGER DEFAULT NULL').run();
  } catch { /* 列已存在 */ }
  try {
    db.prepare('ALTER TABLE protocol_versions ADD COLUMN status TEXT DEFAULT "published"').run();
  } catch { /* 列已存在 */ }

  /* 数据迁移：为 protocol_versions 已有记录回填 protocol_id（按 protocol_name 关联 protocols.id） */
  try {
    /* protocol_id 为 NULL 或指向已删除协议行（dangling）的版本行都按名称回填归属 */
    const orphans = db.prepare(
      `SELECT pv.id AS pv_id, pv.protocol_name FROM protocol_versions pv
       LEFT JOIN protocols p ON pv.protocol_name = p.name
       WHERE pv.protocol_id IS NULL
          OR pv.protocol_id NOT IN (SELECT id FROM protocols)`,
    ).all();
    for (const o of orphans) {
      const proto = db.prepare('SELECT id FROM protocols WHERE name = ? ORDER BY id DESC LIMIT 1').get(o.protocol_name);
      if (proto) {
        db.prepare('UPDATE protocol_versions SET protocol_id = ? WHERE id = ?').run(proto.id, o.pv_id);
      }
    }
  } catch (e) {
    console.warn('[Schema] protocol_versions.protocol_id 回填失败:', e.message);
  }

  /* 数据迁移：为 protocols 回填 current_version_id（指向最新的 published 版本） */
  try {
    const protos = db.prepare('SELECT id FROM protocols WHERE current_version_id IS NULL').all();
    for (const p of protos) {
      const latest = db.prepare('SELECT id FROM protocol_versions WHERE protocol_id = ? AND status = ? ORDER BY id DESC LIMIT 1').get(p.id, 'published');
      if (latest) {
        db.prepare('UPDATE protocols SET current_version_id = ? WHERE id = ?').run(latest.id, p.id);
      }
    }
  } catch (e) {
    console.warn('[Schema] protocols.current_version_id 回填失败:', e.message);
  }

  /* protocol_versions 索引：按 protocol_id 查询 */
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_pv_protocol_id ON protocol_versions(protocol_id)');
  } catch (e) {
    console.warn('[Schema] protocol_versions.protocol_id 索引创建失败:', e.message);
  }

  /* protocols.name 唯一索引：
   * 建索引前先清理历史重名行（孤儿数据修复前可能产生），保留每组最新一行（id 最大），
   * 旧行及其子表数据一并删除；索引作为并发重名的最终防线（应用层预检提供友好提示） */
  try {
    const dupes = db.prepare('SELECT name, COUNT(*) AS c FROM protocols GROUP BY name HAVING c > 1').all();
    for (const d of dupes) {
      const keep = db.prepare('SELECT id FROM protocols WHERE name = ? ORDER BY id DESC LIMIT 1').get(d.name);
      db.prepare('DELETE FROM commands WHERE protocol_id IN (SELECT id FROM protocols WHERE name = ? AND id != ?)').run(d.name, keep.id);
      db.prepare('DELETE FROM modules WHERE protocol_id IN (SELECT id FROM protocols WHERE name = ? AND id != ?)').run(d.name, keep.id);
      db.prepare('DELETE FROM protocols WHERE name = ? AND id != ?').run(d.name, keep.id);
    }
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_protocols_name ON protocols(name)');
  } catch (e) {
    console.warn('[Schema] protocols.name 唯一索引创建失败:', e.message);
  }

  /* protocols.project 列：协议归档到项目（空字符串=未归档） */
  try {
    const protoCols = db.prepare('PRAGMA table_info(protocols)').all().map(c => c.name);
    if (!protoCols.includes('project')) {
      db.prepare('ALTER TABLE protocols ADD COLUMN project TEXT DEFAULT ""').run();
    }
  } catch (e) {
    console.warn('[Schema] protocols.project 列添加失败:', e.message);
  }

  /* 迁移：将 protocols.project 中已有的项目名导入 projects 表（幂等） */
  try {
    const existing = db.prepare("SELECT DISTINCT project FROM protocols WHERE project != ''").all();
    const insertProj = db.prepare('INSERT OR IGNORE INTO projects (name) VALUES (?)');
    for (const row of existing) {
      insertProj.run(row.project);
    }
  } catch (e) {
    console.warn('[Schema] projects 迁移失败:', e.message);
  }

  /* projects.color 列迁移（旧库补列） */
  try {
    const projCols = db.prepare('PRAGMA table_info(projects)').all().map(c => c.name);
    if (!projCols.includes('color')) {
      db.prepare('ALTER TABLE projects ADD COLUMN color TEXT DEFAULT "#3b82f6"').run();
    }
  } catch (e) {
    console.warn('[Schema] projects.color 列添加失败:', e.message);
  }

  /* 插入默认协议：步进电机控制驱动协议 v1.0.0（幂等：已存在则跳过） */
  try {
    const inserted = insertDefaultProtocol(db);
    if (inserted) {
      console.log('[Schema] 默认协议 步进电机控制驱动协议 v1.0.0 已插入');
    }
  } catch (e) {
    console.warn('[Schema] 默认协议插入失败:', e.message);
  }
}

/**
 * 写入应用日志（幂等，失败静默）
 * @param {import('better-sqlite3').Database} db
 * @param {string} level - info / warn / error / debug
 * @param {string} category - system / auth / protocol / serial / database / update / network
 * @param {string} source - 来源（如 main / server / auth / preload）
 * @param {string} message - 日志内容
 */
function logEvent(db, level, category, source, message) {
  try {
    db.prepare('INSERT INTO app_logs (level, category, source, message) VALUES (?, ?, ?, ?)')
      .run(level, category, source, message);
  } catch (e) {
    console.warn('[logEvent] 写入失败:', e.message);
  }
}

module.exports = { SCHEMA_SQL, initSchema, hashPassword, verifyPassword, logEvent, DEFAULT_ADMIN_EMAIL };
