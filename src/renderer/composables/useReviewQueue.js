/**
 * 审核队列 composable
 * 在协议配置和变更审核两个页面间共享审核数据
 * 数据持久化到 SQLite audit_logs 表
 */
import { ref, computed } from 'vue';
import { useNotifications } from './useNotifications';

/* 模块级共享状态：所有组件共用 */
const reviewQueue = ref([]);
const isLoaded = ref(false);

/* 自增序号计数器 */
let crCounter = 1;

/**
 * 从数据库加载全部审核记录
 * @param {boolean} force - 是否强制刷新（忽略已加载状态，用于轮询和手动刷新）
 */
async function loadFromDatabase(force = false) {
  if (typeof window === 'undefined' || !window.electronAPI?.db) {
    isLoaded.value = true;
    return;
  }
  if (!force && isLoaded.value) return;
  try {
    const result = await window.electronAPI.db.query(
      'SELECT change_id, protocol_name, change_type, applicant, assignee, scope, status, diff_json, opinion, snapshot_json, version, base_version_id, created_at FROM audit_logs ORDER BY id DESC',
    );
    if (result.success && result.rows) {
      reviewQueue.value = result.rows.map(r => ({
        changeId: r.change_id,
        title: r.protocol_name,
        type: r.change_type,
        applicant: r.applicant,
        assignee: r.assignee || '',
        time: r.created_at,
        scope: r.scope,
        status: r.status,
        diff: (() => { try { return JSON.parse(r.diff_json || '[]'); } catch { return []; } })(),
        opinion: r.opinion || '',
        snapshot: r.snapshot_json || '',
        version: r.version || '',
        baseVersionId: r.base_version_id || null,
      }));

      /* 从已有 change_id 推算计数器 */
      const maxNum = result.rows.reduce((max, r) => {
        const m = r.change_id?.match(/CR-\d+-(\d+)/);
        return m ? Math.max(max, parseInt(m[1], 10)) : max;
      }, 0);
      crCounter = maxNum + 1;
    }
  } catch {
    /* ignore */
  }
  isLoaded.value = true;
}

/**
 * 提交审核：将协议变更加入审核队列并写入数据库
 * @param {object} proto - 协议信息 { name, version, type?, applicant?, assignee }
 * @returns {string} 生成的变更单号
 */
async function submitReview(proto) {
  const changeId = `CR-${new Date().getFullYear()}-${String(crCounter++).padStart(4, '0')}`;
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const timeStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

  const entry = {
    changeId,
    title: proto.name,
    type: proto.type || '协议变更',
    applicant: proto.applicant || '当前用户',
    assignee: proto.assignee || '',
    time: timeStr,
    scope: proto.scope || '协议配置',
    status: 'pending',
    diff: proto.diff || [{ old: '—', new: '等待审核人员查看具体变更' }],
    opinion: '',
    snapshot: proto.snapshot || '',
    version: proto.version || '',
    baseVersionId: proto.baseVersionId || null,
  };

  reviewQueue.value.unshift(entry);

  /* 写入数据库（快照 + base_version_id 存在审核记录中，通过后才发版到 protocol_versions） */
  if (typeof window !== 'undefined' && window.electronAPI?.db) {
    const result = await window.electronAPI.db.execute(
      'INSERT INTO audit_logs (change_id, protocol_name, change_type, applicant, assignee, scope, status, diff_json, opinion, snapshot_json, version, base_version_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [entry.changeId, entry.title, entry.type, entry.applicant, entry.assignee, entry.scope, entry.status, JSON.stringify(entry.diff), '', entry.snapshot, entry.version, entry.baseVersionId],
    );
    if (!result.success) throw new Error(result.error || '写入审核记录失败');
  }

  /* 通知审核人有新审核任务 */
  if (entry.assignee && entry.assignee !== entry.applicant) {
    const { pushNotification } = useNotifications();
    pushNotification({
      recipient: entry.assignee,
      type: 'info',
      title: `待审核：${entry.title}`,
      body: `${entry.applicant} 提交了协议变更，指定您为审核人。变更单号 ${entry.changeId}`,
      linkId: entry.changeId,
      linkType: 'review',
    });
  }

  return changeId;
}

/**
 * 审核操作：通过或驳回
 * @param {string} changeId - 变更单号
 * @param {string} status - 'approved' | 'rejected'
 * @param {string} opinion - 审核意见
 */
