<template>
  <div class="view-pad system-log-view">
    <!-- 标题 + 操作按钮 -->
    <div class="log-toolbar">
      <h2 class="log-title">系统日志</h2>
      <div class="log-actions">
        <button class="log-btn refresh" @click="loadLogs">
          <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 7a5 5 0 1 1 1.5 3.5M3 2v5h5"/></svg>
          刷新
        </button>
        <button class="log-btn export" @click="exportLogs">
          <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M7 1v9m3-3-3 3-3-3M1 11h12"/></svg>
          导出
        </button>
        <button class="log-btn clear" @click="clearLogs" :disabled="logs.length === 0">
          <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 4h10M5 4V2h6v2M5 4v8h6V4"/></svg>
          清空
        </button>
      </div>
    </div>

    <!-- 统计卡片 -->
    <div class="log-stats">
      <div class="log-stat-card">
        <span class="stat-label">总日志</span>
        <span class="stat-value">{{ totalCount }}</span>
      </div>
      <div class="log-stat-card warn">
        <span class="stat-label">警告</span>
        <span class="stat-value">{{ warnCount }}</span>
      </div>
      <div class="log-stat-card error">
        <span class="stat-label">错误</span>
        <span class="stat-value">{{ errorCount }}</span>
      </div>
      <div class="log-stat-card">
        <span class="stat-label">最新事件</span>
        <span class="stat-value text">{{ latestTime || '—' }}</span>
      </div>
    </div>

    <!-- 筛选栏 -->
    <div class="log-filters">
      <select v-model="filterLevel" class="log-filter">
        <option value="">全部级别</option>
        <option value="info">信息</option>
        <option value="warn">警告</option>
        <option value="error">错误</option>
      </select>
      <select v-model="filterCategory" class="log-filter">
        <option value="">全部类别</option>
        <option value="system">系统</option>
        <option value="auth">用户</option>
        <option value="protocol">协议</option>
        <option value="serial">串口</option>
        <option value="database">数据库</option>
        <option value="update">更新</option>
        <option value="network">网络</option>
      </select>
      <input v-model="searchText" placeholder="搜索关键词..." class="log-search" />
    </div>

    <!-- 日志表格 -->
    <div class="log-table-wrap" ref="scrollWrap" @scroll="onScroll">
      <table class="log-table">
        <thead>
          <tr>
            <th style="width:50px">#</th>
            <th style="width:70px">级别</th>
            <th style="width:70px">类别</th>
            <th style="width:150px">时间</th>
            <th style="width:100px">来源</th>
            <th>内容</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="log in displayLogs" :key="log.id" :class="`log-row log-${log.level}`">
            <td class="log-id">{{ log.id }}</td>
            <td>
              <span class="log-level-badge" :class="`level-${log.level}`">{{ levelText(log.level) }}</span>
            </td>
            <td>
              <span class="log-cat-badge" :class="`cat-${log.category}`">{{ categoryText(log.category) }}</span>
            </td>
            <td class="log-time">{{ log.created_at }}</td>
            <td class="log-source">{{ log.source }}</td>
            <td class="log-message">{{ log.message }}</td>
          </tr>
          <tr v-if="filteredLogs.length > maxRender">
            <td colspan="6" class="log-truncated">
              仅显示前 {{ maxRender }} 条，还有 {{ filteredLogs.length - maxRender }} 条未显示。请缩小范围或导出查看。
            </td>
          </tr>
          <tr v-if="filteredLogs.length === 0 && !loadingMore">
            <td colspan="6" class="log-empty">暂无日志记录</td>
          </tr>
          <tr v-if="loadingMore">
            <td colspan="6" class="log-loading">加载中...</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';

const logs = ref([]);
const totalCount = ref(0);
const warnCount = ref(0);
const errorCount = ref(0);
const filterLevel = ref('');
const filterCategory = ref('');
const searchText = ref('');
const loadingMore = ref(false);
const hasMore = ref(true);
const pageNum = ref(0);
const pageSize = 100;
const maxRender = 500; // 限制 DOM 渲染行数，防止卡顿
const scrollWrap = ref(null);
let pollTimer = null;
let lastLogId = 0; // 增量轮询：只拉取比 lastLogId 更新的日志

// 搜索防抖
const debouncedSearch = ref('');
let searchTimer = null;
watch(searchText, (val) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { debouncedSearch.value = val; }, 300);
});

