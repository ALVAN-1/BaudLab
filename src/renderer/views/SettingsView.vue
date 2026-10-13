<template>
  <div class="view-pad settings-view">
    <div class="view-header">
      <h2>系统设置</h2>
    </div>

    <!-- 外观设置 -->
    <div class="panel">
      <div class="panel-header"><h3>外观</h3></div>
      <div class="panel-body">
        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label">深色模式</span>
            <span class="setting-desc">切换浅色/深色界面主题</span>
          </div>
          <button class="theme-switch" :class="{ on: isDark }" @click="toggleTheme">
            <span class="theme-switch-thumb"></span>
          </button>
        </div>
      </div>
    </div>

    <!-- 通用设置 -->
    <div class="panel">
      <div class="panel-header"><h3>通用</h3></div>
      <div class="panel-body">
        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label">开机自启</span>
            <span class="setting-desc">系统启动后自动运行（最小化到托盘）</span>
          </div>
          <button class="theme-switch" :class="{ on: autoLaunch }" @click="toggleAutoLaunch">
            <span class="theme-switch-thumb"></span>
          </button>
        </div>
        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label">更新通知</span>
            <span class="setting-desc">发现新版本时弹出系统通知</span>
          </div>
          <button class="theme-switch" :class="{ on: updateNotify }" @click="toggleUpdateNotify">
            <span class="theme-switch-thumb"></span>
          </button>
        </div>
      </div>
    </div>

    <!-- 显示设置 -->
    <div class="panel">
      <div class="panel-header"><h3>显示</h3></div>
      <div class="panel-body">
        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label">显示换行符</span>
            <span class="setting-desc">在串口调试数据窗口中显示 \r\n 等控制字符</span>
          </div>
          <button class="theme-switch" :class="{ on: showNewline }" @click="toggleShowNewline">
            <span class="theme-switch-thumb"></span>
          </button>
        </div>
      </div>
    </div>

    <!-- 数据库连接（数据源切换与状态，自独立页迁入） -->
    <DatabaseConnectionView />

    <!-- GitHub 反馈配置 -->
    <div class="panel">
      <div class="panel-header"><h3>GitHub 反馈</h3></div>
      <div class="panel-body">
        <div class="setting-row column">
          <div class="setting-info">
            <span class="setting-label">私人令牌 (Access Token)</span>
            <span class="setting-desc">用于自动将反馈问题直接提交到 GitHub Issue，<a class="about-link" @click="openTokenHelp">如何获取？</a></span>
          </div>
          <input
            type="password"
            v-model="githubToken"
            class="input token-input"
            :placeholder="tokenConfigured ? '已配置（令牌保存在应用主进程，输入新值可覆盖）' : '粘贴你的 GitHub 令牌...'"
            @change="saveGithubToken"
          />
        </div>
        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label">当前配置状态</span>
          </div>
          <span :class="['status-chip', tokenConfigured ? 'ok' : 'warn']">{{ tokenConfigured ? '已配置（可直接提交反馈）' : '未配置（将跳转网页手动提交）' }}</span>
        </div>
      </div>
    </div>

    <!-- AI 助手（OpenAI / Anthropic 协议大模型） -->
    <div class="panel">
      <div class="panel-header"><h3>AI 助手</h3></div>
      <div class="panel-body">
        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label">启用 AI 助手</span>
            <span class="setting-desc">接入大模型服务，用于对话与串口/协议任务辅助</span>
          </div>
          <button class="theme-switch" :class="{ on: aiDraft.enabled }" @click="aiDraft.enabled = !aiDraft.enabled">
            <span class="theme-switch-thumb"></span>
          </button>
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label">AI 工具调用</span>
            <span class="setting-desc">允许模型在对话中主动查询协议库、最近串口数据与系统日志（只读，可在回复中看到调用记录）</span>
          </div>
          <button class="theme-switch" :class="{ on: aiDraft.toolsEnabled }" @click="aiDraft.toolsEnabled = !aiDraft.toolsEnabled">
            <span class="theme-switch-thumb"></span>
          </button>
        </div>

        <div class="ai-fields" :class="{ disabled: !aiDraft.enabled }">
          <!-- 协议 + 服务商预设 -->
          <div class="ai-top">
            <div class="ai-field ai-protocol">
              <span class="ai-field-label">接口协议</span>
              <div class="ai-seg">
                <button type="button" :class="{ on: aiDraft.protocol === 'openai' }" @click="aiDraft.protocol = 'openai'">OpenAI 兼容</button>
                <button type="button" :class="{ on: aiDraft.protocol === 'anthropic' }" @click="aiDraft.protocol = 'anthropic'">Anthropic 兼容</button>
              </div>
            </div>
            <div class="ai-field ai-grow">
              <span class="ai-field-label">服务商快捷填充 <span class="ai-hint-inline">点选自动填入地址与模型名，Key 仍需自行填写</span></span>
              <div class="ai-presets">
                <button
                  v-for="p in aiPresets"
                  :key="p.name"
                  type="button"
                  class="ai-preset"
                  :class="{ on: isActivePreset(p) }"
                  @click="applyPreset(p)"
                >{{ p.name }}</button>
              </div>
            </div>
          </div>

          <!-- Base URL -->
          <div class="ai-field">
            <span class="ai-field-label">API Base URL</span>
            <input type="text" v-model="aiDraft.baseUrl" class="input" :placeholder="aiDraft.protocol === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.deepseek.com/v1'" />
            <span class="ai-field-hint">填服务地址即可，主进程自动补全接口路径</span>
          </div>

          <!-- Key + 模型 -->
          <div class="ai-grid">
            <div class="ai-field">
              <span class="ai-field-label">API Key</span>
              <input
                type="password"
                v-model="aiKey"
                class="input"
                :placeholder="aiHas ? '已配置，输入新值可覆盖' : '粘贴你的 API Key...'"
              />
              <span class="ai-field-hint">{{ aiKeyHint }}</span>
            </div>
            <div class="ai-field" ref="modelFieldRef">
              <span class="ai-field-label">模型名称（默认）</span>
              <div class="ai-model-row">
                <input type="text" v-model="aiDraft.model" class="input" placeholder="deepseek-chat" />
                <button type="button" class="btn btn-secondary ai-fetch-btn" :disabled="aiModelsLoading" @click="fetchAiModels">
                  <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#i-download"/></svg>
                  {{ aiModelsLoading ? '获取中…' : '获取模型列表' }}
                </button>
              </div>
              <div v-if="aiModelsOpen" class="ai-model-menu">
                <input v-model="aiModelFilter" class="input ai-model-filter" placeholder="输入关键字筛选模型…" @keydown.esc="aiModelsOpen = false" />
                <div class="ai-model-list">
                  <div v-for="m in filteredModels" :key="m" class="ai-model-row-item">
                    <button
                      type="button"
                      class="ai-model-item"
                      :class="{ on: aiDraft.model === m }"
                      :title="aiDraft.model === m ? '当前默认模型' : '设为默认模型'"
                      @click="pickModel(m)"
                    >{{ m }}</button>
                    <button
                      type="button"
                      class="ai-model-add"
                      :class="{ on: isModelAdded(m) }"
                      :title="isModelAdded(m) ? '从使用列表移除' : '加入使用列表（AI 界面可切换）'"
                      @click="toggleModelInList(m)"
                    >
                      <svg v-if="isModelAdded(m)" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#i-check"/></svg>
                      <svg v-else width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><use href="#i-plus"/></svg>
                    </button>
                  </div>
                  <div v-if="!filteredModels.length" class="ai-model-empty">没有匹配的模型</div>
                </div>
              </div>
              <span v-if="aiModelsError" class="ai-model-error">{{ aiModelsError }}</span>
            </div>

            <!-- 使用中的模型列表 -->
            <div class="ai-field" v-if="aiDraft.models.length">
              <span class="ai-field-label">使用中的模型</span>
              <div class="ai-presets">
                <span v-for="m in aiDraft.models" :key="m" class="ai-used-chip">
                  <span class="ai-used-name">{{ m }}</span>
                  <button type="button" class="ai-used-remove" title="移除" @click="removeModel(m)">
                    <svg width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><use href="#i-close"/></svg>
                  </button>
                </span>
              </div>
              <span class="ai-field-hint">AI 助手界面可从这些模型中随时切换；默认模型保存时自动加入</span>
            </div>
          </div>

          <!-- 高级：系统提示词（默认折叠） -->
          <details class="ai-advanced">
            <summary>高级选项 · 系统提示词</summary>
            <div class="ai-advanced-body">
              <textarea v-model="aiDraft.systemPrompt" class="input ai-prompt" rows="3"></textarea>
              <span class="ai-field-hint">赋予 AI 角色与背景，留空使用默认串口协议助手设定</span>
            </div>
          </details>

          <div class="ai-actions">
            <button class="btn btn-primary" :disabled="aiSaving" @click="saveAiConfig">{{ aiSaving ? '保存中…' : '保存配置' }}</button>
            <button class="btn btn-secondary" :disabled="aiTesting" @click="testAiConfig">{{ aiTesting ? '测试中…' : '测试连接' }}</button>
            <span v-if="aiTestResult" :class="['ai-test-result', aiTestResult.ok ? 'ok' : 'fail']">
              <svg v-if="aiTestResult.ok" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#i-check"/></svg>
              <svg v-else width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><use href="#i-alert-circle"/></svg>
              <span>{{ aiTestResult.text }}</span>
            </span>
          </div>
          <p class="ai-privacy-note">
            <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" style="flex-shrink:0;margin-top:2px;"><use href="#i-alert-circle"/></svg>
            <span>对话内容及你粘贴的串口/协议数据将发送到你配置的服务商；涉密数据请使用本地模型（如 Ollama）。</span>
          </p>
        </div>
      </div>
    </div>

    <!-- MCP 接入（外部 AI 客户端） -->
    <div class="panel">
      <div class="panel-header"><h3>MCP 接入（外部 AI 客户端）</h3></div>
      <div class="panel-body mcp-panel-body">
        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-label">MCP 桥状态</span>
            <span class="setting-desc">
              {{ mcpInfo.bridgeReady
                ? `已就绪（127.0.0.1:${mcpInfo.bridgePort}）——外部 AI 客户端可在线调用全部工具`
                : '未就绪——离线模式下外部客户端仍可只读直读数据库，重启应用可恢复在线桥' }}
            </span>
          </div>
          <span :class="['mcp-status-dot', { on: mcpInfo.bridgeReady }]"></span>
        </div>

        <div class="mcp-intro">
          把本工具的协议库、构帧/解帧、串口调试与日志统计开放给支持 MCP 的 AI 客户端
          （Claude Desktop、Cursor、ZCode、CLine 等），共 18 个工具。
          其中串口收发、数据库备份、发布草稿 5 个写操作会先在本窗口弹出确认框，允许后才会执行。
        </div>

        <div class="mcp-config-block">
          <div class="mcp-config-head">
            <span class="ai-field-label">客户端配置（加入 mcpServers 后重启客户端即可）</span>
            <button type="button" class="btn btn-secondary mcp-copy-btn" @click="copyMcpConfig">
              <svg v-if="mcpCopied" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#i-check"/></svg>
              <svg v-else width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              {{ mcpCopied ? '已复制' : '复制配置' }}
            </button>
          </div>
          <pre class="mcp-config-json">{{ mcpConfigJson }}</pre>
          <span class="ai-field-hint">配置一次即可，多客户端可同时使用；桌面应用开着为在线模式，没开则自动退化为只读数据库直读。</span>
        </div>

        <div class="mcp-tools-summary">
          <span class="mcp-chip">11 只读工具（离线可用）</span>
          <span class="mcp-chip">2 实时工具（需应用在线）</span>
          <span class="mcp-chip warn">5 写操作（弹窗人工确认）</span>
          <span class="mcp-chip">4 资源 · 3 调试模板</span>
        </div>

        <div v-if="Object.keys(mcpPolicies).length" class="mcp-policy-row">
          <span class="ai-field-label">已记住的确认（勾选过"不再询问"）</span>
          <div class="mcp-policy-chips">
            <span v-for="(v, key) in mcpPolicies" :key="key" class="ai-used-chip">
              <span class="ai-used-name">{{ key }}</span>
              <button type="button" class="ai-used-remove" title="恢复询问" @click="resetMcpPolicy(key)">
                <svg width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><use href="#i-close"/></svg>
              </button>
            </span>
            <button type="button" class="btn btn-secondary mcp-policy-reset-all" @click="resetMcpPolicy('*')">全部恢复询问</button>
          </div>
          <span class="ai-field-hint">重置后，对应的写操作会重新弹出确认框</span>
        </div>

        <p class="ai-privacy-note">
          <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" style="flex-shrink:0;margin-top:2px;"><use href="#i-alert-circle"/></svg>
          <span>安全边界：桥仅监听本机回环并使用随机令牌；若数据涉密，请只把 MCP 接入本地模型客户端。完整指南见 docs/MCP接入指南.md。</span>
        </p>
      </div>
    </div>

    <!-- 关于 -->
    <div class="panel">
      <div class="panel-header"><h3>关于</h3></div>
      <div class="panel-body">
        <div class="about-section">
          <div class="about-row"><span class="about-label">应用名称</span><span class="about-value">Serial Protocol Manager</span></div>
          <div class="about-row"><span class="about-label">版本</span><span class="about-value">v{{ appVersion }}</span></div>
          <div class="about-row"><span class="about-label">技术栈</span><span class="about-value">Electron + Vue 3 + better-sqlite3</span></div>
          <div class="about-row"><span class="about-label">仓库</span><a class="about-link" @click="openGithub">GitHub →</a></div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { reactive, onMounted, onUnmounted, ref, computed, watch } from 'vue';
