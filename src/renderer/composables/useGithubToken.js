/**
 * GitHub Token 状态（主进程存储）
 * 令牌明文只存主进程 data/github-token.json，渲染层仅持有"是否已配置"状态，
 * 杜绝 XSS 从 localStorage 直接读取令牌明文。
 * 首次使用时把旧版 localStorage 令牌（spm-github-token / 早期的 spm-gitee-token）
 * 一次性迁移到主进程并清除。
 */
import { ref } from 'vue';

/* 模块级共享状态 */
const configured = ref(false);
let migrated = false;

async function ensureMigrated() {
  if (migrated) return configured.value;
  migrated = true;
  if (!window.electronAPI?.feedback?.setToken) return configured.value; // 浏览器 dev 模式无 IPC
  const legacy = localStorage.getItem('spm-github-token') || localStorage.getItem('spm-gitee-token');
  if (legacy) {
    try {
      const r = await window.electronAPI.feedback.setToken(legacy);
      if (r.success) {
        localStorage.removeItem('spm-github-token');
        localStorage.removeItem('spm-gitee-token');
      }
    } catch { /* 迁移失败保留原值，下次启动重试 */ }
  }
  await refresh();
  return configured.value;
}

async function refresh() {
  if (!window.electronAPI?.feedback?.getTokenStatus) return;
  try {
    const r = await window.electronAPI.feedback.getTokenStatus();
    configured.value = !!r.configured;
  } catch { /* ignore */ }
}

export function useGithubToken() {
  return { configured, refresh, ensureMigrated };
}
