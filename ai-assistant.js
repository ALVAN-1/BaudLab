/* =========================================================================
 * AI 助手（OpenAI 协议兼容大模型客户端，主进程）
 * =========================================================================
 * 职责全部收敛在主进程，渲染层不接触 API Key 明文：
 *   - 配置持久化：data/ai-config.json；API Key 用 safeStorage/DPAPI
 *     本机加密（与"记住密码"同一机制），加密不可用时降级明文并告警
 *   - OpenAI 协议客户端：POST {base}/chat/completions，SSE 流式解析，
 *     增量通过 ai:chunk / ai:done / ai:error 事件推回发起请求的窗口
 *   - 兼容一切 OpenAI 协议服务：OpenAI / DeepSeek / 通义(兼容模式) /
 *     智谱 / Kimi / 本地 Ollama（http://localhost:11434/v1）等
 *
 * Base URL 约定：填到版本号为止（如 https://api.deepseek.com/v1），
 * 主进程自动补 /chat/completions；已带完整路径的原样使用。
 * ========================================================================= */

const path = require('path');
const fs = require('fs');
const electron = require('electron');
const { ipcMain } = electron;
const safeStorage = electron.safeStorage || null;
const { TOOLS, toSchemaList, MAX_RESULT_CHARS } = require('./ai-tools');

const DEFAULT_CONFIG = {
  enabled: false,
  protocol: 'openai', // 'openai' | 'anthropic'
  baseUrl: '',
  model: '',
  apiKeyEnc: '',     // safeStorage 加密后的 base64；keyEncrypted=false 时为明文
  keyEncrypted: true,
  temperature: null, // null = 使用服务端默认值
  maxTokens: 4096,   // Anthropic 协议必填 max_tokens；OpenAI 协议不传
  toolsEnabled: true, // 允许模型调用只读工具（协议库/串口数据/系统日志）
  models: [],         // 使用中的模型列表（设置页从"获取模型列表"添加；对话界面可切换）
  systemPrompt: '你是串口协议管理工具内置的 AI 助手，擅长嵌入式通信协议、串口调试与 hex 数据分析。回答使用简体中文；禁止使用 emoji 表情符号；给出代码时使用代码块并标注语言。',
};

/* 空闲超时：流式请求超过该时长没有任何新数据则视为连接异常，主动中断 */
const IDLE_TIMEOUT_MS = 60000;
/* 测试连接的整体超时 */
const TEST_TIMEOUT_MS = 30000;
/* 工具调用最大轮数（防模型循环调用打转） */
const MAX_TOOL_ROUNDS = 5;

function clipToolResult(s, n = MAX_RESULT_CHARS) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + '…(已截断)' : s;
}

/* ---------------------------------------------------------------------------
 * Base URL 规范化（纯函数，tests/verify-ai.js 覆盖）
 * ------------------------------------------------------------------------- */
function normalizeBaseUrl(raw) {
  let u = String(raw || '').trim();
  if (!u) return { ok: false, error: 'Base URL 不能为空' };
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  u = u.replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(u)) return { ok: true, url: u };
  return { ok: true, url: u + '/chat/completions' };
}

/* Anthropic 协议：POST {base}/v1/messages。
 * 官方 base 是 https://api.anthropic.com（无 /v1）；DeepSeek/智谱/Kimi 等
 * Claude 兼容端点形如 https://api.deepseek.com/anthropic，SDK 会在其后补 /v1/messages，
 * 故无 /v1 结尾时统一补 /v1/messages，已带 /v1 或完整路径的按惯例拼接 */
function normalizeAnthropicUrl(raw) {
  let u = String(raw || '').trim();
  if (!u) return { ok: false, error: 'Base URL 不能为空' };
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  u = u.replace(/\/+$/, '');
  if (/\/messages$/i.test(u)) return { ok: true, url: u };
  if (/\/v1$/i.test(u)) return { ok: true, url: u + '/messages' };
  return { ok: true, url: u + '/v1/messages' };
}

function normalizeEndpointUrl(protocol, raw) {
  return protocol === 'anthropic' ? normalizeAnthropicUrl(raw) : normalizeBaseUrl(raw);
}

/* 模型列表接口：OpenAI 协议 GET {base}/models；Anthropic 协议 GET {base}/v1/models。
 * 用户误粘贴的完整接口路径（/chat/completions、/messages）先剥掉再拼 */
function normalizeModelsUrl(protocol, raw) {
  let u = String(raw || '').trim();
  if (!u) return { ok: false, error: 'Base URL 不能为空' };
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  u = u.replace(/\/+$/, '');
  u = u.replace(/\/(chat\/completions|messages)$/i, '');
  if (protocol === 'anthropic') {
    if (/\/v1$/i.test(u)) return { ok: true, url: u + '/models' };
    return { ok: true, url: u + '/v1/models' };
  }
  return { ok: true, url: u + '/models' };
}