import { useTheme } from '../composables/useTheme';
import { useLogSettings } from '../composables/useLogSettings';
import { useGithubToken } from '../composables/useGithubToken';
import DatabaseConnectionView from './DatabaseConnectionView.vue';

const { isDark, toggleTheme } = useTheme();
const { showNewline, toggleShowNewline } = useLogSettings();
const appVersion = ref('—');
const autoLaunch = ref(false);
const updateNotify = ref(true);

const githubToken = ref('');
const { configured: tokenConfigured, refresh: refreshTokenStatus, ensureMigrated } = useGithubToken();

/* ===================== AI 助手配置 ===================== */
const aiDraft = reactive({ enabled: false, protocol: 'openai', baseUrl: '', model: '', systemPrompt: '', toolsEnabled: true, models: [] });
const aiKey = ref('');          // 明文只在输入框短暂存在，保存后立即清空
const aiHas = ref(false);
const aiSaving = ref(false);
const aiTesting = ref(false);
const aiTestResult = ref(null); // { ok, text }

/* 模型列表获取 */
const aiModels = ref([]);
const aiModelsLoading = ref(false);
const aiModelsOpen = ref(false);
const modelFieldRef = ref(null);
/* 点击菜单外任意处收起（document 捕获监听） */
function onDocMouseDownForModels(e) {
  const el = modelFieldRef.value;
  if (el && !el.contains(e.target)) aiModelsOpen.value = false;
}
watch(aiModelsOpen, (open) => {
  if (open) document.addEventListener('mousedown', onDocMouseDownForModels, true);
  else document.removeEventListener('mousedown', onDocMouseDownForModels, true);
});
onUnmounted(() => document.removeEventListener('mousedown', onDocMouseDownForModels, true));
const aiModelFilter = ref('');
const aiModelsError = ref('');
const filteredModels = computed(() => {
  const kw = aiModelFilter.value.trim().toLowerCase();
  if (!kw) return aiModels.value;
  return aiModels.value.filter((m) => m.toLowerCase().includes(kw));
});

