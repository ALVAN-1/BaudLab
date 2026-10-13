<template>
  <!-- 嵌入系统设置的数据源面板：连接配置 + 连接状态双卡片 -->
  <div class="panel db-panel">
    <div class="panel-header">
      <h3>数据库连接</h3>
      <span :class="['status-badge', effectiveMode === 'remote' ? 'active' : '']">
        {{ effectiveMode === 'remote' ? '团队服务器' : '本地模式' }}
      </span>
    </div>
    <div class="panel-body">
      <div class="db-embed-grid">
        <!-- 连接配置 -->
        <div class="db-card">
          <div class="db-card-title-row">
            <span class="db-card-title">连接配置</span>
          </div>

          <!-- 数据源模式开关 -->
          <div class="db-mode-row">
            <div class="db-mode-info">
              <span class="db-mode-name">团队服务器</span>
              <span class="db-mode-desc">开启后多端共享数据，关闭则使用本机 SQLite</span>
            </div>
            <button
              type="button"
              class="db-mode-switch"
              :class="{ on: dbMode === 'remote' }"
              @click="toggleMode"
            >
              <span class="db-mode-switch-thumb"></span>
            </button>
          </div>

          <!-- 团队服务器配置 -->
          <template v-if="dbMode === 'remote'">
            <div class="form-row">
              <label>服务器地址</label>
              <input
                type="text"
                class="input"
                v-model="serverUrl"
                placeholder="http://192.168.1.100:3010"
                spellcheck="false"
              >
            </div>
            <div class="form-row">
              <label>访问令牌</label>
              <input
                type="password"
                class="input"
                v-model="serverToken"
                placeholder="与服务器 server.config.json 中的 token 一致，留空表示不鉴权"
              >
            </div>
            <p class="db-mode-hint">
              在团队内网常开电脑上运行 node server.js 启动数据服务器，
              全部成员填写同一地址即可共享协议、用户与审核数据。
            </p>
          </template>
          <template v-else>
            <p class="db-mode-hint">
              本地模式：数据存储在本机 data/serial_protocol.db，无需其他配置。
              开启团队服务器后可与其他成员实时共享。
            </p>
          </template>

          <div class="db-config-actions">
            <button class="btn btn-secondary" id="btn-test-db" @click="onTestConnection">测试连接</button>
            <button class="btn btn-primary" :disabled="saving" @click="saveConfig">
              {{ saving ? '保存中…' : '保存配置' }}
            </button>
          </div>
        </div>

        <!-- 连接状态 -->
        <div class="db-card">
          <div class="db-card-title-row">
            <span class="db-card-title">连接状态</span>
            <span :class="['status-badge', connected ? 'active' : '']">{{ connected ? '已连接' : '未连接' }}</span>
          </div>
          <div class="db-metrics">
            <div class="metric">
              <span class="metric-label">数据源</span>
              <span class="metric-value">{{ effectiveMode === 'remote' ? '团队服务器' : '本地 SQLite' }}</span>
            </div>
            <div class="metric">
              <span class="metric-label">响应时间</span>
              <span class="metric-value" id="db-latency">{{ latency }}</span>
            </div>
            <div class="metric">
              <span class="metric-label">协议数量</span>
              <span class="metric-value">{{ protoCount }}</span>
            </div>
            <div class="metric">
              <span class="metric-label">串口日志</span>
              <span class="metric-value">{{ logCount }}</span>
            </div>
          </div>

          <div class="section-title">自动任务</div>
          <div class="task-list">
            <div class="task-item" v-for="task in tasks" :key="task.name">
              <span class="task-name">{{ task.name }}</span>
              <span :class="['task-status', task.statusClass]">{{ task.status }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 测试连接结果弹窗 -->
    <Transition name="modal-fade">
      <div v-if="showResultDialog" class="modal-overlay" @click.self="showResultDialog = false">
        <div class="modal-dialog" style="max-width:420px;">
          <div class="modal-header">
            <h3>{{ resultIsError ? '连接失败' : '连接成功' }}</h3>
          </div>
          <div class="modal-body">
            <div class="db-result-content">
              <div :class="['db-result-icon', resultIsError ? 'error' : 'success']">
                <svg v-if="resultIsError" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/></svg>
                <svg v-else width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M9 12l2 2 4-4"/></svg>
              </div>
              <p class="db-result-message">{{ resultMessage }}</p>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-primary" @click="showResultDialog = false">确定</button>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 数据源切换成功弹窗 -->
    <Transition name="modal-fade">
      <div v-if="showReloadDialog" class="modal-overlay">
        <div class="modal-dialog" style="max-width:420px;">
          <div class="modal-header">
            <h3>数据源已切换</h3>
          </div>
          <div class="modal-body">
            <div class="db-result-content">
              <div class="db-result-icon success">
                <svg width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M9 12l2 2 4-4"/></svg>
              </div>
              <p class="db-result-message">
                已切换为{{ dbMode === 'remote' ? '团队服务器' : '本地 SQLite' }}模式，
                界面刷新后将加载新数据源的协议、用户与审核数据。
              </p>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-primary" @click="applyReload">立即刷新</button>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { useDatabase } from '../composables/useDatabase';

const hasElectron = typeof window !== 'undefined' && typeof window.electronAPI !== 'undefined';

const { latency, testConnection, startMonitor, stopMonitor } = useDatabase();

const dbMode = ref('local');
const effectiveMode = ref('local');
const serverUrl = ref('');
const serverToken = ref('');
const saving = ref(false);

const protoCount = ref('—');
const logCount = ref('—');
const connected = ref(false);

const tasks = [
  { name: '每小时备份审计日志', status: '运行中', statusClass: 'running' },
  { name: '每日清理过期缓存', status: '已计划', statusClass: 'scheduled' },
  { name: '实时写入串口日志', status: '运行中', statusClass: 'running' },
];

const showResultDialog = ref(false);
const resultIsError = ref(false);
const resultMessage = ref('');
const showReloadDialog = ref(false);

async function loadConfig() {
  if (!hasElectron) return;
  try {
    const cfg = await window.electronAPI.dbConfig.get();
    dbMode.value = cfg.mode === 'remote' ? 'remote' : 'local';
    effectiveMode.value = cfg.effective === 'remote' ? 'remote' : 'local';
    serverUrl.value = cfg.url || '';
    serverToken.value = cfg.token || '';
  } catch {
    /* 读取失败保持默认本地模式 */
  }
}

function toggleMode() {
  dbMode.value = dbMode.value === 'remote' ? 'local' : 'remote';
}

async function refreshStats() {
  if (!hasElectron) return;
  try {
    const protoRes = await window.electronAPI.db.query('SELECT COUNT(*) AS cnt FROM protocols');
    if (protoRes.success && protoRes.rows) {
      protoCount.value = protoRes.rows[0].cnt;
      connected.value = true;
    } else {
      protoCount.value = '—';
      logCount.value = '—';
      connected.value = false;
      return;
    }
    const logRes = await window.electronAPI.db.query('SELECT COUNT(*) AS cnt FROM serial_logs');
    if (logRes.success && logRes.rows) {
      logCount.value = logRes.rows[0].cnt;
    }
  } catch {
    connected.value = false;
  }
}

async function saveConfig() {
  const cfg = {
    mode: dbMode.value,
    url: serverUrl.value.trim(),
    token: serverToken.value.trim(),
  };
  saving.value = true;
  try {
    if (!hasElectron) {
      resultIsError.value = true;
      resultMessage.value = '保存失败: 当前环境不支持';
      showResultDialog.value = true;
      return;
    }
    const res = await window.electronAPI.dbConfig.set(cfg);
    if (res.success) {
      showReloadDialog.value = true;
    } else {
      resultIsError.value = true;
      resultMessage.value = `保存失败: ${res.error}`;
      showResultDialog.value = true;
    }
  } finally {
    saving.value = false;
  }
}

function applyReload() {
  showReloadDialog.value = false;
  window.location.reload();
}

async function onTestConnection() {
  const btn = document.getElementById('btn-test-db');
  if (btn) {
    btn.textContent = '测试中...';
    btn.disabled = true;
  }
  try {
    if (dbMode.value === 'remote' && hasElectron) {
      const res = await window.electronAPI.dbConfig.test({
        url: serverUrl.value.trim(),
        token: serverToken.value.trim(),
      });
      if (res.success) {
        resultIsError.value = false;
        resultMessage.value = `团队服务器连接成功！协议数: ${res.protocolCount ?? '—'}，服务器时间: ${res.serverTime || '—'}`;
      } else {
        resultIsError.value = true;
        resultMessage.value = res.error;
      }
    } else {
      const result = await testConnection();
      if (result.error) {
        resultIsError.value = true;
        resultMessage.value = `数据库查询失败: ${result.error}`;
      } else {
        resultIsError.value = false;
        resultMessage.value = `本地数据库连接成功！当前协议数: ${result.count}`;
      }
    }
    showResultDialog.value = true;
  } catch (e) {
    resultIsError.value = true;
    resultMessage.value = `数据库查询失败: ${e.message}`;
    showResultDialog.value = true;
  } finally {
    if (btn) {
      btn.textContent = '测试连接';
      btn.disabled = false;
    }
    startMonitor();
    await refreshStats();
  }
}

onMounted(async () => {
  startMonitor();
  await loadConfig();
  await refreshStats();
});
onUnmounted(() => { stopMonitor(); });
</script>

<style scoped>
/* 双卡片布局：窄窗口时退化为单列，避免设置页内挤压 */
.db-embed-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
@media (max-width: 1080px) {
  .db-embed-grid { grid-template-columns: 1fr; }
}
.db-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 16px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
}
.db-card-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.db-card-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}
.db-config-actions { gap: 10px; }
</style>
