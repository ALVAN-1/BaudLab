/**
 * 当前用户 composable
 * 全局单例，管理当前操作人员身份
 * 所有页面通过 useCurrentUser() 共享同一个用户状态
 *
 * 用户切换流程（Electron 环境）：用户列表/切换由主进程 auth.js 处理，
 * 会话持久化在 data/session.json（选择一次，启动自动恢复）；
 * 本 composable 仅持有状态。浏览器 dev 模式回退 localStorage。
 * 已知用户保存在 localStorage 的 spm-known-users 中，供审核人选择使用
 */
import { ref, computed } from 'vue';

/* 模块级共享状态 */
const currentUser = ref(null);
const knownUsers = ref([]);
const isLoaded = ref(false);

/**
 * 从数据库加载用户列表（同时合并 localStorage 中的登录用户）
 */
async function loadKnownUsers() {
  const dbUsers = [];

  /* 从 SQLite users 表加载 */
  if (typeof window !== 'undefined' && window.electronAPI && window.electronAPI.db) {
    try {
      const result = await window.electronAPI.db.query(
        'SELECT username, display_name, department, project, module, email FROM users WHERE status = ?',
        ['active'],
      );
      if (result.success && result.rows) {
        for (const row of result.rows) {
          dbUsers.push({
            name: row.display_name || row.username,
            email: row.email || row.username,
            department: row.department || '',
            project: row.project || '',
            module: row.module || '',
          });
        }
      }
    } catch {
      /* 数据库不可用时回退到 localStorage */
    }
  }

  /* 合并 localStorage 中的登录用户（按邮箱去重） */
  const saved = localStorage.getItem('spm-known-users');
  if (saved) {
    try {
      const local = JSON.parse(saved);
      for (const u of local) {
        if (u.email && !dbUsers.some(d => d.email === u.email)) {
          dbUsers.push({ ...u });
        }
      }
    } catch {
      /* ignore */
    }
  }

  knownUsers.value = dbUsers;
  isLoaded.value = true;
}

/**
 * 将用户添加到已知用户列表（去重，按邮箱判断）
 * @param {object} user - 用户对象
 */
function addKnownUser(user) {
  if (!user || !user.email) return;
  const exists = knownUsers.value.some(u => u.email === user.email);
  if (!exists) {
    knownUsers.value.push({ ...user });
    localStorage.setItem('spm-known-users', JSON.stringify(knownUsers.value));
  }
}

/**
 * 设置当前用户并持久化
 * @param {object} user - 用户对象 { name, email, department?, module? }
 */
function setCurrentUser(user) {
  currentUser.value = user;
  if (user) {
    localStorage.setItem('spm-current-user', JSON.stringify(user));
    addKnownUser(user);
  } else {
    localStorage.removeItem('spm-current-user');
  }
}

/**
 * 从 localStorage 恢复上次登录的用户
 */
function restoreUser() {
  const saved = localStorage.getItem('spm-current-user');
  if (saved) {
    try {
      currentUser.value = JSON.parse(saved);
    } catch {
      currentUser.value = null;
    }
  }
}

/**
 * 获取候选审核人列表（排除当前用户，按邮箱去重）
 */
function getReviewCandidates() {
  const currentEmail = currentUser.value?.email;
  return knownUsers.value.filter(u => u.email !== currentEmail);
}

const isLoggedIn = computed(() => currentUser.value !== null);

export function useCurrentUser() {
  return {
    currentUser,
    knownUsers,
    isLoaded,
    isLoggedIn,
    loadKnownUsers,
    setCurrentUser,
    restoreUser,
    getReviewCandidates,
  };
}