async function updateReviewStatus(changeId, status, opinion = '') {
  const item = reviewQueue.value.find(r => r.changeId === changeId);

  if (typeof window !== 'undefined' && window.electronAPI?.db) {
    /* 更新审核状态 */
    const result = await window.electronAPI.db.execute(
      'UPDATE audit_logs SET status = ?, opinion = ? WHERE change_id = ?',
      [status, opinion, changeId],
    );
    if (!result.success) throw new Error(result.error || '更新审核状态失败');

    /* 驳回时：该协议的 draft 快照标记废弃（published 基线不动，仍是 current_version_id 指向的版本） */
    if (status === 'rejected' && item?.title) {
      await window.electronAPI.db.execute(
        'UPDATE protocol_versions SET status = ? WHERE protocol_name = ? AND status = ?',
        ['deprecated', item.title, 'draft'],
      ).catch(() => { /* 非关键路径 */ });
    }
  }

  /* DB 写入成功后再更新内存状态 */
  if (item) {
    item.status = status;
    item.opinion = opinion;
  }

  /* 通知相关方 */
  if (item) {
    const { pushNotification } = useNotifications();

    if (status === 'withdrawn') {
      /* 撤回：通知审核人 */
      if (item.assignee && item.assignee !== '当前用户') {
        pushNotification({
          recipient: item.assignee,
          type: 'info',
          title: `已撤回：${item.title}`,
          body: `${item.applicant} 撤回了变更申请。变更单号 ${item.changeId}`,
          linkId: item.changeId,
          linkType: 'review',
        });
      }
    } else if (item.applicant && item.applicant !== '当前用户') {
      /* 通过/驳回：通知申请人 */
      const statusText = status === 'approved' ? '已通过' : '已驳回';
      const notifType = status === 'approved' ? 'success' : 'warning';
      pushNotification({
        recipient: item.applicant,
        type: notifType,
        title: `审核${statusText}：${item.title}`,
        body: opinion ? `审核意见：${opinion}` : `变更单号 ${item.changeId} ${statusText}`,
        linkId: item.changeId,
        linkType: 'review',
      });
    }
  }
}

/**
 * 审核通过的快照 → 正式协议内容写入语句（upsert protocols + 重建 commands/modules）
 * 与协议页保存逻辑同构：发布以"审核通过的快照"为准，
 * 发布人本机没有草稿（如审核人代发布）也能完整落地正式内容
 * @returns {{ versionStr: string, stmts: Array } | null} 快照无效时返回 null
 */
function snapshotContentStatements(title, snapshotJson) {
  let snap;
  try { snap = JSON.parse(snapshotJson || ''); } catch { return null; }
  if (!snap || typeof snap !== 'object') return null;

  const fieldOrder = Array.isArray(snap.fieldOrder) ? snap.fieldOrder : [];
  const fc = snap.fieldConfig || {};
  const byteCountOf = (k) => {
    const c = fc[k] || {};
    return c.byteCount === 'custom' ? (c.customCount || 1) : c.byteCount;
  };
  const byteOrder = String(snap.endianness || '').includes('小端') ? 'little' : 'big';
  const checkType = snap.checkType || 'CRC16-MODBUS';
  const checkStart = snap.checkStartField || 'SOF';
  const checkEnd = snap.checkEndField || 'DATA';
  const configJson = JSON.stringify({
    protoDesc: snap.protoDesc || '',
    fieldOrder,
    fieldConfig: Object.fromEntries(
      fieldOrder.map(k => [k, { ...(fc[k] || {}), byteCount: byteCountOf(k) }]),
    ),
    endianness: snap.endianness || '大端 (Big-Endian)',
    checkType,
    checkStartField: checkStart,
    checkEndField: checkEnd,
  });
  const versionStr = `v${snap.versionMajor ?? 1}.${snap.versionMinor ?? 0}.${snap.versionPatch ?? 0}`;

  const stmts = [];
  /* 协议主表不存在则创建（远程模式下纯草稿协议尚未上服务器），存在则跳过 */
  stmts.push({
    sql: 'INSERT OR IGNORE INTO protocols (name, version, byte_order, check_method, check_start, check_end, config_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
    params: [title, versionStr, byteOrder, checkType, checkStart, checkEnd, configJson],
  });
  /* 主表内容按快照刷新（保留 id / current_version_id / project） */
  stmts.push({
    sql: `UPDATE protocols SET version = ?, byte_order = ?, check_method = ?, check_start = ?, check_end = ?, config_json = ?, updated_at = datetime('now','localtime') WHERE name = ?`,
    params: [versionStr, byteOrder, checkType, checkStart, checkEnd, configJson, title],
  });
  /* 子表清空重建 */
  stmts.push({ sql: 'DELETE FROM commands WHERE protocol_id IN (SELECT id FROM protocols WHERE name = ?)', params: [title] });
  stmts.push({ sql: 'DELETE FROM modules WHERE protocol_id IN (SELECT id FROM protocols WHERE name = ?)', params: [title] });
  for (const cmd of snap.commands || []) {
    stmts.push({
      sql: 'INSERT INTO commands (protocol_id, code, name, sender, receiver, period_ms, direction, config_json) VALUES ((SELECT id FROM protocols WHERE name = ?), ?, ?, ?, ?, ?, ?, ?)',
      params: [title, cmd.cmd, cmd.name || '未命名', cmd.sender || '', cmd.receiver || '', parseInt(cmd.cycle) || 0, cmd.dir === 'tx' ? 'send' : 'recv', JSON.stringify(cmd)],
    });
  }
  for (const mod of snap.moduleAddresses || []) {
    stmts.push({
      sql: 'INSERT INTO modules (protocol_id, name, address) VALUES ((SELECT id FROM protocols WHERE name = ?), ?, ?)',
      params: [title, mod.name, (mod.addressBytes || []).join(' ')],
    });
  }
  return { versionStr, stmts };
}