const filteredLogs = computed(() => {
  return logs.value.filter(log => {
    if (filterLevel.value && log.level !== filterLevel.value) return false;
    if (filterCategory.value && log.category !== filterCategory.value) return false;
    if (debouncedSearch.value && !log.message.toLowerCase().includes(debouncedSearch.value.toLowerCase())) return false;
    return true;
  });
});

// 只渲染前 maxRender 条，超出部分不进 DOM
const displayLogs = computed(() => filteredLogs.value.slice(0, maxRender));

const latestTime = computed(() => {
  return logs.value.length > 0 ? logs.value[0].created_at : '';
});

function levelText(level) {
  const map = { info: '信息', warn: '警告', error: '错误', debug: '调试' };
  return map[level] || level;
}

function categoryText(cat) {
  const map = { system: '系统', auth: '用户', protocol: '协议', serial: '串口', database: '数据库', update: '更新', network: '网络' };
  return map[cat] || cat;
}

async function loadLogs(reset = true) {
  if (reset) {
    pageNum.value = 0;
    hasMore.value = true;
    logs.value = [];
    lastLogId = 0;
  }
  if (loadingMore.value || (reset === false && !hasMore.value)) return;
  loadingMore.value = true;

  try {
    const offset = pageNum.value * pageSize;
    const result = await window.electronAPI.logs.get(pageSize, offset);
    if (result.success) {
      if (reset) {
        logs.value = result.logs;
      } else {
        logs.value.push(...result.logs);
      }
      if (result.logs.length > 0) {
        lastLogId = result.logs[0].id; // 记录最新日志 ID，供增量轮询用
      }
      totalCount.value = result.total;
      warnCount.value = result.warnCount;
      errorCount.value = result.errorCount;
      hasMore.value = result.logs.length === pageSize;
      pageNum.value++;
    }
  } catch (e) {
    console.error('加载日志失败:', e);
  } finally {
    loadingMore.value = false;
  }
}

// 增量轮询：只拉取比 lastLogId 更新的日志，插入到列表头部，不清空已有数据
async function pollNewLogs() {
  try {
    const result = await window.electronAPI.logs.get(50, 0);
    if (result.success && result.logs.length > 0) {
      const newLogs = result.logs.filter(l => l.id > lastLogId);
      if (newLogs.length > 0) {
        logs.value.unshift(...newLogs);
        lastLogId = newLogs[0].id;
        totalCount.value = result.total;
        warnCount.value = result.warnCount;
        errorCount.value = result.errorCount;
      }
    }
  } catch { /* 轮询失败静默忽略 */ }
}

function onScroll() {
  if (!scrollWrap.value) return;
  const { scrollTop, scrollHeight, clientHeight } = scrollWrap.value;
  if (scrollHeight - scrollTop - clientHeight < 100 && hasMore.value && !loadingMore.value) {
    loadLogs(false);
  }
}

async function clearLogs() {
  if (!confirm('确定清空所有系统日志？此操作不可恢复。')) return;
  try {
    const result = await window.electronAPI.logs.clear();
    if (result.success) {
      logs.value = [];
      totalCount.value = 0;
      warnCount.value = 0;
      errorCount.value = 0;
    }
  } catch (e) {
    console.error('清空日志失败:', e);
  }
}