async function fetchAiModels() {
  const a = window.electronAPI?.ai;
  if (!a || aiModelsLoading.value) return;
  if (aiModelsOpen.value) { aiModelsOpen.value = false; return; } /* 再点一次收起菜单（多选添加场景） */
  if (!(await saveAiConfig())) return;   // 列表接口读取已保存的地址与 Key
  aiModelsLoading.value = true;
  aiModelsError.value = '';
  try {
    const r = await a.listModels();
    if (r.success && Array.isArray(r.models) && r.models.length) {
      aiModels.value = r.models;
      aiModelFilter.value = '';
      aiModelsOpen.value = true;
    } else {
      aiModelsOpen.value = false;
      aiModelsError.value = r.error || (r.success ? '服务商未返回任何模型' : '获取失败');
    }
  } catch (e) {
    aiModelsError.value = String(e.message || e);
  } finally {
    aiModelsLoading.value = false;
  }
}

function pickModel(id) {
  aiDraft.model = id;
  if (!isModelAdded(id)) aiDraft.models.push(id);
}

function isModelAdded(m) {
  return (aiDraft.models || []).includes(m);
}

function toggleModelInList(m) {
  const i = aiDraft.models.indexOf(m);
  if (i >= 0) aiDraft.models.splice(i, 1);
  else aiDraft.models.push(m);
}

