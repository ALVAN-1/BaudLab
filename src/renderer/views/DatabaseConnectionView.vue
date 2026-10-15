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
              填写下方「局域网发现的服务器」中列出的地址，或手动输入内网常开电脑的地址，
              全部成员填写同一地址与令牌即可共享协议、用户与审核数据。
            </p>

            <!-- 局域网零配置发现（mDNS） -->
            <div class="db-discover">
              <div class="db-discover-head">
                <span>局域网发现的服务器</span>
                <button type="button" class="btn-link" @click="toggleScan">
                  {{ scanning ? '停止扫描' : '扫描' }}
                </button>
              </div>
              <div v-if="discovered.length === 0" class="db-discover-empty">
                {{ scanning ? '搜索中…' : '未发现服务器，可手动填写地址' }}
              </div>
              <ul v-else class="db-discover-list">
                <li
                  v-for="d in discovered"
                  :key="d.url"
                  :class="{ active: serverUrl === d.url }"
                  @click="applyDiscovered(d)"
                >
                  <span class="db-disc-name">{{ d.name }}</span>
                  <span class="db-disc-url">{{ d.url }}</span>
                </li>
              </ul>
            </div>
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

        <!-- 局域网主机：客户端一键把本机变成团队数据服务器（内嵌同源 server.js） -->
        <div class="db-card db-host-card">
          <div class="db-card-title-row">
            <span class="db-card-title">局域网主机（本机作为服务器）</span>
            <span :class="['status-badge', host.running ? 'active' : '']">
              {{ host.running ? '运行中' : (host.starting ? '启动中' : '未运行') }}
            </span>
          </div>

          <template v-if="!host.running">
            <p class="db-mode-hint">
              在这台电脑上启动团队数据服务器，局域网内其他成员的波特律动即可共享协议、用户与审核数据。
              无需单独下载服务端、无需安装 Node.js，关闭应用即停止；开启后自动在局域网广播，供成员发现。
            </p>
            <p v-if="host.error" class="db-host-error">{{ host.error }}</p>
            <div class="db-config-actions">
              <button class="btn btn-primary" :disabled="host.starting" @click="startHost">
                {{ host.starting ? '启动中…' : '启动为局域网主机' }}
              </button>
            </div>
          </template>

          <template v-else>
            <div class="db-host-field">
              <label>成员填写地址</label>
              <div class="db-host-value">
                <code>{{ host.host }}</code>
                <button type="button" class="btn btn-secondary btn-mini" @click="copyText(host.host)">复制</button>
              </div>
            </div>
            <div class="db-host-field">
              <label>访问令牌</label>
              <div class="db-host-value">
                <code class="db-host-token">{{ host.token || '—' }}</code>
                <button type="button" class="btn btn-secondary btn-mini" @click="copyText(host.token)">复制</button>
                <button type="button" class="btn btn-secondary btn-mini" @click="onRegenToken">重置</button>
              </div>
            </div>
            <div v-if="host.addresses && host.addresses.length > 1" class="db-host-field">
              <label>其他网卡</label>
              <div class="db-host-value"><code>{{ host.addresses.join('   ') }}</code></div>
            </div>
            <div class="db-config-actions">
              <button class="btn btn-secondary" @click="connectSelfToHost">让本机也连接它</button>
              <button class="btn btn-secondary" @click="openHostAdmin">打开管理后台</button>
              <button class="btn btn-secondary" @click="stopHost">停止服务器</button>
            </div>

            <!-- 成员账号：复用服务器本机管理接口，免邮箱验证直建账号，无需配置 SMTP -->
            <div class="db-host-members">
              <div class="db-host-members-head">
                <span>成员账号（免邮箱验证）</span>
                <button type="button" class="btn-link" :disabled="membersLoading" @click="loadMembers">
                  {{ membersLoading ? '加载中…' : '刷新' }}
                </button>
              </div>
              <p class="db-mode-hint">
                在这里直接创建账号，成员用「邮箱 + 密码」即可登录，无需配置邮件发信。
                <strong v-if="membersLoaded && !hasAdmin">当前还没有可登录的管理员，建议先创建一个「管理员」账号。</strong>
              </p>
              <p v-if="membersError" class="db-host-error">{{ membersError }}</p>
              <div class="db-member-form">
                <input class="input" v-model="memberForm.email" placeholder="成员邮箱" spellcheck="false" @keyup.enter="createMember">
                <input class="input" type="password" v-model="memberForm.password" placeholder="初始密码（至少 8 位）" @keyup.enter="createMember">
                <input class="input" v-model="memberForm.displayName" placeholder="显示名（选填）" @keyup.enter="createMember">
                <select class="input" v-model="memberForm.role">
                  <option value="工程师">工程师</option>
                  <option value="管理员">管理员</option>
                </select>
                <button class="btn btn-primary" :disabled="memberCreating || !canCreateMember" @click="createMember">
                  {{ memberCreating ? '创建中…' : '创建账号' }}
                </button>
              </div>
              <ul v-if="members.length" class="db-member-list">
                <li v-for="m in members" :key="m.id">
                  <span class="db-member-email">{{ m.email || m.username }}</span>
                  <span class="db-member-role">{{ m.role_name || '—' }}</span>
                  <span :class="['db-member-status', m.status === 'active' ? 'ok' : 'off']">{{ m.status === 'active' ? '启用' : '停用' }}</span>
                  <button type="button" class="btn btn-secondary btn-mini" @click="deleteMember(m)">删除</button>
                </li>
              </ul>
              <p v-else-if="membersLoaded" class="db-mode-hint">暂无成员账号</p>
            </div>
          </template>

          <!-- 运行日志（最近若干行，便于排查） -->
          <details v-if="hostLogs.length" class="db-host-logs">
            <summary>运行日志</summary>
            <pre>{{ hostLogs.join('\n') }}</pre>
          </details>
        </div>
      </div>
    </div>

    <!-- 弹窗统一 Teleport 到 body：.view 带有 transform（切页动效），会成为
         position:fixed 的定位祖先，导致弹窗只覆盖内容区、随页面滚动且不居中。
         挂到 body 后即可相对整个窗口始终居中。 -->
    <Teleport to="body">
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

    <!-- 团队服务器连不上：引导而非静默保存 -->
    <Transition name="modal-fade">
      <div v-if="showRemoteWarn" class="modal-overlay" @click.self="showRemoteWarn = false">
        <div class="modal-dialog" style="max-width:460px;">
          <div class="modal-header">
            <h3>未连接到团队服务器</h3>
          </div>
          <div class="modal-body">
            <div class="db-result-content">
              <div class="db-result-icon error">
                <svg width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/></svg>
              </div>
              <div class="db-result-message">
                <p style="font-weight:600;word-break:break-all;">{{ remoteWarnUrl }}</p>
                <p style="color:var(--text-tertiary);font-size:12.5px;">{{ remoteWarnMsg }}</p>
              </div>
            </div>
            <p style="color:var(--text-secondary);line-height:1.6;font-size:13px;margin-top:12px;">
              可能原因：主机电脑未开机、未启动服务器，或地址/令牌有误。<br>
              你可以把本机直接作为团队服务器，或仍然保存稍后再试。
            </p>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" @click="showRemoteWarn = false">取消</button>
            <button class="btn btn-secondary" :disabled="saving" @click="saveRemoteAnyway">仍然保存</button>
            <button class="btn btn-primary" :disabled="saving" @click="hostFromWarn">把本机作为服务器</button>
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
    </Teleport>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
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