/**
 * 发布生效：将已通过的变更发布为最终状态
 * 单事务原子写入：快照落地正式协议内容 → 发版 → 版本指针 → 废弃草稿快照 → 审核状态
 * @param {string} changeId - 变更单号
 */
async function publishReview(changeId) {
  const item = reviewQueue.value.find(r => r.changeId === changeId);
  if (!item || item.status !== 'approved') return;

  if (typeof window !== 'undefined' && window.electronAPI?.db) {
    const statements = [];

    /* 1. 审核通过的快照落地为正式协议内容（protocols/commands/modules） */
    const content = snapshotContentStatements(item.title, item.snapshot);
    if (content) statements.push(...content.stmts);

    /* 2. 快照发版到 protocol_versions（status='published'）+ 版本指针 */
    if (item.snapshot) {
      const versionStr = content ? content.versionStr : (item.version || 'v1.0.0');
      statements.push({
        sql: 'INSERT INTO protocol_versions (protocol_id, protocol_name, version, config_json, status, created_by) VALUES ((SELECT id FROM protocols WHERE name = ?), ?, ?, ?, ?, ?)',
        params: [item.title, item.title, versionStr, item.snapshot, 'published', item.applicant || ''],
      });
      statements.push({
        sql: `UPDATE protocols SET current_version_id = (SELECT id FROM protocol_versions WHERE protocol_name = ? AND version = ? ORDER BY id DESC LIMIT 1) WHERE name = ?`,
        params: [item.title, versionStr, item.title],
      });
    }

    /* 3. 发版后：该协议其余 draft 快照已被超越，标记废弃 */
    statements.push({
      sql: 'UPDATE protocol_versions SET status = ? WHERE protocol_name = ? AND status = ?',
      params: ['deprecated', item.title, 'draft'],
    });

    /* 4. 审核状态 → 已生效 */
    statements.push({
      sql: 'UPDATE audit_logs SET status = ? WHERE change_id = ?',
      params: ['published', changeId],
    });

    const result = await window.electronAPI.db.batch(statements);
    if (!result.success) throw new Error(result.error || '发布生效失败');
  }

  item.status = 'published';

  /* 通知申请人协议已发布生效 */
  if (item.applicant && item.applicant !== '当前用户') {
    const { pushNotification } = useNotifications();
    pushNotification({
      recipient: item.applicant,
      type: 'success',
      title: `已生效：${item.title}`,
      body: `变更单号 ${item.changeId} 已发布生效`,
      linkId: item.changeId,
      linkType: 'review',
    });
  }
}

/**
 * 获取变更详情
 * @param {string} changeId
 * @returns {object} { title, type, diff }
 */
function getReviewDetail(changeId) {
  const item = reviewQueue.value.find(r => r.changeId === changeId);
  if (!item) return { title: '', type: '', diff: [] };
  return { title: item.title, type: item.type, diff: item.diff };
}

/**
 * 待审核数量
 */
const pendingCount = computed(() =>
  reviewQueue.value.filter(r => r.status === 'pending').length,
);

/* 轮询定时器：多用户场景下自动从服务器拉取最新审核数据 */
let pollTimer = null;

/**
 * 启动轮询（用户登录后调用，定时从数据库刷新审核队列）
 * @param {number} intervalMs - 轮询间隔毫秒，默认 10 秒
 */
function startPolling(intervalMs = 10000) {
  stopPolling();
  pollTimer = setInterval(() => {
    loadFromDatabase(true);
  }, intervalMs);
}

/**
 * 停止轮询（用户退出时调用）
 */
function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

export function useReviewQueue() {
  return {
    reviewQueue,
    isLoaded,
    pendingCount,
    submitReview,
    updateReviewStatus,
    publishReview,
    getReviewDetail,
    loadFromDatabase,
    startPolling,
    stopPolling,
  };
}