function removeModel(m) {
  const i = aiDraft.models.indexOf(m);
  if (i >= 0) aiDraft.models.splice(i, 1);
  /* 移除的正是默认模型时，默认回落到列表剩余第一个 */
  if (aiDraft.model === m) aiDraft.model = aiDraft.models[0] || '';
}

/* 服务商快捷填充：点击自动填地址与模型名（模型名随服务商迭代，仅作快捷起点可再改） */
const AI_PRESETS = {
  openai: [
    { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    { name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
    { name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.6' },
    { name: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k2-0711-preview' },
    { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    { name: '本地 Ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b' },
  ],
  anthropic: [
    { name: 'Anthropic 官方', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5' },
    { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/anthropic', model: 'deepseek-chat' },
    { name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/anthropic', model: 'glm-4.6' },
    { name: 'Kimi', baseUrl: 'https://api.moonshot.cn/anthropic', model: 'kimi-k2-0711-preview' },
  ],
};
const aiPresets = computed(() => AI_PRESETS[aiDraft.protocol] || AI_PRESETS.openai);

function normUrlForCompare(u) {
  return String(u || '').trim().replace(/\/+$/, '').toLowerCase();
}
function isActivePreset(p) {
  return normUrlForCompare(p.baseUrl) === normUrlForCompare(aiDraft.baseUrl);
}
function applyPreset(p) {
  aiDraft.baseUrl = p.baseUrl;
  aiDraft.model = p.model;
}

const aiKeyHint = computed(() => {
  if (!aiHas.value) return '仅保存在本机（主进程加密），渲染层不留明文';
  return '已配置，输入新值可覆盖';
});

async function loadAiConfig() {
  const a = window.electronAPI?.ai;
  if (!a) return;
  try {
    const r = await a.getConfig();
    if (r.success) {
      aiDraft.enabled = !!r.enabled;
      aiDraft.protocol = r.protocol === 'anthropic' ? 'anthropic' : 'openai';
      aiDraft.toolsEnabled = r.toolsEnabled !== false;
      aiDraft.models = Array.isArray(r.models) ? [...r.models] : [];
      aiDraft.baseUrl = r.baseUrl || '';
      aiDraft.model = r.model || '';
      aiDraft.systemPrompt = r.systemPrompt || '';
      aiHas.value = !!r.hasKey;
    }
  } catch { /* ignore */ }
}

async function saveAiConfig() {
  const a = window.electronAPI?.ai;
  if (!a) return;
  aiSaving.value = true;
  try {
    const payload = {
      enabled: aiDraft.enabled,
      protocol: aiDraft.protocol,
      toolsEnabled: aiDraft.toolsEnabled,
      baseUrl: aiDraft.baseUrl.trim(),
      model: aiDraft.model.trim(),
      systemPrompt: aiDraft.systemPrompt,
    };
    /* 默认模型自动进入使用列表；保存后 AI 助手界面即可切换这些模型 */
    const modelSet = new Set(aiDraft.models || []);
    if (payload.model) modelSet.add(payload.model);
    payload.models = [...modelSet];
    if (aiKey.value.trim()) payload.apiKey = aiKey.value.trim();
    const r = await a.setConfig(payload);
    if (r.success) {
      aiKey.value = '';           // 主进程已持久化，清空避免明文残留
      aiHas.value = !!r.hasKey;
    }
    return r.success;
  } catch {
    return false;
  } finally {
    aiSaving.value = false;
  }
}

async function testAiConfig() {
  if (!(await saveAiConfig())) return;
  const a = window.electronAPI?.ai;
  if (!a) return;
  aiTesting.value = true;
  aiTestResult.value = null;
  try {
    const r = await a.test();
    aiTestResult.value = r.success
      ? { ok: true, text: `连通正常 · ${r.model} · ${r.latencyMs}ms · 回复: ${r.reply}` }
      : { ok: false, text: r.error };
  } catch (e) {
    aiTestResult.value = { ok: false, text: String(e.message || e) };
  } finally {
    aiTesting.value = false;
  }
}

/* ===================== MCP 接入（外部 AI 客户端） ===================== */
const mcpInfo = ref({ serverPath: '', dataDir: '', bridgeReady: false, bridgePort: null });
const mcpCopied = ref(false);
let mcpCopyTimer = null;
const mcpConfigJson = computed(() => JSON.stringify({
  mcpServers: {
    'serial-protocol-manager': {
      command: 'node',
      args: [mcpInfo.value.serverPath || '<mcp-server.js 路径>'],
    },
  },
}, null, 2));

async function copyMcpConfig() {
  const text = mcpConfigJson.value;
  let done = false;
  try {
    await navigator.clipboard.writeText(text);
    done = true;
  } catch { /* file:// 下剪贴板 API 可能不可用，走 execCommand 兜底 */ }
  if (!done) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      done = document.execCommand('copy');
      document.body.removeChild(ta);
    } catch { done = false; }
  }
  mcpCopied.value = done;
  if (mcpCopyTimer) clearTimeout(mcpCopyTimer);
  mcpCopyTimer = setTimeout(() => { mcpCopied.value = false; }, 2000);
}
onUnmounted(() => { if (mcpCopyTimer) clearTimeout(mcpCopyTimer); });

/* 已记住的写操作确认策略（mcp-policy.json）：查看与重置 */
const mcpPolicies = ref({});
async function refreshMcpPolicies() {
  if (!window.electronAPI?.app?.getMcpPolicies) return;
  try { mcpPolicies.value = await window.electronAPI.app.getMcpPolicies() || {}; } catch { /* ignore */ }
}
async function resetMcpPolicy(key) {
  if (!window.electronAPI?.app?.resetMcpPolicy) return;
  try {
    await window.electronAPI.app.resetMcpPolicy(key);
    await refreshMcpPolicies();
  } catch { /* ignore */ }
}

onMounted(async () => {
  // MCP 接入信息（服务器路径随开发态/安装版自动切换）
  if (window.electronAPI?.app?.getMcpInfo) {
    try { mcpInfo.value = await window.electronAPI.app.getMcpInfo(); } catch { /* ignore */ }
  }
  refreshMcpPolicies();
  // GitHub token：迁移旧 localStorage 令牌到主进程并刷新状态
  await ensureMigrated();
  // AI 助手配置
  loadAiConfig();
  // 加载更新通知偏好
  const notifyPref = localStorage.getItem('spm-update-notify');
  updateNotify.value = notifyPref === null ? true : notifyPref === '1';
  // 获取版本号
  if (window.electronAPI?.app?.getVersion) {
    try { appVersion.value = await window.electronAPI.app.getVersion(); } catch { /* ignore */ }
  }
  // 获取开机自启状态
  if (window.electronAPI?.app?.getLoginItemSettings) {
    try {
      const r = await window.electronAPI.app.getLoginItemSettings();
      autoLaunch.value = r.openAtLogin;
    } catch { /* ignore */ }
  }
});

async function toggleAutoLaunch() {
  if (!window.electronAPI?.app?.setLoginItemSettings) return;
  const next = !autoLaunch.value;
  try {
    const r = await window.electronAPI.app.setLoginItemSettings({ openAtLogin: next });
    if (r.success) {
      autoLaunch.value = next;
    }
  } catch { /* ignore */ }
}

function toggleUpdateNotify() {
  updateNotify.value = !updateNotify.value;
  localStorage.setItem('spm-update-notify', updateNotify.value ? '1' : '0');
  if (window.electronAPI?.app?.setUpdateNotify) {
    window.electronAPI.app.setUpdateNotify(updateNotify.value);
  }
}

async function saveGithubToken() {
  if (!window.electronAPI?.feedback?.setToken) return;
  try {
    const r = await window.electronAPI.feedback.setToken(githubToken.value);
    if (r.success) {
      // 主进程已持久化，清空输入框避免明文残留在渲染层内存
      githubToken.value = '';
      await refreshTokenStatus();
    }
  } catch { /* ignore */ }
}

function openTokenHelp() {
  if (window.electronAPI?.shell?.openExternal) {
    window.electronAPI.shell.openExternal('https://github.com/settings/tokens');
  }
}

function openGithub() {
  if (window.electronAPI?.shell?.openExternal) {
    window.electronAPI.shell.openExternal('https://github.com/ALVAN-1/BaudLab.io');
  }
}
</script>

<style scoped>
.settings-view { display: flex; flex-direction: column; gap: 16px; height: 100%; overflow-y: auto; }
/* 面板高度由内容决定：容器是固定高度的 flex 列，不加此项内容超高时
 * 各面板会被 flex 默认压缩裁剪（表现为设置项显示不全、无法填写） */
.settings-view > .panel { flex-shrink: 0; }
.view-header { flex-shrink: 0; }
.view-header h2 { font-size: 18px; font-weight: 600; margin: 0; }

.setting-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 6px 0;
}
.setting-row.column { flex-direction: column; align-items: flex-start; gap: 8px; }
.setting-info { display: flex; flex-direction: column; gap: 2px; }
.setting-label { font-size: 14px; font-weight: 500; color: var(--text-primary); }
.setting-desc { font-size: 12px; color: var(--text-tertiary); }

.token-input {
  width: 100%;
  font-family: var(--font-mono);
}

.status-chip {
  padding: 4px 10px; border-radius: 20px; font-size: 12px; font-weight: 500;
}
.status-chip.ok { background: rgba(16, 185, 129, 0.12); color: var(--accent-green); }
.status-chip.warn { background: rgba(245, 158, 11, 0.12); color: var(--accent-amber); }

.settings-grid {
  display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px;
}
.setting-field { display: flex; flex-direction: column; gap: 6px; }
.setting-field label { font-size: 13px; font-weight: 500; color: var(--text-secondary); }
.setting-field select {
  background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 6px;
  padding: 6px 10px; font-size: 13px; color: var(--text-primary); outline: none;
}
.setting-field select:focus { border-color: var(--accent-blue); }

.about-section { display: flex; flex-direction: column; gap: 8px; }
.about-row { display: flex; align-items: center; gap: 12px; }
.about-label { font-size: 13px; color: var(--text-tertiary); width: 80px; flex-shrink: 0; }
.about-value { font-size: 14px; color: var(--text-primary); font-weight: 500; }
.about-link { font-size: 14px; color: var(--accent-blue); cursor: pointer; }
.about-link:hover { text-decoration: underline; }

/* AI 助手配置 */
.ai-fields { display: flex; flex-direction: column; gap: 14px; margin-top: 10px; }
.ai-fields.disabled { opacity: 0.5; pointer-events: none; }
.ai-top { display: flex; gap: 24px; flex-wrap: wrap; align-items: flex-start; }
.ai-protocol { flex-shrink: 0; }
.ai-grow { flex: 1; min-width: 280px; }
.ai-field { display: flex; flex-direction: column; gap: 6px; }
.ai-field-label { font-size: 13px; font-weight: 500; color: var(--text-primary); }
.ai-hint-inline { font-weight: 400; font-size: 12px; color: var(--text-tertiary); margin-left: 6px; }
.ai-field-hint { font-size: 12px; color: var(--text-tertiary); line-height: 1.5; }
.ai-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.ai-prompt { resize: vertical; font-family: inherit; }

/* 模型列表获取 */
.ai-model-row { display: flex; gap: 8px; }
.ai-model-row .input { flex: 1; min-width: 0; }
.ai-fetch-btn { flex-shrink: 0; padding: 7px 12px; font-size: 12.5px; }
.ai-model-menu {
  display: flex; flex-direction: column; gap: 8px; padding: 8px;
  background: var(--bg-elevated); border: 1px solid var(--border-light); border-radius: var(--radius-md);
  box-shadow: var(--shadow-md);
}
.ai-model-filter { padding: 6px 10px; font-size: 12.5px; }
.ai-model-list { max-height: 220px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
.ai-model-row-item { display: flex; align-items: center; gap: 6px; }
.ai-model-row-item .ai-model-item { flex: 1; min-width: 0; }
.ai-model-add {
  display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;
  width: 26px; height: 26px; border-radius: var(--radius-sm); cursor: pointer;
  background: transparent; border: 1px solid var(--border-light); color: var(--text-tertiary);
}
.ai-model-add:hover { color: var(--text-primary); border-color: var(--text-muted); }
.ai-model-add.on { background: var(--accent-amber-glow); border-color: var(--accent-amber); color: var(--accent-amber); }
.ai-used-chip {
  display: inline-flex; align-items: center; gap: 5px;
  background: var(--accent-amber-glow); border: 1px solid var(--accent-amber); border-radius: 999px;
  padding: 4px 6px 4px 12px; font-size: 12px; color: var(--accent-amber);
}
.ai-used-name { font-family: var(--font-mono, monospace); max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ai-used-remove {
  display: inline-flex; align-items: center; justify-content: center;
  width: 16px; height: 16px; border: none; border-radius: 50%; cursor: pointer;
  background: transparent; color: inherit;
}
.ai-used-remove:hover { background: rgba(0, 0, 0, 0.15); }
.ai-model-item {
  text-align: left; border: none; background: transparent; cursor: pointer;
  border-radius: var(--radius-sm); padding: 7px 10px;
  font-family: var(--font-mono); font-size: 12.5px; color: var(--text-primary);
}
.ai-model-item:hover { background: var(--bg-hover); }
.ai-model-item.on { color: var(--accent-amber); }
.ai-model-empty { padding: 10px; text-align: center; font-size: 12px; color: var(--text-tertiary); }
.ai-model-error { font-size: 12px; color: var(--accent-red); }

/* 协议切换（分段按钮） */
.ai-seg {
  display: inline-flex; gap: 3px; padding: 3px; align-self: flex-start;
  background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: var(--radius-md);
}
.ai-seg button {
  border: none; background: transparent; cursor: pointer; transition: all 0.15s ease;
  border-radius: calc(var(--radius-md) - 4px); padding: 6px 16px;
  font-family: var(--font-display); font-size: 12.5px; color: var(--text-secondary);
}
.ai-seg button:hover { color: var(--text-primary); }
.ai-seg button:focus { outline: none; }
.ai-seg button:focus-visible { outline: 2px solid var(--accent-blue); outline-offset: 1px; }
.ai-seg button.on { background: var(--accent-amber); color: #1a1200; font-weight: 500; }

/* 服务商预设 */
.ai-presets { display: flex; flex-wrap: wrap; gap: 8px; }
.ai-preset {
  background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 999px;
  padding: 6px 14px; font-family: var(--font-display); font-size: 12px; color: var(--text-secondary);
  cursor: pointer; transition: all 0.15s ease;
}
.ai-preset:hover { color: var(--text-primary); border-color: var(--text-muted); background: var(--bg-hover); }
.ai-preset.on { background: var(--accent-amber-glow); border-color: var(--accent-amber); color: var(--accent-amber); }

/* 高级选项折叠 */
.ai-advanced {
  background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: var(--radius-md);
  padding: 0 14px;
}
.ai-advanced summary {
  cursor: pointer; user-select: none; padding: 10px 0;
  font-family: var(--font-display); font-size: 13px; font-weight: 500; color: var(--text-secondary);
}
.ai-advanced summary:hover { color: var(--text-primary); }
.ai-advanced[open] summary { border-bottom: 1px solid var(--border-color); margin-bottom: 10px; }
.ai-advanced-body { display: flex; flex-direction: column; gap: 6px; padding-bottom: 12px; }

.ai-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ai-test-result { font-size: 12px; line-height: 1.5; word-break: break-all; display: inline-flex; align-items: flex-start; gap: 6px; }
.ai-test-result svg { flex-shrink: 0; margin-top: 2px; }
.ai-test-result.ok { color: var(--accent-green); }
.ai-test-result.fail { color: var(--accent-red); }
.ai-privacy-note {
  margin: 0; padding-top: 10px; border-top: 1px dashed var(--border-color);
  font-size: 12px; color: var(--accent-amber); opacity: 0.85;
  display: flex; align-items: flex-start; gap: 6px;
}

/* ===================== MCP 接入面板 ===================== */
.mcp-panel-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.mcp-status-dot {
  width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0;
  background: var(--text-muted);
}
.mcp-status-dot.on {
  background: var(--accent-green);
  box-shadow: 0 0 6px var(--accent-green-glow);
}
.mcp-intro {
  font-size: 12.5px; line-height: 1.7; color: var(--text-secondary);
  padding: 10px 12px; border-radius: 8px;
  background: var(--bg-tertiary); border: 1px solid var(--border-color);
}
.mcp-config-block { display: flex; flex-direction: column; gap: 8px; }
.mcp-config-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.mcp-copy-btn { display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; }
.mcp-config-json {
  margin: 0; padding: 12px 14px; border-radius: 8px;
  background: var(--bg-primary); border: 1px solid var(--border-color);
  font-family: Consolas, 'Courier New', monospace; font-size: 12px; line-height: 1.6;
  color: var(--text-primary); white-space: pre-wrap; word-break: break-all;
  user-select: text; cursor: text;
}
.mcp-tools-summary { display: flex; flex-wrap: wrap; gap: 8px; }
.mcp-chip {
  font-size: 11.5px; padding: 3px 10px; border-radius: 999px;
  color: var(--text-secondary);
  background: var(--bg-tertiary); border: 1px solid var(--border-color);
}
.mcp-chip.warn { color: var(--accent-amber); border-color: var(--accent-amber-glow); }
.mcp-policy-row { display: flex; flex-direction: column; gap: 8px; padding-top: 10px; border-top: 1px dashed var(--border-color); }
.mcp-policy-chips { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.mcp-policy-reset-all { font-size: 12px; padding: 3px 10px; }
</style>