/* 保存团队模式前测连通失败：引导用户（本机作为主机 / 仍然保存 / 取消） */
const showRemoteWarn = ref(false);
const remoteWarnMsg = ref('');
const remoteWarnUrl = ref('');
const remoteWarnToken = ref('');

// --- 局域网主机（内嵌服务器）+ mDNS 零配置发现 ---
const host = ref({
  running: false, starting: false, port: null,
  url: '', host: '', token: '', addresses: [], error: null,
});
const hostLogs = ref([]);
const discovered = ref([]);
const scanning = ref(false);
const selfConnectedToHost = ref(false);
let offHostState = null;
let offHostLog = null;
let offDiscovery = null;

// --- 成员账号（复用内嵌服务器本机管理接口，免邮箱验证） ---
const members = ref([]);
const membersLoading = ref(false);
const membersLoaded = ref(false);
const membersError = ref('');
const memberCreating = ref(false);
const hasAdmin = ref(false);
const memberForm = ref({ email: '', password: '', displayName: '', role: '工程师' });
const canCreateMember = computed(() =>
  !!memberForm.value.email.trim() && memberForm.value.password.length >= 8);

function applyHostState(s) {
  if (!s) return;
  host.value = {
    running: !!s.running,
    starting: !!s.starting,
    port: s.port || null,
    url: s.url || '',
    host: s.host || '',
    token: s.token || '',
    addresses: Array.isArray(s.addresses) ? s.addresses : [],
    error: s.error || null,
  };
}

