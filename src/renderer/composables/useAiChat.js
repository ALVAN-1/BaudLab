/**
 * AI 助手对话状态（模块级单例）
 * - 多会话管理：conversations/activeId，localStorage 持久化（spm-ai-chat-conversations）
 * - 会话各自绑定模型，对话界面头部可切换（请求时覆盖配置的默认模型）
 * - 工具调用记录归并到消息、流式增量、上下文临时注入（不落历史）
 * - 旧版单会话数据（spm-ai-chat-history）自动迁移为一条会话
 */
import { ref, computed } from 'vue';

const CONV_KEY = 'spm-ai-chat-conversations';
const LEGACY_KEY = 'spm-ai-chat-history';
const MAX_MESSAGES = 200;     // 每会话持久化条数上限
const MAX_CONVERSATIONS = 30; // 会话数上限
const MAX_CONTEXT = 30;       // 单次请求携带的历史条数上限（token 成本控制）

const config = ref({ enabled: false, protocol: 'openai', baseUrl: '', model: '', hasKey: false, systemPrompt: '', models: [] });
const conversations = ref([]);
const activeId = ref('');
const streaming = ref(false);
const configLoaded = ref(false);

let seq = 0;
let currentRequestId = '';
let streamingConvId = '';
let listening = false;

const api = () => window.electronAPI?.ai || null;

function newId() {
  return `c${Date.now()}-${seq++}`;
}

const activeConversation = () => conversations.value.find((c) => c.id === activeId.value) || null;
const messages = computed(() => {
  const c = activeConversation();
  return c ? c.messages : [];
});

/* ---------------- 配置 ---------------- */
async function refreshConfig() {
  const a = api();
  if (!a) return;
  try {
    const r = await a.getConfig();
    if (r.success) {
      config.value = {
        enabled: !!r.enabled,
        protocol: r.protocol || 'openai',
        baseUrl: r.baseUrl || '',
        model: r.model || '',
        hasKey: !!r.hasKey,
        systemPrompt: r.systemPrompt || '',
        models: Array.isArray(r.models) ? r.models : [],
      };
    }
    configLoaded.value = true;
  } catch { /* 浏览器 dev 模式无 IPC */ }
}

/* ---------------- 会话管理 ---------------- */
function slimConversations() {
  return conversations.value.slice(0, MAX_CONVERSATIONS).map((c) => ({
    ...c,
    messages: (c.messages || []).slice(-MAX_MESSAGES),
  }));
}

/* 附件剥离后的消息（localStorage 配额不足时的降级形态：图片只剩名称占位） */
function stripMessageAttachments(m) {
  if (!m || !Array.isArray(m.attachments) || !m.attachments.length) return m;
  return {
    ...m,
    attachments: m.attachments.map((a) => (a.type === 'image'
      ? { ...a, dataUrl: '' }
      : { ...a, content: '' })),
  };
}

function persist() {
  try {
    localStorage.setItem(CONV_KEY, JSON.stringify(slimConversations()));
  } catch {
    /* 存储满：丢掉图片数据与文件正文再试一次（气泡里图片降级为占位） */
    try {
      const slim = slimConversations().map((c) => ({
        ...c,
        messages: (c.messages || []).map(stripMessageAttachments),
      }));
      localStorage.setItem(CONV_KEY, JSON.stringify(slim));
    } catch { /* 仍失败则放弃本次持久化，不影响对话 */ }
  }
}

function loadSessions() {
  if (conversations.value.length) return;
  try {
    const raw = localStorage.getItem(CONV_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        conversations.value = arr.filter((c) => c && c.id && Array.isArray(c.messages)).slice(0, MAX_CONVERSATIONS);
      }
    } else {
      /* 旧版单会话迁移 */
      const legacy = localStorage.getItem(LEGACY_KEY);
      if (legacy) {
        const msgs = JSON.parse(legacy);
        if (Array.isArray(msgs) && msgs.length) {
          conversations.value = [{
            id: newId(), title: '历史会话', model: '', messages: msgs.slice(-MAX_MESSAGES),
            createdAt: Date.now(), updatedAt: Date.now(),
          }];
        }
      }
    }
  } catch { /* 历史损坏视为无历史 */ }
  if (!conversations.value.length) createConversation({ silent: true });
  if (!activeConversation()) activeId.value = conversations.value[0].id;
}