function exportLogs() {
  const lines = ['# 系统日志导出', `# 导出时间: ${new Date().toLocaleString()}`, ''];
  filteredLogs.value.forEach(log => {
    lines.push(`[${log.created_at}] [${log.level.toUpperCase()}] [${log.category}] ${log.source}: ${log.message}`);
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `system-log-${Date.now()}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

onMounted(() => {
  loadLogs(true);
  pollTimer = setInterval(pollNewLogs, 10000); // 增量轮询，不清空已有列表
});

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
});
</script>

<style scoped>
.system-log-view { display: flex; flex-direction: column; height: 100%; gap: 12px; }

/* 第一层：标题 + 操作按钮 */
.log-toolbar {
  display: flex; align-items: center; justify-content: space-between;
  flex-shrink: 0;
}
.log-title { font-size: 18px; font-weight: 600; margin: 0; }
.log-actions { display: flex; gap: 6px; align-items: center; }

/* 第二层：统计卡片 */
.log-stats { display: flex; gap: 10px; flex-shrink: 0; }
.log-stat-card {
  flex: 1; display: flex; flex-direction: column; align-items: center;
  padding: 8px 12px; border-radius: 8px; background: var(--bg-secondary);
  border: 1px solid var(--border-light);
}
.log-stat-card.warn { border-color: var(--accent-amber); }
.log-stat-card.error { border-color: var(--accent-red); }
.stat-label { font-size: 11px; color: var(--text-tertiary); text-transform: uppercase; letter-spacing: .5px; }
.stat-value { font-size: 22px; font-weight: 700; color: var(--text-primary); }
.stat-value.text { font-size: 13px; font-weight: 500; }
.log-stat-card.warn .stat-value { color: var(--accent-amber); }
.log-stat-card.error .stat-value { color: var(--accent-red); }

/* 第三层：筛选栏 */
.log-filters {
  display: flex; gap: 8px; align-items: center; flex-shrink: 0;
  padding: 8px 12px; border-radius: 8px;
  background: var(--bg-secondary); border: 1px solid var(--border-light);
}
.log-filter, .log-search {
  background: var(--bg-hover); border: 1px solid var(--border-light); border-radius: 6px;
  padding: 5px 10px; font-size: 13px; color: var(--text-primary); outline: none;
}
.log-filter:focus, .log-search:focus { border-color: var(--accent-blue); }
.log-search { flex: 1; max-width: 240px; }

/* 操作按钮 */
.log-btn {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 5px 12px; border-radius: 6px; font-size: 13px;
  border: 1px solid var(--border-light); background: var(--bg-secondary); color: var(--text-primary);
  cursor: pointer; transition: all .15s;
}
.log-btn:hover { border-color: var(--accent-blue); color: var(--accent-blue); }
.log-btn.clear:hover { border-color: var(--accent-red); color: var(--accent-red); }
.log-btn.clear:disabled { opacity: .4; cursor: not-allowed; }

/* 第四层：日志表格 */
.log-table-wrap {
  flex: 1; overflow-y: auto; border-radius: 8px;
  background: var(--bg-secondary); border: 1px solid var(--border-light);
}
.log-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.log-table thead { position: sticky; top: 0; z-index: 1; background: var(--bg-hover); }
.log-table th {
  padding: 8px 10px; text-align: left; font-weight: 600;
  color: var(--text-secondary); border-bottom: 1px solid var(--border-light);
  white-space: nowrap;
}
.log-table td { padding: 5px 10px; border-bottom: 1px solid var(--border-light); }
.log-row:hover { background: var(--bg-hover); }
.log-row.log-warn { background: rgba(245, 158, 11, 0.06); }
.log-row.log-error { background: rgba(239, 68, 68, 0.08); }

.log-id { color: var(--text-tertiary); font-family: monospace; }
.log-time { color: var(--text-tertiary); font-family: monospace; white-space: nowrap; }
.log-source { color: var(--text-secondary); }
.log-message { color: var(--text-primary); }

.log-level-badge {
  display: inline-block; padding: 1px 8px; border-radius: 4px; font-size: 11px; font-weight: 600;
}
.level-info { background: rgba(59, 130, 246, 0.15); color: var(--accent-blue); }
.level-warn { background: rgba(245, 158, 11, 0.15); color: var(--accent-amber); }
.level-error { background: rgba(239, 68, 68, 0.15); color: var(--accent-red); }
.level-debug { background: rgba(139, 92, 246, 0.15); color: var(--accent-purple); }

.log-cat-badge {
  display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 11px;
  background: var(--bg-hover); color: var(--text-secondary);
}
.cat-system { background: rgba(59, 130, 246, 0.1); color: var(--accent-blue); }
.cat-auth { background: rgba(139, 92, 246, 0.1); color: var(--accent-purple); }
.cat-protocol { background: rgba(16, 185, 129, 0.1); color: var(--accent-green); }
.cat-serial { background: rgba(245, 158, 11, 0.1); color: var(--accent-amber); }
.cat-database { background: rgba(236, 72, 153, 0.1); color: var(--accent-pink); }
.cat-update { background: rgba(34, 197, 94, 0.1); color: var(--accent-green); }
.cat-network { background: rgba(99, 102, 241, 0.1); color: #6366f1; }

.log-empty, .log-loading, .log-truncated { text-align: center; padding: 24px; color: var(--text-tertiary); }
.log-truncated { font-size: 12px; background: rgba(245, 158, 11, 0.06); }
</style>