/* ---------------------------------------------------------------------------
 * 流式增量提取（纯函数，tests/verify-ai.js 覆盖）
 * OpenAI：choices[0].delta.content；Anthropic：content_block_delta 事件的 delta.text
 * （thinking_delta / input_json_delta 等非文本块一律忽略）
 * ------------------------------------------------------------------------- */
function createDeltaExtractor(protocol) {
  if (protocol === 'anthropic') {
    return (json) => {
      if (json && json.type === 'content_block_delta' && json.delta
        && json.delta.type === 'text_delta' && typeof json.delta.text === 'string' && json.delta.text) {
        return json.delta.text;
      }
      return null;
    };
  }
  return (json) => {
    const delta = json && json.choices && json.choices[0] && json.choices[0].delta;
    return (delta && typeof delta.content === 'string' && delta.content) ? delta.content : null;
  };
}

/* ---------------------------------------------------------------------------
 * SSE 增量解析（纯函数，tests/verify-ai.js 覆盖）
 * OpenAI 协议每条 data: 自成一行即一个事件，空行/注释行(: ping)直接忽略
 * ------------------------------------------------------------------------- */
function createSseParser() {
  let buf = '';
  return {
    push(chunkText) {
      buf += chunkText;
      const events = [];
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (line.startsWith('data:')) events.push(line.slice(5).trim());
      }
      return events;
    },
  };
}

/* ---------------------------------------------------------------------------
 * 配置读写（dataDir/ai-config.json）
 * ------------------------------------------------------------------------- */
function readConfigFile(configPath) {
  try {
    if (!fs.existsSync(configPath)) return { ...DEFAULT_CONFIG };
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return { ...DEFAULT_CONFIG, ...raw };
  } catch (e) {
    console.warn('[AI] 读取 AI 配置失败:', e.message);
    return { ...DEFAULT_CONFIG };
  }
}

function writeConfigFile(configPath, cfg) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
}

function encryptApiKey(plain) {
  if (safeStorage && safeStorage.isEncryptionAvailable()) {
    return { enc: safeStorage.encryptString(plain).toString('base64'), encrypted: true };
  }
  console.warn('[AI] safeStorage 不可用，API Key 将明文存储在本机配置文件中');
  return { enc: plain, encrypted: false };
}

function decryptApiKey(cfg) {
  if (!cfg || !cfg.apiKeyEnc) return '';
  if (!cfg.keyEncrypted) return String(cfg.apiKeyEnc);
  try {
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) return '';
    return safeStorage.decryptString(Buffer.from(cfg.apiKeyEnc, 'base64'));
  } catch {
    return '';
  }
}

/* ---------------------------------------------------------------------------
 * 请求头构造（纯函数，tests/verify-ai.js 覆盖）
 * Anthropic 官方用 x-api-key；国内中转网关普遍只认 Bearer。
 * ----------------------------------------------------------------------- */
function buildRequestHeaders(protocol, apiKey, authStyle) {
  if (protocol === 'anthropic') {
    const base = { 'anthropic-version': '2023-06-01' };
    if (authStyle === 'bearer') {
      return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, ...base };
    }
    return { 'Content-Type': 'application/json', 'x-api-key': apiKey, ...base };
  }
  return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };
}

/* 带鉴权回退的请求：Anthropic 协议先按官方 x-api-key 发，401/403 时
 * 自动改用 Bearer 重试一次（兼容国内中转网关）；OpenAI 协议恒用 Bearer。
 * 重试成功返回重试响应，仍失败则返回原响应（按官方语义报错） */