async function refreshHost() {
  if (!hasElectron || !window.electronAPI.teamServer) return;
  try { applyHostState(await window.electronAPI.teamServer.status()); } catch { /* 忽略 */ }
}

async function startHost() {
  if (!hasElectron || !window.electronAPI.teamServer) return;
  host.value = { ...host.value, starting: true, error: null };
  const res = await window.electronAPI.teamServer.start({});
  if (!res.success) host.value = { ...host.value, starting: false, error: res.error };
  else applyHostState(res);
}

async function stopHost() {
  if (!hasElectron || !window.electronAPI.teamServer) return;
  await window.electronAPI.teamServer.stop();
  selfConnectedToHost.value = false;
  await refreshHost();
}

async function onRegenToken() {
  if (!hasElectron || !window.electronAPI.teamServer) return;
  const res = await window.electronAPI.teamServer.regenerateToken();
  if (res && res.success) {
    host.value = { ...host.value, token: res.token };
    copyText(res.token);
  }
}

async function openHostAdmin() {
  if (!hasElectron || !window.electronAPI.teamServer) return;
  await window.electronAPI.teamServer.openAdmin();
}

/* ---- 成员账号：直连内嵌服务器本机管理接口（免邮箱验证） ---- */
function adminApi() {
  return hasElectron && window.electronAPI.teamServer && window.electronAPI.teamServer.admin;
}

async function loadMembers() {
  const api = adminApi();
  if (!api) return;
  membersLoading.value = true;
  membersError.value = '';
  try {
    const res = await api.listUsers();
    if (res && res.success) {
      members.value = res.rows || [];
      hasAdmin.value = (res.loginableAdmins || 0) > 0;
      membersLoaded.value = true;
      if (!hasAdmin.value) memberForm.value.role = '管理员';
    } else {
      membersError.value = (res && res.error) || '加载成员失败';
    }
  } catch (e) {
    membersError.value = e.message || String(e);
  } finally {
    membersLoading.value = false;
  }
}

async function createMember() {
  const api = adminApi();
  if (!api || !canCreateMember.value || memberCreating.value) return;
  memberCreating.value = true;
  membersError.value = '';
  try {
    const res = await api.createUser({
      email: memberForm.value.email.trim(),
      password: memberForm.value.password,
      displayName: memberForm.value.displayName.trim(),
      role: memberForm.value.role,
    });
    if (res && res.success) {
      memberForm.value = { email: '', password: '', displayName: '', role: hasAdmin.value ? '工程师' : '管理员' };
      await loadMembers();
    } else {
      membersError.value = (res && res.error) || '创建失败';
    }
  } catch (e) {
    membersError.value = e.message || String(e);
  } finally {
    memberCreating.value = false;
  }
}

async function deleteMember(m) {
  const api = adminApi();
  if (!api) return;
  const name = m.email || m.username;
  if (!window.confirm(`确定删除成员「${name}」？该操作不可恢复。`)) return;
  const res = await api.deleteUser({ id: m.id });
  if (res && res.success) await loadMembers();
  else membersError.value = (res && res.error) || '删除失败';
}

