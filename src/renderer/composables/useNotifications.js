/**
 * 通知中心 composable
 * 管理系统通知（审核结果、系统消息等）
 * 通知持久化到 SQLite notifications 表
 * 当前登录用户只看到发给自己的通知
 *
 * 核心机制：
 *   - pushNotification 只写数据库，不直接弹窗（避免在提交者端误弹）
 *   - loadNotifications 轮询数据库，发现新通知时弹系统通知 + 左下角弹窗
 *   - 通过 seenIds 集合去重，防止同一通知多次弹窗
 */
import { ref, computed } from 'vue';

/* 模块级共享状态：所有组件共用 */
const notifications = ref([]);
const isLoaded = ref(false);
let pollTimer = null;
let currentRecipient = null;
const seenIds = new Set();
let isFirstLoad = true;

const hasElectron = typeof window !== 'undefined' && window.electronAPI?.db;

/**
 * 从数据库加载当前用户的未读通知
 * 发现新通知时自动弹系统通知
 */
async function loadNotifications(recipient) {
  if (!hasElectron || !recipient) return;
  try {
    const result = await window.electronAPI.db.query(
      'SELECT id, type, title, body, link_id, link_type, is_read, created_at FROM notifications WHERE recipient = ? ORDER BY id DESC LIMIT 50',
      [recipient],
    );
    if (result.success && result.rows) {
      const newRows = result.rows.map(r => {
        const item = {
          id: r.id,
          type: r.type,
          title: r.title,
          body: r.body,
          linkId: r.link_id,
          linkType: r.link_type,
          isRead: !!r.is_read,
          time: r.created_at,
        };

        /* 首次加载：只记录已见 ID，不弹窗（避免启动时轰炸） */
        if (isFirstLoad) {
          seenIds.add(r.id);
        } else if (!seenIds.has(r.id) && !r.is_read) {
          /* 后续轮询发现的新未读通知：弹系统通知 */
          if (window.electronAPI?.app?.showNotification) {
            try {
              window.electronAPI.app.showNotification(item.title, item.body);
            } catch { /* ignore */ }
          }
        }
        seenIds.add(r.id);
        return item;
      });
      notifications.value = newRows;
    }
  } catch {
    /* ignore */
  }
  isFirstLoad = false;
  isLoaded.value = true;
}

/**
 * 创建一条新通知（仅写入数据库，不直接弹窗）
 * 接收人端的轮询会在 5 秒内发现并弹窗
 * @param {object} notif - 通知对象
 * @param {string} notif.recipient - 接收人（用户名）
 * @param {string} notif.type - 类型：info / success / warning / error
 * @param {string} notif.title - 标题
 * @param {string} notif.body - 正文
 * @param {string} notif.linkId - 关联 ID（如 change_id）
 * @param {string} notif.linkType - 关联类型（如 'review'）
 */
async function pushNotification(notif) {
  if (!notif.recipient) return;

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const timeStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  /* 写入数据库（所有实例共享） */
  if (hasElectron) {
    try {
      await window.electronAPI.db.execute(
        'INSERT INTO notifications (recipient, type, title, body, link_id, link_type, is_read) VALUES (?, ?, ?, ?, ?, ?, 0)',
        [notif.recipient, notif.type || 'info', notif.title, notif.body || '', notif.linkId || '', notif.linkType || ''],
      );
    } catch {
      /* ignore */
    }
  }

  /* 如果接收人就是当前登录用户，立即加载并弹窗（不等轮询） */
  if (notif.recipient === currentRecipient) {
    await loadNotifications(currentRecipient);
  }
}

/**
 * 标记通知为已读
 */
async function markAsRead(id) {
  const item = notifications.value.find(n => n.id === id);
  if (item) item.isRead = true;

  if (hasElectron) {
    try {
      await window.electronAPI.db.execute(
        'UPDATE notifications SET is_read = 1 WHERE id = ?',
        [id],
      );
    } catch {
      /* ignore */
    }
  }
}

/**
 * 全部标记为已读
 */
async function markAllAsRead(recipient) {
  notifications.value.forEach(n => { n.isRead = true; });

  if (hasElectron && recipient) {
    try {
      await window.electronAPI.db.execute(
        'UPDATE notifications SET is_read = 1 WHERE recipient = ?',
        [recipient],
      );
    } catch {
      /* ignore */
    }
  }
}

/**
 * 未读数量
 */
const unreadCount = computed(() =>
  notifications.value.filter(n => !n.isRead).length,
);

/**
 * 未读通知列表（用于弹窗展示，最多显示 3 条）
 */
const unreadVisible = computed(() =>
  notifications.value.filter(n => !n.isRead).slice(0, 3),
);

/**
 * 启动轮询：检查是否有新通知
 * @param {string} recipient - 当前登录用户名
 * @param {number} intervalMs - 轮询间隔（默认 5 秒）
 */
function startPolling(recipient, intervalMs = 5000) {
  stopPolling();
  currentRecipient = recipient;
  seenIds.clear();
  isFirstLoad = true;
  if (!recipient) return;
  pollTimer = setInterval(async () => {
    await loadNotifications(recipient);
  }, intervalMs);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

export function useNotifications() {
  return {
    notifications,
    isLoaded,
    unreadCount,
    unreadVisible,
    loadNotifications,
    pushNotification,
    markAsRead,
    markAllAsRead,
    startPolling,
    stopPolling,
  };
}