async function fetchWithAuthFallback({ url, protocol, apiKey, method = 'POST', body, signal }) {
  const send = (authStyle) => fetch(url, {
    method,
    headers: buildRequestHeaders(protocol, apiKey, authStyle),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const res = await send('api-key');
  if (!res.ok && protocol === 'anthropic' && (res.status === 401 || res.status === 403)) {
    let retry;
    try { retry = await send('bearer'); } catch { return res; }
    if (retry.ok) {
      try { await res.text(); } catch { /* 释放首个响应 */ }
      return retry;
    }
    try { await retry.text(); } catch { /* ignore */ }
  }
  return res;
}

/* ---------------------------------------------------------------------------
 * 错误信息转写：把 HTTP 状态/网络异常转成用户可操作的中文提示
 * ------------------------------------------------------------------------- */
function friendlyChatError(e) {
  const status = e.httpStatus;
  if (status === 401) return 'API Key 无效或未授权 (401)，请检查系统设置中的 Key，以及服务商要求的鉴权方式（中转网关多为 Bearer）';
  if (status === 403) return '无权访问 (403)：Key 可能没有该模型的调用权限' + (e.detail ? `：${e.detail}` : '');
  if (status === 402) return '账户额度不足或已欠费 (402)：请登录服务商控制台确认余额与套餐' + (e.detail ? `：${e.detail}` : '');
  if (status === 404) return '接口不存在 (404)：请检查 Base URL 与接口协议（OpenAI/Anthropic）是否匹配，以及模型名称是否正确' + (e.detail ? `：${e.detail}` : '');
  if (status === 429) return '请求过于频繁或额度不足 (429)' + (e.detail ? `：${e.detail}` : '');
  if (status) return `服务端返回错误 (HTTP ${status})${e.detail ? `：${e.detail}` : ''}`;
  if (e.name === 'TypeError') return '网络请求失败：无法连接到服务，请检查 Base URL、网络或代理设置';
  return String(e.message || e);
}

async function readErrorDetail(res) {
  let text = '';
  try { text = await res.text(); } catch { /* ignore */ }
  try {
    const j = JSON.parse(text);
    return (j.error && (j.error.message || j.error.code)) || j.message || text.slice(0, 200);
  } catch {
    return text.slice(0, 200) || `HTTP ${res.status}`;
  }
}

/* ---------------------------------------------------------------------------
 * 消息入参校验：角色白名单 + 长度上限，防止异常入参打爆请求体。
 * content 支持两种形态：
 *   - 字符串（纯文本）
 *   - OpenAI 多模态数组 [{type:'text'},{type:'image_url',image_url:{url:dataURL}}]，
 *     图片仅接受 data:image/*;base64 URL（Anthropic 格式在请求体构造时转换）
 * （纯函数，tests/verify-ai.js 覆盖）
 * ------------------------------------------------------------------------- */
const MAX_MESSAGE_IMAGES = 6; // 单条消息图片数上限

function sanitizeMessageContent(content, { maxTextLen = 100000, maxImageChars = 6000000 } = {}) {
  if (typeof content === 'string') {
    if (!content.trim()) return { ok: false };
    return { ok: true, content: content.slice(0, maxTextLen) };
  }
  if (!Array.isArray(content)) return { ok: false };
  const parts = [];
  let textBudget = maxTextLen;
  for (const p of content) {
    if (!p || typeof p !== 'object') continue;
    if (p.type === 'text' && typeof p.text === 'string' && p.text.trim()) {
      if (textBudget <= 0) continue;
      const t = p.text.slice(0, textBudget);
      textBudget -= t.length;
      parts.push({ type: 'text', text: t });
    } else if (p.type === 'image_url' && p.image_url && typeof p.image_url.url === 'string') {
      if (parts.length >= MAX_MESSAGE_IMAGES * 2) continue;
      const m = /^data:(image\/(?:png|jpe?g|gif|webp));base64,([A-Za-z0-9+/=]+)$/i.exec(p.image_url.url.trim());
      /* image/jpg 是非标准写法，统一规范为 image/jpeg */
      const mediaType = m ? m[1].toLowerCase().replace('image/jpg', 'image/jpeg') : '';
      if (!mediaType || m[2].length > maxImageChars) continue;
      parts.push({ type: 'image_url', image_url: { url: `data:${mediaType};base64,${m[2]}` } });
    }
  }
  if (!parts.length) return { ok: false };
  return { ok: true, content: parts };
}

function sanitizeMessages(input) {
  if (!Array.isArray(input)) return { ok: false, error: '消息格式错误' };
  const ROLE = new Set(['system', 'user', 'assistant']);
  const messages = [];
  for (const m of input.slice(-40)) {
    if (!m || !ROLE.has(m.role)) continue;
    const c = sanitizeMessageContent(m.content);
    if (!c.ok) continue;
    messages.push({ role: m.role, content: c.content });
  }
  if (!messages.length) return { ok: false, error: '消息内容为空' };
  return { ok: true, messages };
}

/* ---------------------------------------------------------------------------
 * OpenAI 多模态 content → Anthropic content 块（image_url dataURL → base64 source）。
 * 仅当数组里含 image_url 时才转换；工具调用轮次追加的原生 Anthropic 块
 * （tool_use / tool_result）不含 image_url，原样透传（纯函数，tests/verify-ai.js 覆盖）
 * ------------------------------------------------------------------------- */
function toAnthropicContent(content) {
  if (typeof content === 'string' || !Array.isArray(content)) return content;
  if (!content.some((p) => p && p.type === 'image_url')) return content;
  const blocks = [];
  for (const p of content) {
    if (!p || typeof p !== 'object') continue;
    if (p.type === 'text' && typeof p.text === 'string' && p.text) {
      blocks.push({ type: 'text', text: p.text });
    } else if (p.type === 'image_url' && p.image_url && typeof p.image_url.url === 'string') {
      const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/i.exec(p.image_url.url.trim());
      if (m) blocks.push({ type: 'image', source: { type: 'base64', media_type: m[1].toLowerCase(), data: m[2] } });
    }
  }
  return blocks.length ? blocks : [{ type: 'text', text: '(包含不支持的图片格式)' }];
}

/* ---------------------------------------------------------------------------
 * IPC 注册
 * ------------------------------------------------------------------------- */
function registerAiIpc({ dataDir, log, queryDatabase, app } = {}) {
  const configPath = path.join(dataDir, 'ai-config.json');
  /* requestId -> { controller, userAborted }：进行中的流式请求 */
  const activeRequests = new Map();

  const say = (level, message) => {
    try { log && log(level, message); } catch { /* 日志失败不影响对话 */ }
  };

  function readConfig() { return readConfigFile(configPath); }

  function updateConfig(patch) {
    const cur = readConfig();
    const next = { ...cur };
    if ('enabled' in patch) next.enabled = !!patch.enabled;
    if ('protocol' in patch) next.protocol = patch.protocol === 'anthropic' ? 'anthropic' : 'openai';
    if ('toolsEnabled' in patch) next.toolsEnabled = !!patch.toolsEnabled;
    if ('models' in patch) {
      const arr = Array.isArray(patch.models) ? patch.models : [];
      next.models = [...new Set(arr
        .map((m) => String(m || '').trim().slice(0, 120))
        .filter(Boolean))].slice(0, 30);
    }
    if ('baseUrl' in patch) next.baseUrl = String(patch.baseUrl || '').trim();
    if ('model' in patch) next.model = String(patch.model || '').trim();
    if ('systemPrompt' in patch) next.systemPrompt = String(patch.systemPrompt || '');
    if ('maxTokens' in patch) {
      const n = Number(patch.maxTokens);
      next.maxTokens = (Number.isFinite(n) && n > 0) ? Math.min(65536, Math.floor(n)) : DEFAULT_CONFIG.maxTokens;
    }
    if ('temperature' in patch) {
      const t = Number(patch.temperature);
      next.temperature = (patch.temperature === null || patch.temperature === '' || Number.isNaN(t))
        ? null : Math.min(2, Math.max(0, t));
    }
    if (patch.clearKey) {
      next.apiKeyEnc = '';
    } else if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) {
      const { enc, encrypted } = encryptApiKey(patch.apiKey.trim());
      next.apiKeyEnc = enc;
      next.keyEncrypted = encrypted;
    }
    writeConfigFile(configPath, next);
    return next;
  }

  /* 统一取回请求体公共字段；配置不完整时返回 { error } */
  function resolveEndpoint(cfg) {
    if (!cfg.baseUrl || !cfg.model) return { error: '请先在系统设置中配置 Base URL 和模型名称' };
    const ep = normalizeEndpointUrl(cfg.protocol, cfg.baseUrl);
    if (!ep.ok) return { error: ep.error };
    return { url: ep.url };
  }

  function buildBody(cfg, messages, stream) {
    const body = { model: cfg.model, messages, stream };
    if (cfg.temperature !== null && cfg.temperature !== undefined) body.temperature = cfg.temperature;
    return body;
  }

  /* Anthropic Messages API 请求体：system 是顶层字段而非消息角色；
   * max_tokens 必填；渲染层消息以 system 开头时以其为准，否则用配置的系统提示词。
   * 多模态 content（OpenAI 形态的 image_url）在此统一转为 Anthropic 图片块 */
  function buildAnthropicBody(cfg, messages, stream) {
    let system = cfg.systemPrompt || '';
    let chat = messages;
    if (chat.length && chat[0].role === 'system') {
      const c = chat[0].content;
      if (typeof c === 'string') system = c;
      else if (Array.isArray(c)) {
        system = c.filter((p) => p && p.type === 'text').map((p) => p.text).join('\n');
      }
      chat = chat.slice(1);
    }
    chat = chat.filter((m) => m.role !== 'system');
    const body = {
      model: cfg.model,
      max_tokens: cfg.maxTokens || DEFAULT_CONFIG.maxTokens,
      stream,
      messages: chat.map((m) => ({ role: m.role, content: toAnthropicContent(m.content) })),
    };
    if (system) body.system = system;
    if (cfg.temperature !== null && cfg.temperature !== undefined) body.temperature = cfg.temperature;
    return body;
  }

  /* 单轮模型请求：返回 { content, toolCalls, finishReason }。
   * toolCalls: [{ id, name, input, rawArgs }]，input 解析失败时为 null。
   * extraBody 用于 JSON Mode 等请求体扩展（response_format 等） */
  async function runModelRound({ cfg, apiKey, messages, tools, stream, signal, onDelta, extraBody }) {
    const protocol = cfg.protocol === 'anthropic' ? 'anthropic' : 'openai';
    const ep = resolveEndpoint(cfg);
    if (ep.error) throw new Error(ep.error);
    const body = protocol === 'anthropic' ? buildAnthropicBody(cfg, messages, stream) : buildBody(cfg, messages, stream);
    if (tools && tools.length) {
      body.tools = buildToolSchemas(protocol, tools);
      if (protocol !== 'anthropic') body.tool_choice = 'auto';
    }
    if (extraBody) Object.assign(body, extraBody);
    const res = await fetchWithAuthFallback({ url: ep.url, protocol, apiKey, body, signal });
    if (!res.ok) {
      const err = new Error('model request failed');
      err.httpStatus = res.status;
      err.detail = await readErrorDetail(res);
      throw err;
    }

    const contentType = res.headers.get('content-type') || '';
    if (stream && res.body && typeof res.body.getReader === 'function' && contentType.includes('text/event-stream')) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parser = createSseParser();
      const extract = createDeltaExtractor(protocol);
      const acc = createToolCallAccumulator(protocol);
      let content = '';
      let finishReason = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const data of parser.push(decoder.decode(value, { stream: true }))) {
          if (!data || data === '[DONE]') continue;
          let json;
          try { json = JSON.parse(data); } catch { continue; }
          /* Anthropic 以 error 事件承载流中错误（如 overloaded） */
          if (protocol === 'anthropic' && json.type === 'error') {
            const err = new Error((json.error && json.error.message) || '服务端返回错误事件');
            err.httpStatus = res.status;
            err.detail = json.error && json.error.type;
            throw err;
          }
          if (protocol === 'anthropic') {
            if (json.type === 'content_block_start') acc.startBlock(json.index, json.content_block);
            else if (json.type === 'content_block_delta') {
              const d = json.delta || {};
              if (d.type === 'text_delta' && d.text) {
                content += d.text;
                if (onDelta) onDelta(d.text);
              } else if (d.type === 'input_json_delta') {
                acc.appendArgs(json.index, d.partial_json);
              }
            } else if (json.type === 'message_delta' && json.delta && json.delta.stop_reason) {
              finishReason = json.delta.stop_reason;
            }
          } else {
            const choice = json.choices && json.choices[0];
            if (!choice) continue;
            const delta = choice.delta || {};
            if (typeof delta.content === 'string' && delta.content) {
              content += delta.content;
              if (onDelta) onDelta(delta.content);
            }
            if (Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                acc.mergeDelta(typeof tc.index === 'number' ? tc.index : 0, {
                  id: tc.id,
                  name: tc.function && tc.function.name,
                  argsDelta: tc.function && typeof tc.function.arguments === 'string' ? tc.function.arguments : '',
                });
              }
            }
            if (choice.finish_reason) finishReason = choice.finish_reason;
          }
        }
      }
      return { content, toolCalls: acc.list(), finishReason: finishReason || 'stop' };
    }

    /* 服务端不支持流式（或返回普通 JSON）：整包解析 */
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch {
      throw new Error('服务端返回了无法解析的响应：' + text.slice(0, 200));
    }
    if (protocol === 'anthropic' && json.type === 'error') {
      const err = new Error((json.error && json.error.message) || '服务端返回错误');
      err.httpStatus = res.status;
      throw err;
    }
    let content = '';
    let toolCalls = [];
    let finishReason = 'stop';
    if (protocol === 'anthropic') {
      const blocks = Array.isArray(json.content) ? json.content : [];
      content = blocks.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('');
      for (const b of blocks) {
        if (b && b.type === 'tool_use') {
          toolCalls.push({ id: b.id || '', name: b.name || '', input: (b.input && typeof b.input === 'object') ? b.input : null, rawArgs: '' });
        }
      }
      finishReason = json.stop_reason || 'stop';
    } else {
      const choice = (json.choices && json.choices[0]) || {};
      const msg = choice.message || {};
      content = msg.content || '';
      for (const tc of (Array.isArray(msg.tool_calls) ? msg.tool_calls : [])) {
        const raw = tc.function && typeof tc.function.arguments === 'string' ? tc.function.arguments : '';
        toolCalls.push({
          id: tc.id || `call_${tc.function && tc.function.name}`,
          name: (tc.function && tc.function.name) || '',
          input: safeParseJson(raw),
          rawArgs: raw,
        });
      }
      finishReason = choice.finish_reason || 'stop';
    }
    if (content && onDelta) onDelta(content);
    return { content, toolCalls, finishReason };
  }

  /* 执行单个工具调用：异常一律转为错误文本回传给模型（不中断对话） */
  async function executeToolCall(tc) {
    const tool = tc && TOOLS[tc.name];
    if (!tool) return { ok: false, result: `未知工具: ${tc && tc.name}` };
    if (tc.input === null) return { ok: false, result: `参数不是合法 JSON: ${String(tc.rawArgs || '').slice(0, 200)}` };
    try {
      const out = await tool.execute(tc.input || {}, { query: queryDatabase, app });
      return { ok: true, result: clipToolResult(typeof out === 'string' ? out : JSON.stringify(out, null, 1)) };
    } catch (e) {
      return { ok: false, result: `工具执行失败: ${String(e.message || e)}` };
    }
  }

  /* 流式对话主流程（含工具调用多轮循环）：增量经事件推送（ai:chunk /
   * ai:tool / ai:done / ai:error）。模型请求工具调用时本地执行后回填续问，
   * 最多 MAX_TOOL_ROUNDS 轮；服务端不支持 tools（400）时自动降级为纯对话 */
  async function runConversation({ cfg, apiKey, messages, signal, sender, requestId, entry, useTools }) {
    const protocol = cfg.protocol === 'anthropic' ? 'anthropic' : 'openai';
    const startedAt = Date.now();
    let idleTimer = null;
    let timedOut = false;
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timedOut = true;
        try { entry.controller.abort(); } catch { /* ignore */ }
      }, IDLE_TIMEOUT_MS);
    };
    const push = (event, payload) => {
      if (!sender.isDestroyed()) sender.send(event, { requestId, ...payload });
    };
    resetIdle();
    try {
      let convo = messages;
      let tools = useTools ? toSchemaList() : [];
      let toolsDisabled = false; // 服务端不支持 tools 后本轮对话不再携带

      for (let round = 1; round <= MAX_TOOL_ROUNDS; round++) {
        let r;
        try {
          r = await runModelRound({
            cfg, apiKey, messages: convo, tools, stream: true, signal,
            onDelta: (delta) => {
              resetIdle();
              push('ai:chunk', { delta });
            },
          });
        } catch (e) {
          /* 服务端不认识 tools 参数：去掉工具重试一次 */
          if (tools.length && !toolsDisabled && e.httpStatus === 400) {
            toolsDisabled = true;
            tools = [];
            say('warn', `服务端不支持工具调用（400），已降级为纯对话：${String(e.detail || e.message || '').slice(0, 120)}`);
            round--; // 重试本轮
            continue;
          }
          throw e;
        }
        resetIdle();

        /* 无工具调用（或已到轮数上限）：本轮输出即最终回答 */
        if (!r.toolCalls.length || round === MAX_TOOL_ROUNDS) break;

        /* 把 assistant 的工具调用请求追加进上下文（按协议格式） */
        if (protocol === 'anthropic') {
          const content = [];
          if (r.content) content.push({ type: 'text', text: r.content });
          for (const tc of r.toolCalls) {
            content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input || {} });
          }
          convo = [...convo, { role: 'assistant', content }];
        } else {
          convo = [...convo, {
            role: 'assistant',
            content: r.content || null,
            tool_calls: r.toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: tc.input === null ? String(tc.rawArgs || '{}') : JSON.stringify(tc.input) },
            })),
          }];
        }

        /* 本地执行工具并回填结果 */
        const toolResults = [];
        for (const tc of r.toolCalls) {
          const { ok, result } = await executeToolCall(tc);
          push('ai:tool', { name: tc.name, input: tc.input, ok, brief: clipToolResult(result, 160) });
          say('info', `AI 工具调用 ${tc.name}(${JSON.stringify(tc.input || {}).slice(0, 120)}) → ${ok ? '成功' : '失败'}`);
          if (protocol === 'anthropic') {
            toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content: result });
          } else {
            convo = [...convo, { role: 'tool', tool_call_id: tc.id, content: result }];
          }
        }
        if (protocol === 'anthropic') {
          convo = [...convo, { role: 'user', content: toolResults }];
        }
      }

      push('ai:done', { elapsedMs: Date.now() - startedAt });
      say('info', `AI 对话完成（${Date.now() - startedAt}ms，模型 ${cfg.model}）`);
    } catch (e) {
      if (!sender.isDestroyed()) {
        if (entry.userAborted) {
          push('ai:done', { aborted: true });
        } else if (timedOut || e.name === 'AbortError') {
          push('ai:error', { error: timedOut ? `响应超时：${IDLE_TIMEOUT_MS / 1000} 秒内没有收到新数据` : '请求被中断' });
        } else {
          push('ai:error', { error: friendlyChatError(e) });
        }
      }
      say('warn', `AI 对话失败：${entry.userAborted ? '用户中止' : String(e.message || e)}`);
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      activeRequests.delete(requestId);
    }
  }

  /* -------------------------- IPC handlers -------------------------- */

  ipcMain.handle('ai:get-config', () => {
    const cfg = readConfig();
    return {
      success: true,
      enabled: !!cfg.enabled,
      protocol: cfg.protocol === 'anthropic' ? 'anthropic' : 'openai',
      toolsEnabled: cfg.toolsEnabled !== false,
      models: Array.isArray(cfg.models) ? cfg.models : [],
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      systemPrompt: cfg.systemPrompt,
      temperature: cfg.temperature,
      hasKey: !!cfg.apiKeyEnc,
      keyEncrypted: !!cfg.keyEncrypted,
      encryptionAvailable: !!(safeStorage && safeStorage.isEncryptionAvailable()),
    };
  });

  ipcMain.handle('ai:set-config', (_e, patch) => {
    try {
      const next = updateConfig(patch || {});
      return {
        success: true,
        hasKey: !!next.apiKeyEnc,
        keyEncrypted: !!next.keyEncrypted,
        encryptionAvailable: !!(safeStorage && safeStorage.isEncryptionAvailable()),
      };
    } catch (e) {
      return { success: false, error: String(e.message || e) };
    }
  });

  /* 连通性测试：非流式最小请求，30s 超时 */
  ipcMain.handle('ai:test', async () => {
    const cfg = readConfig();
    const apiKey = decryptApiKey(cfg);
    if (!cfg.baseUrl || !cfg.model) return { success: false, error: '请先填写 Base URL 和模型名称并保存' };
    if (!apiKey) return { success: false, error: '请先填写 API Key 并保存' };
    const ep = resolveEndpoint(cfg);
    if (ep.error) return { success: false, error: ep.error };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
    const startedAt = Date.now();
    try {
      const r = await runModelRound({
        cfg, apiKey,
        messages: [{ role: 'user', content: 'ping' }],
        stream: false, signal: controller.signal,
      });
      return {
        success: true,
        model: cfg.model,
        reply: String(r.content || '(空回复)').slice(0, 120),
        latencyMs: Date.now() - startedAt,
      };
    } catch (e) {
      if (e.name === 'AbortError') return { success: false, error: `连接超时（${TEST_TIMEOUT_MS / 1000} 秒），请检查网络或地址` };
      return { success: false, error: friendlyChatError(e) };
    } finally {
      clearTimeout(timer);
    }
  });

  /* 拉取服务商可用模型列表（OpenAI: GET /models；Anthropic: GET /v1/models） */
  ipcMain.handle('ai:list-models', async () => {
    const cfg = readConfig();
    const protocol = cfg.protocol === 'anthropic' ? 'anthropic' : 'openai';
    const apiKey = decryptApiKey(cfg);
    if (!cfg.baseUrl) return { success: false, error: '请先填写并保存 Base URL' };
    if (!apiKey) return { success: false, error: '请先填写并保存 API Key' };
    const ep = normalizeModelsUrl(protocol, cfg.baseUrl);
    if (!ep.ok) return { success: false, error: ep.error };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetchWithAuthFallback({ url: ep.url, protocol, apiKey, method: 'GET', signal: controller.signal });
      if (!res.ok) {
        const err = new Error('list models failed');
        err.httpStatus = res.status;
        err.detail = await readErrorDetail(res);
        throw err;
      }
      const json = await res.json();
      const arr = Array.isArray(json && json.data) ? json.data : (Array.isArray(json && json.models) ? json.models : []);
      const models = [...new Set(arr
        .map((m) => (typeof m === 'string' ? m : m && m.id))
        .filter((id) => typeof id === 'string' && id))]
        .sort((a, b) => a.localeCompare(b));
      return { success: true, models };
    } catch (e) {
      if (e.name === 'AbortError') return { success: false, error: '获取超时（20 秒），请检查网络或地址' };
      return { success: false, error: friendlyChatError(e) };
    } finally {
      clearTimeout(timer);
    }
  });

  /* JSON Mode：强制模型输出 JSON，本地解析校验后返回结构化数据。
   * OpenAI 协议带 response_format: json_object；Anthropic 协议无此参数，
   * 依赖提示词约束（systemPrompt 中描述结构） */
  ipcMain.handle('ai:generate-json', async (_e, { prompt, systemPrompt, model } = {}) => {
    const cfg0 = readConfig();
    const cfg = (model && typeof model === 'string' && model.trim())
      ? { ...cfg0, model: model.trim().slice(0, 120) }
      : cfg0;
    const protocol = cfg.protocol === 'anthropic' ? 'anthropic' : 'openai';
    const apiKey = decryptApiKey(cfg);
    const body = String(prompt || '').trim();
    if (!body) return { success: false, error: '内容为空' };
    if (!cfg.baseUrl || !cfg.model) return { success: false, error: '请先在系统设置中配置 Base URL 和模型名称' };
    if (!apiKey) return { success: false, error: '未配置 API Key，请先在系统设置中配置' };

    const messages = [];
    const sys = String(systemPrompt || '').trim();
    if (sys) messages.push({ role: 'system', content: sys });
    messages.push({ role: 'user', content: body });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      const r = await runModelRound({
        cfg, apiKey, messages, stream: false, signal: controller.signal,
        extraBody: protocol === 'openai' ? { response_format: { type: 'json_object' } } : undefined,
      });
      if (r.finishReason === 'length') return { success: false, error: '输出被截断（超出最大 token），请缩短描述后重试' };
      const data = safeParseJson(extractJsonCandidate(r.content));
      if (data === null || typeof data !== 'object' || Array.isArray(data)) {
        return { success: false, error: `模型未返回合法 JSON：${String(r.content || '').slice(0, 200)}` };
      }
      return { success: true, data };
    } catch (e) {
      if (e.name === 'AbortError') return { success: false, error: '生成超时（60 秒），请缩短描述后重试' };
      return { success: false, error: friendlyChatError(e) };
    } finally {
      clearTimeout(timer);
    }
  });

  /* 发起流式对话：invoke 立即返回 requestId，增量经事件推送回发起窗口。
   * model：会话级模型覆盖（对话界面切换模型后随请求传入） */
  ipcMain.handle('ai:send', (event, { requestId, messages, useTools, model } = {}) => {
    const cfg = readConfig();
    if (!cfg.enabled) return { success: false, error: 'AI 助手未启用，请先在系统设置中开启' };
    const apiKey = decryptApiKey(cfg);
    if (!apiKey) return { success: false, error: '未配置 API Key，请先在系统设置中配置' };
    const ep = resolveEndpoint(cfg);
    if (ep.error) return { success: false, error: ep.error };
    const clean = sanitizeMessages(messages);
    if (!clean.ok) return { success: false, error: clean.error };

    const id = String(requestId || `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    /* 同一窗口同时只允许一个流式请求：新请求静默终止旧的 */
    for (const [oldId, old] of activeRequests) {
      if (oldId !== id) {
        old.userAborted = true;
        try { old.controller.abort(); } catch { /* ignore */ }
        activeRequests.delete(oldId);
      }
    }

    const entry = { controller: new AbortController(), userAborted: false };
    activeRequests.set(id, entry);

    /* 主进程统一注入系统提示词（渲染层消息以 system 开头时尊重渲染层） */
    const outbound = clean.messages[0] && clean.messages[0].role === 'system'
      ? clean.messages
      : (cfg.systemPrompt ? [{ role: 'system', content: cfg.systemPrompt }, ...clean.messages] : clean.messages);

    const allowTools = cfg.toolsEnabled !== false && useTools !== false && typeof queryDatabase === 'function';
    const reqCfg = (model && typeof model === 'string' && model.trim())
      ? { ...cfg, model: model.trim().slice(0, 120) }
      : cfg;
    runConversation({
      cfg: reqCfg, apiKey, messages: outbound, signal: entry.controller.signal,
      sender: event.sender, requestId: id, entry, useTools: allowTools,
    }).catch((e) => {
      /* streamChat 内部已兜底，此处仅防御性记录 */
      console.warn('[AI] streamChat 未捕获异常:', e);
    });
    return { success: true, requestId: id };
  });

  /* 中止当前进行中的请求（渲染层"停止"按钮） */
  ipcMain.handle('ai:abort', () => {
    let n = 0;
    for (const [, entry] of activeRequests) {
      entry.userAborted = true;
      try { entry.controller.abort(); n++; } catch { /* ignore */ }
    }
    return { success: true, aborted: n };
  });
}

/* ---------------------------------------------------------------------------
 * 工具调用累积器（纯函数，tests/verify-ai.js 覆盖）
 * 流式响应中工具调用参数是分片到达的：OpenAI 按 index 合并 delta.tool_calls，
 * Anthropic 按 content_block 收集 input_json_delta。统一产出一个可执行的
 * 调用列表 [{ id, name, input, rawArgs }]，input 解析失败时为 null。
 * ------------------------------------------------------------------------- */
function safeParseJson(s) {
  try { return s ? JSON.parse(s) : {}; } catch { return null; }
}

function createToolCallAccumulator(protocol) {
  if (protocol === 'anthropic') {
    const blocks = new Map(); // content_block index -> { id, name, json }
    return {
      startBlock(index, block) {
        if (block && block.type === 'tool_use') {
          blocks.set(index, { id: block.id || '', name: block.name || '', json: '' });
        }
      },
      appendArgs(index, partial) {
        const b = blocks.get(index);
        if (b && typeof partial === 'string') b.json += partial;
      },
      list() {
        return [...blocks.values()].map((b) => ({
          id: b.id, name: b.name, input: safeParseJson(b.json), rawArgs: b.json,
        }));
      },
    };
  }
  const slots = new Map(); // tool_calls index -> { id, name, args }
  return {
    mergeDelta(index, patch) {
      let s = slots.get(index);
      if (!s) { s = { id: '', name: '', args: '' }; slots.set(index, s); }
      if (patch && patch.id) s.id = patch.id;
      if (patch && patch.name) s.name += patch.name;
      if (patch && patch.argsDelta) s.args += patch.argsDelta;
    },
    list() {
      return [...slots.values()].map((s) => ({
        id: s.id || `call_${s.name}`,
        name: s.name,
        input: safeParseJson(s.args),
        rawArgs: s.args,
      }));
    },
  };
}

/* 工具声明 → 各协议请求格式 */
function buildToolSchemas(protocol, defs = toSchemaList()) {
  if (protocol === 'anthropic') {
    return defs.map((d) => ({ name: d.name, description: d.description, input_schema: d.parameters }));
  }
  return defs.map((d) => ({ type: 'function', function: { name: d.name, description: d.description, parameters: d.parameters } }));
}

/* 从模型输出中提取 JSON 主体（容忍 markdown 代码块/前后杂文字） */
function extractJsonCandidate(text) {
  const s = String(text || '').trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  return a >= 0 && b > a ? s.slice(a, b + 1) : s;
}

module.exports = { registerAiIpc, normalizeBaseUrl, normalizeAnthropicUrl, normalizeModelsUrl, buildRequestHeaders, createSseParser, createDeltaExtractor, createToolCallAccumulator, buildToolSchemas, extractJsonCandidate, sanitizeMessages, sanitizeMessageContent, toAnthropicContent, DEFAULT_CONFIG };