/** 让本机客户端也连到它刚启动的服务器（写入连接配置，需刷新生效） */
async function connectSelfToHost() {
  if (!hasElectron) return;
  serverUrl.value = host.value.url || '';
  serverToken.value = host.value.token || '';
  dbMode.value = 'remote';
  selfConnectedToHost.value = true;
  await saveConfig();
}

async function copyText(text) {
  if (!text) return;
  let done = false;
  try {
    await navigator.clipboard.writeText(String(text));
    done = true;
  } catch { /* file:// 下剪贴板 API 可能不可用，走兜底 */ }
  if (!done) {
    try {
      const ta = document.createElement('textarea');
      ta.value = String(text);
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    } catch { /* 忽略 */ }
  }
}

async function toggleScan() {
  if (!hasElectron || !window.electronAPI.discovery) return;
  if (scanning.value) {
    await window.electronAPI.discovery.stop();
    scanning.value = false;
  } else {
    const res = await window.electronAPI.discovery.start();
    discovered.value = (res && res.list) || [];
    scanning.value = true;
  }
}

function applyDiscovered(d) {
  // 只自动填入地址：访问令牌无法从 mDNS 获取，需由成员从主机卡片复制后手动粘贴
  serverUrl.value = d.url || '';
}

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
  if (!hasElectron) {
    resultIsError.value = true;
    resultMessage.value = '保存失败: 当前环境不支持';
    showResultDialog.value = true;
    return;
  }
  const url = serverUrl.value.trim();
  const token = serverToken.value.trim();
  saving.value = true;
  try {
    /* 团队模式先测连通：连不上不静默保存，改为给出引导
       （否则会在刷新后于登录/启动阶段报"连不上服务器"，令人困惑） */
    if (dbMode.value === 'remote' && url) {
      const test = await window.electronAPI.dbConfig.test({ url, token, timeoutMs: 3500 });
      if (!test.success) {
        remoteWarnMsg.value = test.error || '连接失败，请检查地址与令牌';
        remoteWarnUrl.value = url;
        remoteWarnToken.value = token;
        showRemoteWarn.value = true;
        return;
      }
    }
    await persistConfig({ mode: dbMode.value, url, token });
  } finally {
    saving.value = false;
  }
}

/** 落盘数据源配置（保存成功弹「已切换」提示） */
async function persistConfig(cfg) {
  const res = await window.electronAPI.dbConfig.set(cfg);
  if (res.success) {
    showReloadDialog.value = true;
  } else {
    resultIsError.value = true;
    resultMessage.value = `保存失败: ${res.error}`;
    showResultDialog.value = true;
  }
}

/* 连不上仍要保存：按用户意愿落盘，启动时有回退弹窗兜底 */
async function saveRemoteAnyway() {
  showRemoteWarn.value = false;
  saving.value = true;
  try {
    await persistConfig({ mode: 'remote', url: remoteWarnUrl.value, token: remoteWarnToken.value });
  } finally {
    saving.value = false;
  }
}

