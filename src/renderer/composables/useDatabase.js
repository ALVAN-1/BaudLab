/**
 * 数据库 composable
 * 封装 Electron IPC 数据库操作
 */
import { ref } from 'vue';

const hasElectron = typeof window !== 'undefined' && typeof window.electronAPI !== 'undefined';

export function useDatabase() {
  const latency = ref('—');
  let monitorTimer = null;

  /**
   * 测试数据库连接
   * @returns {Promise<{success: boolean, count?: number, error?: string, elapsed: number}>}
   */
  async function testConnection() {
    const t0 = performance.now();
    if (hasElectron) {
      try {
        const result = await window.electronAPI.db.query('SELECT COUNT(*) as cnt FROM protocols', []);
        const elapsed = Math.round(performance.now() - t0);
        latency.value = `${elapsed} ms`;
        if (result.success) {
          return { success: true, count: result.rows[0].cnt, elapsed };
        }
        return { success: false, error: result.error, elapsed };
      } catch (e) {
        return { success: false, error: e.message, elapsed: Math.round(performance.now() - t0) };
      }
    }
    return { success: false, error: '数据库未连接', elapsed: 0 };
  }

  /**
   * 启动延迟监控
   * @param {number} interval - 监控间隔 ms
   */
  function startMonitor(interval = 5000) {
    stopMonitor();
    if (hasElectron) {
      monitorTimer = setInterval(async () => {
        try {
          const t0 = performance.now();
          await window.electronAPI.db.query('SELECT 1', []);
          latency.value = `${Math.round(performance.now() - t0)} ms`;
        } catch {
          latency.value = 'N/A';
        }
      }, interval);
    }
  }

  /**
   * 停止延迟监控
   */
  function stopMonitor() {
    if (monitorTimer) {
      clearInterval(monitorTimer);
      monitorTimer = null;
    }
  }

  return {
    latency,
    testConnection,
    startMonitor,
    stopMonitor,
  };
}