function createConversation({ silent } = {}) {
  const conv = {
    id: newId(),
    title: '新会话',
    model: config.value.model || '',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  conversations.value.unshift(conv);
  activeId.value = conv.id;
  if (!silent) persist();
  return conv;
}

function switchConversation(id) {
  if (id === activeId.value) return;
  const conv = conversations.value.find((c) => c.id === id);
  if (!conv) return;
  activeId.value = id;
  persist();
}

function deleteConversation(id) {
  const idx = conversations.value.findIndex((c) => c.id === id);
  if (idx < 0) return;
  conversations.value.splice(idx, 1);
  if (activeId.value === id) {
    if (conversations.value.length) activeId.value = conversations.value[0].id;
    else createConversation();
  }
  persist();
}

function renameConversation(id, title) {
  const conv = conversations.value.find((c) => c.id === id);
  const t = String(title || '').trim().slice(0, 30);
  if (conv && t) conv.title = t;
  persist();
}

/* 当前会话切换模型（会话级，互不影响） */
function setActiveModel(model) {
  const conv = activeConversation();
  const m = String(model || '').trim().slice(0, 120);
  if (conv) {
    conv.model = m;
    conv.updatedAt = Date.now();
    persist();
  }
}

function clearHistory() {
  const conv = activeConversation();
  if (conv) {
    conv.messages = [];
    conv.updatedAt = Date.now();
  }
  persist();
}

/* ---------------- 发送 ---------------- */
/* 用户消息 → API content：文本附件内联进正文；带图片时改为 OpenAI 多模态数组
 * （Anthropic 协议的 image_url → base64 块转换由主进程完成） */
function buildUserContent(m) {
  const atts = m.attachments || [];
  let text = m.content || '';
  for (const a of atts) {
    if (a.type === 'file' && a.content) {
      text += (text ? '\n\n' : '') + `--- 附件文件：${a.name} ---\n${a.content}\n--- 附件结束 ---`;
    }
  }
  const images = atts.filter((a) => a.type === 'image' && a.dataUrl);
  if (!images.length) return text;
  const parts = [];
  if (text) parts.push({ type: 'text', text });
  for (const img of images) parts.push({ type: 'image_url', image_url: { url: img.dataUrl } });
  return parts;
}

function buildApiMessages() {
  return messages.value
    .filter((m) => !m.streaming && !m.errorText
      && (m.role === 'user' || m.role === 'assistant')
      && (m.content || (Array.isArray(m.attachments) && m.attachments.length)))
    .slice(-MAX_CONTEXT)
    .map((m) => (m.role === 'user'
      ? { role: 'user', content: buildUserContent(m) }
      : { role: m.role, content: m.content || '' }));
}

function findMsg(id) {
  return messages.value.find((m) => m.id === id) || null;
}

/* 推送目标：仅流式发起时所在的会话（中途切换会话不会串台） */
function streamingTarget() {
  if (activeId.value !== streamingConvId) return null;
  const c = activeConversation();
  const m = c && c.messages[c.messages.length - 1];
  return m && m.role === 'assistant' && m.streaming ? m : null;
}

function pushUserAndPlaceholder(conv, userText, attachments) {
  const atts = Array.isArray(attachments) && attachments.length ? attachments : undefined;
  if (conv.title === '新会话') conv.title = (userText || (atts ? '带附件的提问' : '')).slice(0, 20);
  conv.updatedAt = Date.now();
  const userMsg = { id: `m${Date.now()}-${seq++}`, role: 'user', content: userText };
  if (atts) userMsg.attachments = atts;
  const aiMsg = { id: `m${Date.now()}-${seq++}`, role: 'assistant', content: '', streaming: true };
  conv.messages.push(userMsg, aiMsg);
  if (conv.messages.length > MAX_MESSAGES) conv.messages.splice(0, conv.messages.length - MAX_MESSAGES);
  persist();
  return aiMsg;
}

async function send(text, { contextText, attachments } = {}) {
  const body = String(text || '').trim();
  const atts = Array.isArray(attachments) && attachments.length ? attachments : null;
  if ((!body && !atts) || streaming.value || !api()) return;
  const conv = activeConversation() || createConversation();
  const aiMsg = pushUserAndPlaceholder(conv, body, atts);

  streaming.value = true;
  streamingConvId = conv.id;
  currentRequestId = `chat-${Date.now()}-${seq++}`;
  try {
    /* 工具上下文临时拼进本请求的 system 消息（人设提示词由渲染层先行注入，
     * 主进程检测到首条为 system 时不再重复注入配置的系统提示词） */
    const payload = buildApiMessages();
    if (contextText) {
      const persona = config.value.systemPrompt || '你是串口协议管理工具内置的 AI 助手。回答使用简体中文，禁止使用 emoji 表情符号。';
      payload.unshift({ role: 'system', content: `${persona}\n\n# 工具实时上下文（自动生成，回答时以此为准）\n${contextText}` });
    }
    const r = await api().send({ requestId: currentRequestId, messages: payload, model: conv.model || undefined });
    if (!r.success) {
      const m = findMsg(aiMsg.id);
      if (m && !m.content) m.content = '(请求未发出)';
      if (m) { m.errorText = r.error || '未知错误'; m.streaming = false; }
      streaming.value = false;
      persist();
    }
  } catch (e) {
    const m = findMsg(aiMsg.id);
    if (m) { m.streaming = false; m.errorText = String(e.message || e); }
    streaming.value = false;
    persist();
  }
}

/* JSON Mode 单轮生成（如"生成协议定义 JSON"）：非流式，结果整段入气泡并附带结构化数据 */
async function generateJson(desc, systemPrompt) {
  const body = String(desc || '').trim();
  if (!body || streaming.value || !api()) return;
  const conv = activeConversation() || createConversation();
  const aiMsg = pushUserAndPlaceholder(conv, `请根据以下描述生成协议定义 JSON：${body}`);

  streaming.value = true;
  streamingConvId = conv.id;
  try {
    const r = await api().generateJson({ prompt: body, systemPrompt, model: conv.model || undefined });
    const m = findMsg(aiMsg.id);
    if (m) {
      m.streaming = false;
      if (r.success) {
        m.content = '已生成协议定义 JSON（可直接复制使用）：\n```json\n' + JSON.stringify(r.data, null, 2) + '\n```';
        m.jsonData = r.data;
      } else {
        m.content = '(生成失败)';
        m.errorText = r.error || '未知错误';
      }
    }
  } catch (e) {
    const m = findMsg(aiMsg.id);
    if (m) { m.streaming = false; m.content = '(生成失败)'; m.errorText = String(e.message || e); }
  }
  streaming.value = false;
  persist();
}

async function stop() {
  if (!streaming.value) return;
  try { await api()?.abort(); } catch { /* 主进程 ai:done 兜底收尾 */ }
}

/* ---------------- 事件（模块级只挂一次） ---------------- */
function ensureListeners() {
  if (listening) return;
  const a = api();
  if (!a) return;
  listening = true;

  a.onChunk(({ delta }) => {
    const m = streamingTarget();
    if (m) m.content += delta;
  });

  a.onTool(({ name, input, ok } = {}) => {
    const m = streamingTarget();
    if (!m) return;
    if (!Array.isArray(m.toolCalls)) m.toolCalls = [];
    let brief = name || '工具';
    try {
      const args = JSON.stringify(input || {});
      brief = `${name}(${args.length > 48 ? args.slice(0, 48) + '…' : args})`;
    } catch { /* ignore */ }
    m.toolCalls.push({ name, brief, ok: ok !== false });
  });

  a.onDone(({ aborted } = {}) => {
    const m = streamingTarget();
    if (m && m.role === 'assistant' && m.streaming) {
      m.streaming = false;
      if (aborted && !m.content) m.content = '(已停止)';
    }
    streaming.value = false;
    streamingConvId = '';
    persist();
  });

  a.onError(({ error } = {}) => {
    const m = streamingTarget();
    if (m && m.role === 'assistant' && m.streaming) {
      m.streaming = false;
      if (!m.content) m.content = '(请求失败)';
      m.errorText = error || '未知错误';
    }
    streaming.value = false;
    streamingConvId = '';
    persist();
  });
}

export function useAiChat() {
  ensureListeners();
  if (!configLoaded.value) {
    refreshConfig();
    loadSessions();
  }
  return {
    config,
    conversations,
    activeId,
    messages,
    streaming,
    configLoaded,
    refreshConfig,
    createConversation,
    switchConversation,
    deleteConversation,
    renameConversation,
    setActiveModel,
    send,
    generateJson,
    stop,
    clearHistory,
  };
}