/* 连不上时改把本机作为主机：启动内嵌服务器并连接它 */
async function hostFromWarn() {
  showRemoteWarn.value = false;
  saving.value = true;
  try {
    const res = await window.electronAPI.teamServer.start({});
    if (!res || !res.success) {
      resultIsError.value = true;
      resultMessage.value = (res && res.error) || '启动局域网主机失败';
      showResultDialog.value = true;
      return;
    }
    dbMode.value = 'remote';
    serverUrl.value = res.url || `http://localhost:${res.port}`;
    serverToken.value = res.token || '';
    await persistConfig({ mode: 'remote', url: serverUrl.value, token: serverToken.value });
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

  if (hasElectron && window.electronAPI.teamServer) {
    await refreshHost();
    offHostState = window.electronAPI.teamServer.onState(applyHostState);
    offHostLog = window.electronAPI.teamServer.onLog(({ line }) => {
      hostLogs.value = [...hostLogs.value, line].slice(-100);
    });
    /* 主机运行中（含自动恢复启动）时加载成员账号 */
    if (host.value.running) loadMembers();
    watch(() => host.value.running, (running) => {
      if (running) loadMembers();
      else { members.value = []; membersLoaded.value = false; }
    });
  }
  if (hasElectron && window.electronAPI.discovery) {
    offDiscovery = window.electronAPI.discovery.onUpdate((list) => { discovered.value = list || []; });
    /* 远程模式下自动开始扫描，方便直接选服务器 */
    if (dbMode.value === 'remote') {
      const res = await window.electronAPI.discovery.start();
      discovered.value = (res && res.list) || [];
      scanning.value = true;
    }
  }
});
onUnmounted(() => {
  stopMonitor();
  if (offHostState) offHostState();
  if (offHostLog) offHostLog();
  if (offDiscovery) offDiscovery();
  if (scanning.value && hasElectron && window.electronAPI.discovery) {
    window.electronAPI.discovery.stop();
  }
});
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

/* 局域网主机卡片：横跨两列 */
.db-host-card { grid-column: 1 / -1; }
.db-host-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.db-host-field > label {
  font-size: 12px;
  color: var(--text-secondary);
}
.db-host-value {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.db-host-value code {
  flex: 1;
  min-width: 0;
  padding: 6px 10px;
  font-size: 12px;
  word-break: break-all;
  color: var(--text-primary);
  background: var(--bg-primary, rgba(0, 0, 0, 0.15));
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm, 6px);
}
.db-host-token { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.db-host-error { margin: 0; font-size: 12px; color: #ef4444; }
.db-host-logs summary {
  cursor: pointer;
  font-size: 12px;
  color: var(--text-secondary);
}
.db-host-logs pre {
  margin: 8px 0 0;
  max-height: 180px;
  overflow: auto;
  padding: 8px 10px;
  font-size: 11px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--text-secondary);
  background: var(--bg-primary, rgba(0, 0, 0, 0.2));
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm, 6px);
}
.btn-mini { padding: 4px 10px; font-size: 12px; }

/* 成员账号（免邮箱验证直建） */
.db-host-members {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 10px;
  border-top: 1px dashed var(--border-color);
}
.db-host-members-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  color: var(--text-secondary);
}
.db-member-form {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 8px;
  align-items: center;
}
.db-member-form .btn { white-space: nowrap; }
.db-member-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 200px;
  overflow: auto;
}
.db-member-list li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  font-size: 12px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm, 6px);
  background: var(--bg-primary, rgba(0, 0, 0, 0.12));
}
.db-member-email { flex: 1; min-width: 0; color: var(--text-primary); word-break: break-all; }
.db-member-role { color: var(--text-secondary); }
.db-member-status { font-size: 11px; }
.db-member-status.ok { color: #22c55e; }
.db-member-status.off { color: #ef4444; }

/* 局域网发现的服务器列表 */
.db-discover {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 4px;
}
.db-discover-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  color: var(--text-secondary);
}
.btn-link {
  border: none;
  background: none;
  padding: 0;
  font-size: 12px;
  color: var(--accent-color, #3b82f6);
  cursor: pointer;
}
.btn-link:hover { text-decoration: underline; }
.db-discover-empty {
  font-size: 12px;
  color: var(--text-tertiary, var(--text-secondary));
  padding: 6px 2px;
}
.db-discover-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 160px;
  overflow: auto;
}
.db-discover-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 6px 10px;
  cursor: pointer;
  font-size: 12px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm, 6px);
  background: var(--bg-primary, rgba(0, 0, 0, 0.12));
}
.db-discover-list li:hover { border-color: var(--accent-color, #3b82f6); }
.db-discover-list li.active { border-color: var(--accent-color, #3b82f6); }
.db-disc-name { color: var(--text-primary); }
.db-disc-url { color: var(--text-secondary); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
</style>
