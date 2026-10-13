<template>
  <div class="view-pad ai-chat-view">
    <div class="ai-header">
      <h2>AI 助手</h2>
      <div class="ai-header-meta">
        <div class="ai-model-switch" ref="modelSwitchRef">
          <button type="button" class="ai-model-chip" :class="{ off: !currentModel }" @click="modelMenuOpen = !modelMenuOpen">
            {{ currentModel || '选择模型' }}
            <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#i-chevron-down"/></svg>
          </button>
          <div v-if="modelMenuOpen" class="ai-model-pop">
            <button
              v-for="m in modelOptions"
              :key="m"
              type="button"
              class="ai-pop-item"
              :class="{ on: m === currentModel }"
              @click="chooseModel(m)"
            >
              <span class="ai-pop-name">{{ m }}</span>
              <svg v-if="m === currentModel" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#i-check"/></svg>
            </button>
            <div v-if="!modelOptions.length" class="ai-pop-empty">尚未添加模型</div>
            <button type="button" class="ai-pop-manage" @click="goSettings">管理模型（前往设置）</button>
          </div>
        </div>
        <button class="ai-tool-btn" :disabled="!messages.length || streaming" @click="clearHistory">清空会话</button>
        <button class="ai-tool-btn" @click="goSettings">前往配置</button>
      </div>
    </div>

    <!-- 未配置引导 -->
    <div v-if="!configOk" class="panel ai-guide">
      <div class="panel-body">
        <p class="ai-guide-title">尚未启用 AI 助手</p>
        <p class="ai-guide-text">
          在「系统设置 → AI 助手」中开启并填入任意 OpenAI 协议兼容服务的
          Base URL、API Key 和模型名称即可使用（OpenAI / DeepSeek / 通义 / 智谱 / Kimi /
          本地 Ollama 均可）。涉密数据建议使用本地模型。
        </p>
        <button class="ai-primary-btn" @click="goSettings">前往系统设置</button>
      </div>
    </div>

    <!-- 对话区：会话侧栏 + 聊天面板 -->
    <div v-else class="ai-layout">
      <aside class="panel ai-sessions">
        <div class="ai-sessions-head">
          <span class="ai-sessions-title">会话</span>
          <button class="ai-icon-btn" title="新建会话" @click="newConversation">
            <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><use href="#i-plus"/></svg>
          </button>
        </div>
        <div class="ai-sessions-list">
          <div
            v-for="c in conversations"
            :key="c.id"
            class="ai-session-item"
            :class="{ active: c.id === activeId }"
            @click="switchConversation(c.id)"
          >
            <template v-if="editingId === c.id">
              <input
                v-model="editTitle"
                class="input ai-rename-input"
                @click.stop
                @keydown.enter="commitRename(c.id)"
                @keydown.esc="editingId = ''"
                @blur="commitRename(c.id)"
              />
            </template>
            <template v-else>
              <span class="ai-session-title" :title="c.title">{{ c.title }}</span>
              <span class="ai-session-actions" @click.stop>
                <button class="ai-icon-btn" title="重命名" @click="startRename(c)">
                  <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#i-pencil"/></svg>
                </button>
                <button class="ai-icon-btn danger" title="删除会话" @click="removeConversation(c.id)">
                  <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#i-trash"/></svg>
                </button>
              </span>
            </template>
          </div>
        </div>
      </aside>

      <div class="panel ai-chat-panel" :class="{ 'ai-drag-over': dragOver }"
        @dragover.prevent="onDragOver" @dragenter.prevent="onDragEnter"
        @dragleave.prevent="onDragLeave" @drop.prevent="onDrop">
      <div class="ai-messages" ref="listRef" @click="onContentClick">
        <div v-if="!messages.length" class="ai-empty">
          <p>向 AI 描述你的任务，或试试下面的快捷指令：</p>
          <div class="ai-quick">
            <button v-for="q in quickPrompts" :key="q.label" class="ai-chip" @click="draft = q.text" :disabled="streaming">
              {{ q.label }}
            </button>
          </div>
        </div>

        <div v-for="m in messages" :key="m.id" class="ai-msg" :class="m.role">
          <div class="ai-bubble">
            <template v-if="m.role === 'user'">
              <div v-if="m.attachments && m.attachments.length" class="ai-att-row">
                <template v-for="(a, ai) in m.attachments" :key="ai">
                  <img v-if="a.type === 'image' && a.dataUrl" :src="a.dataUrl" class="ai-att-thumb" title="点击查看大图" @click.stop="previewUrl = a.dataUrl" />
                  <span v-else-if="a.type === 'image'" class="ai-att-file-chip" title="图片数据未保留">🖼 {{ a.name }}</span>
                  <span v-else class="ai-att-file-chip" :title="`文本附件 ${a.name}`">
                    <svg width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#i-file-text"/></svg>
                    {{ a.name }}
                  </span>
                </template>
              </div>
              <span v-if="m.content" class="ai-user-text">{{ m.content }}</span>
            </template>
            <template v-else>
              <div v-if="m.toolCalls && m.toolCalls.length" class="ai-tools">
                <span v-for="(t, ti) in m.toolCalls" :key="ti" class="ai-tool-chip" :class="{ err: !t.ok }" :title="t.brief">
                  <svg width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#i-parse"/></svg>
                  {{ t.brief }}
                </span>
              </div>
              <div class="ai-ai-text" v-html="renderMarkdown(m.content)"></div>
              <span v-if="m.streaming && !m.content && !(m.toolCalls && m.toolCalls.length)" class="ai-thinking">
                <span class="ai-dot"></span><span class="ai-dot"></span><span class="ai-dot"></span>思考中
              </span>
              <span v-else-if="m.streaming" class="ai-caret">▍</span>
              <button v-if="m.jsonData" class="ai-copy-btn" @click="copyJson(m)">{{ copiedId === m.id ? '已复制' : '复制 JSON' }}</button>
              <div v-if="m.errorText" class="ai-error">
                <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" class="ai-error-icon"><use href="#i-alert-circle"/></svg>
                <span>{{ m.errorText }}</span>
              </div>
            </template>
          </div>
        </div>
      </div>

      <div class="ai-input-area">
        <div class="ai-ctx-row">
          <button type="button" class="ai-ctx-chip" :class="{ on: ctxProtocols }" @click="toggleCtx('protocols')">
            <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#i-layers"/></svg>
            协议库
          </button>
          <button type="button" class="ai-ctx-chip" :class="{ on: ctxSerial }" @click="toggleCtx('serial')">
            <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><use href="#i-serial"/></svg>
            最近串口数据
          </button>
          <span v-if="contextBuilding" class="ai-ctx-building">正在读取工具数据…</span>
          <span v-else class="ai-ctx-tip">开启后提问自动附带工具内最新数据</span>
        </div>
        <!-- 附件异常提示 -->
        <div v-if="attachError" class="ai-attach-error">
          <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><use href="#i-alert-circle"/></svg>
          {{ attachError }}
        </div>
        <!-- 待发送附件预览 -->
        <div v-if="attachments.length" class="ai-att-strip">
          <div v-for="(a, i) in attachments" :key="a.id" class="ai-att-item" :title="a.type === 'image' ? a.name : `${a.name}（${formatSize(a.size)}）`">
            <img v-if="a.type === 'image'" :src="a.dataUrl" class="ai-att-item-thumb" />
            <svg v-else width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="ai-att-item-icon"><use href="#i-file-text"/></svg>
            <span class="ai-att-item-name">{{ a.name }}</span>
            <button type="button" class="ai-att-remove" title="移除附件" @click="removeAttachment(i)">
              <svg width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><use href="#i-close"/></svg>
            </button>
          </div>
        </div>
        <textarea
          ref="inputRef"
          v-model="draft"
          class="ai-input"
          rows="3"
          :placeholder="streaming ? 'AI 正在回复…' : (attachments.length ? '补充提问（可留空直接发送附件），Enter 发送' : '输入问题，Enter 发送，Shift+Enter 换行，可粘贴/拖入图片')"
          :disabled="streaming"
          @keydown.enter="onEnter"
          @paste="onPaste"
        ></textarea>
        <div class="ai-input-actions">
          <div class="ai-input-left">
            <button type="button" class="ai-attach-btn" title="添加图片（png/jpg/gif/webp，自动压缩）" :disabled="streaming" @click="imageInputRef && imageInputRef.click()">
              <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#i-image"/></svg>
              图片
            </button>
            <button type="button" class="ai-attach-btn" title="添加文本文件（代码/日志/配置等，内容将随提问发送）" :disabled="streaming" @click="fileInputRef && fileInputRef.click()">
              <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#i-file-text"/></svg>
              文件
            </button>
            <span class="ai-privacy-hint">对话内容、附件与粘贴的数据将发送到你配置的模型服务商</span>
          </div>
          <button v-if="streaming" class="ai-stop-btn" @click="stop">
            <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><use href="#i-pause"/></svg>
            停止
          </button>
          <button v-else class="ai-send-btn" :disabled="(!draft.trim() && !attachments.length)" @click="doSend">
            <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#i-send"/></svg>
            发送
          </button>
        </div>
        <input ref="imageInputRef" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple class="ai-file-input" @change="onPickImages" />
        <input ref="fileInputRef" type="file" :accept="TEXT_ACCEPT" multiple class="ai-file-input" @change="onPickTextFiles" />
      </div>
      </div>
    </div>

    <!-- 图片灯箱 -->
    <div v-if="previewUrl" class="ai-lightbox" @click="previewUrl = ''">
      <img :src="previewUrl" alt="图片预览" />
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { useAiChat } from '../composables/useAiChat';
import { buildProtocolContextText, buildSerialContextText, PROTOCOL_JSON_PROMPT } from '../composables/useToolContext';
import { renderMarkdown } from '../utils/aiMarkdown';

const props = defineProps({
  /* 视图用 v-show 切换不会重新挂载，激活时刷新配置（设置页保存后回到这里即生效） */
  active: { type: Boolean, default: false },
});

const {
  config, conversations, activeId, messages, streaming,
  createConversation, switchConversation, deleteConversation, renameConversation, setActiveModel,
  send, generateJson, stop, clearHistory, refreshConfig,
} = useAiChat();

const draft = ref('');
const listRef = ref(null);
const inputRef = ref(null);
const copiedId = ref('');

/* 会话重命名 */
const editingId = ref('');
const editTitle = ref('');
function startRename(c) {
  editingId.value = c.id;
  editTitle.value = c.title;
}
function commitRename(id) {
  if (editingId.value !== id) return;
  renameConversation(id, editTitle.value);
  editingId.value = '';
}
function newConversation() {
  createConversation();
  editingId.value = '';
}
function removeConversation(id) {
  deleteConversation(id);
  if (editingId.value === id) editingId.value = '';
}

/* 模型切换（会话级） */
const modelSwitchRef = ref(null);
const modelMenuOpen = ref(false);
/* 点击菜单外任意处收起（document 捕获监听，不依赖 fixed 遮罩——
 * 祖先带 transform 时 fixed 会相对祖先定位而失效） */
function onDocMouseDown(e) {
  const el = modelSwitchRef.value;
  if (el && !el.contains(e.target)) modelMenuOpen.value = false;
}
watch(modelMenuOpen, (open) => {
  if (open) document.addEventListener('mousedown', onDocMouseDown, true);
  else document.removeEventListener('mousedown', onDocMouseDown, true);
});
onUnmounted(() => document.removeEventListener('mousedown', onDocMouseDown, true));
const currentModel = computed(() => {
  const c = conversations.value.find((x) => x.id === activeId.value);
  return (c && c.model) || config.value.model || '';
});
const modelOptions = computed(() => {
  const list = [...(config.value.models || [])];
  if (config.value.model && !list.includes(config.value.model)) list.unshift(config.value.model);
  if (currentModel.value && !list.includes(currentModel.value)) list.unshift(currentModel.value);
  return list;
});
function chooseModel(m) {
  setActiveModel(m);
  modelMenuOpen.value = false;
}

/* 上下文开关（记忆上次选择；协议库默认开，串口数据默认关） */
const ctxProtocols = ref(localStorage.getItem('spm-ai-ctx-protocols') !== '0');
const ctxSerial = ref(localStorage.getItem('spm-ai-ctx-serial') === '1');
const contextBuilding = ref(false);

function toggleCtx(which) {
  if (which === 'protocols') {
    ctxProtocols.value = !ctxProtocols.value;
    localStorage.setItem('spm-ai-ctx-protocols', ctxProtocols.value ? '1' : '0');
  } else {
    ctxSerial.value = !ctxSerial.value;
    localStorage.setItem('spm-ai-ctx-serial', ctxSerial.value ? '1' : '0');
  }
}

const configOk = computed(() => config.value.enabled && config.value.baseUrl && config.value.model && config.value.hasKey);

const quickPrompts = [
  { label: '分析串口帧数据', text: '帮我分析下面这段串口接收数据：请解读帧结构、各字段含义、校验方式，并指出是否完整。\n\nHEX 数据：\n' },
  { label: '生成解析代码', text: '请为下面的通信协议写一段 C 语言的帧解析代码框架（含状态机与 CRC 校验）：\n\n协议说明：\n' },
  { label: '生成协议 JSON', text: '请根据以下描述生成协议定义 JSON：\n' },
  { label: 'CRC 校验讲解', text: '请解释 CRC16/Modbus 的计算步骤（多项式、初值、结果异或与字节序），并给出一个 JavaScript 实现示例。' },
  { label: '排查升级失败', text: '设备 OTA 升级失败，日志如下，请分析可能的原因和排查步骤：\n\n' },
];

/* 「生成协议 JSON」指令前缀：命中时走 JSON Mode 单轮生成而非普通对话 */
const GENERATE_TRIGGER = '请根据以下描述生成协议定义 JSON';

/* ---------------- 附件（图片 + 文本文件） ---------------- */
const MAX_IMAGES = 6;             // 单条消息图片上限
const MAX_FILES = 5;              // 单条消息文本文件上限
const MAX_TOTAL = 8;              // 单条消息附件总数上限
const MAX_IMAGE_CHARS = 4 * 1024 * 1024;  // 压缩后 dataURL 字符数上限（约 3MB 二进制）
const MAX_TEXT_BYTES = 500 * 1024;        // 文本文件大小上限
const MAX_IMAGE_EDGE = 1568;      // 图片长边超过则等比压缩（Anthropic 推荐的视觉输入尺寸）
const IMAGE_MIME = /^image\/(png|jpeg|jpg|gif|webp)$/i;
const TEXT_ACCEPT = '.txt,.md,.markdown,.json,.c,.h,.cpp,.hpp,.cc,.hh,.py,.js,.ts,.vue,.jsx,.tsx,.css,.scss,.html,.htm,.xml,.yaml,.yml,.csv,.tsv,.log,.ini,.cfg,.conf,.sql,.sh,.bat,.ps1,.hex,.asm,.s,.ld,.map,.gitignore,.properties,.toml,.env,.ino,.rs,.go,.java,.kt,.lua,.v,.sv';
const TEXT_EXT = new Set(TEXT_ACCEPT.split(',').map((s) => s.trim().toLowerCase()));

const attachments = ref([]);
const attachError = ref('');
const imageInputRef = ref(null);
const fileInputRef = ref(null);
const previewUrl = ref('');
const dragOver = ref(false);
let dragDepth = 0;
let attachErrorTimer = null;

function showAttachError(msg) {
  attachError.value = msg;
  if (attachErrorTimer) clearTimeout(attachErrorTimer);
  attachErrorTimer = setTimeout(() => { attachError.value = ''; }, 5000);
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('读取文件失败'));
    r.readAsDataURL(file);
  });
}

function readAsText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('读取文件失败'));
    r.readAsText(file, 'utf-8');
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片解析失败'));
    img.src = src;
  });
}

/* 大图等比缩小重编码为 JPEG（白底），小图保留原格式原数据 */
async function compressImage(file) {
  const dataUrl = await readAsDataURL(file);
  let img;
  try { img = await loadImage(dataUrl); } catch { return null; }
  const long = Math.max(img.naturalWidth, img.naturalHeight);
  if (long <= MAX_IMAGE_EDGE && file.size <= 400 * 1024) return dataUrl;
  const scale = Math.min(1, MAX_IMAGE_EDGE / long);
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return dataUrl;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', 0.85);
}

async function addImageFiles(fileList) {
  const files = [...fileList].filter((f) => IMAGE_MIME.test(f.type) || /\.(png|jpe?g|gif|webp)$/i.test(f.name));
  if (!files.length) return;
  const curImages = attachments.value.filter((a) => a.type === 'image').length;
  for (const f of files) {
    if (attachments.value.length >= MAX_TOTAL || curImages >= MAX_IMAGES) {
      showAttachError(`单条消息最多 ${MAX_IMAGES} 张图片、共 ${MAX_TOTAL} 个附件`);
      break;
    }
    try {
      let dataUrl = await compressImage(f);
      if (!dataUrl) { showAttachError(`图片「${f.name}」解析失败，已跳过`); continue; }
      if (dataUrl.length > MAX_IMAGE_CHARS) { showAttachError(`图片「${f.name}」过大（压缩后仍超 3MB），已跳过`); continue; }
      attachments.value.push({ id: `a${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, type: 'image', name: f.name || '图片', dataUrl, size: f.size });
    } catch (e) {
      showAttachError(`图片「${f.name}」读取失败：${String(e.message || e)}`);
    }
  }
}

async function addTextFiles(fileList) {
  const files = [...fileList].filter((f) => {
    if (f.type.startsWith('text/')) return true;
    const dot = f.name.lastIndexOf('.');
    const ext = dot >= 0 ? f.name.slice(dot).toLowerCase() : '';
    return TEXT_EXT.has(ext) || (!ext && !f.type);
  });
  if (!files.length) {
    const hasOther = [...fileList].some((f) => !IMAGE_MIME.test(f.type));
    if (hasOther) showAttachError('仅支持文本类文件（代码/日志/配置等），二进制文件无法发送');
    return;
  }
  const curFiles = attachments.value.filter((a) => a.type === 'file').length;
  for (const f of files) {
    if (attachments.value.length >= MAX_TOTAL || curFiles >= MAX_FILES) {
      showAttachError(`单条消息最多 ${MAX_FILES} 个文本文件、共 ${MAX_TOTAL} 个附件`);
      break;
    }
    if (f.size > MAX_TEXT_BYTES) { showAttachError(`文件「${f.name}」超过 500KB，已跳过`); continue; }
    try {
      const content = await readAsText(f);
      attachments.value.push({ id: `a${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, type: 'file', name: f.name, content, size: f.size });
    } catch (e) {
      showAttachError(`文件「${f.name}」读取失败：${String(e.message || e)}`);
    }
  }
}

function onPickImages(e) {
  const files = e.target.files;
  if (files && files.length) addImageFiles(files);
  e.target.value = '';
}

function onPickTextFiles(e) {
  const files = e.target.files;
  if (files && files.length) addTextFiles(files);
  e.target.value = '';
}

function removeAttachment(i) {
  attachments.value.splice(i, 1);
}

/* 粘贴：剪贴板带图片文件时转为附件（纯文本粘贴不受影响） */
function onPaste(e) {
  const files = [...((e.clipboardData && e.clipboardData.files) || [])].filter((f) => IMAGE_MIME.test(f.type));
  if (!files.length) return;
  e.preventDefault();
  addImageFiles(files);
}

/* 拖拽：图片与文本文件均可拖入聊天面板 */
function onDragEnter() {
  dragDepth++;
  dragOver.value = true;
}
function onDragOver() {
  if (!dragOver.value) dragOver.value = true;
}
function onDragLeave() {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dragOver.value = false;
}
function onDrop(e) {
  dragDepth = 0;
  dragOver.value = false;
  const files = [...((e.dataTransfer && e.dataTransfer.files) || [])];
  if (!files.length) return;
  const imgs = files.filter((f) => IMAGE_MIME.test(f.type) || /\.(png|jpe?g|gif|webp)$/i.test(f.name));
  const texts = files.filter((f) => !imgs.includes(f));
  if (imgs.length) addImageFiles(imgs);
  if (texts.length) addTextFiles(texts);
}

function onEnter(e) {
  /* 中文输入法组词回车不发送 */
  if (e.isComposing || e.keyCode === 229) return;
  if (e.shiftKey) return;
  e.preventDefault();
  doSend();
}

async function doSend() {
  const body = draft.value.trim();
  if ((!body && !attachments.value.length) || streaming.value || contextBuilding.value) return;

  /* JSON Mode 快捷指令（纯文本场景）：带附件时按普通对话发送 */
  if (body.startsWith(GENERATE_TRIGGER) && !attachments.value.length) {
    const desc = body.slice(GENERATE_TRIGGER.length).replace(/^[:：\s]+/, '').trim();
    draft.value = '';
    if (!desc) {
      send(body);
    } else {
      generateJson(desc, PROTOCOL_JSON_PROMPT);
    }
    return;
  }

  let contextText = '';
  if (ctxProtocols.value || ctxSerial.value) {
    contextBuilding.value = true;
    try {
      const parts = [];
      if (ctxProtocols.value) {
        const t = await buildProtocolContextText();
        if (t) parts.push(t);
      }
      if (ctxSerial.value) {
        const t = await buildSerialContextText();
        if (t) parts.push(t);
      }
      contextText = parts.join('\n\n');
    } finally {
      contextBuilding.value = false;
    }
  }
  draft.value = '';
  const atts = attachments.value.slice();
  attachments.value = [];
  send(body, { contextText, attachments: atts });
}

async function copyJson(m) {
  if (!m.jsonData) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify(m.jsonData, null, 2));
    copiedId.value = m.id;
    setTimeout(() => { if (copiedId.value === m.id) copiedId.value = ''; }, 1500);
  } catch { /* 剪贴板不可用时忽略 */ }
}

/* AI 回复里的链接点击代理：调系统浏览器打开，阻止窗口内导航 */
function onContentClick(e) {
  const a = e.target && e.target.closest ? e.target.closest('a.ai-link') : null;
  if (!a) return;
  e.preventDefault();
  const url = a.getAttribute('href') || '';
  if (/^https?:\/\//i.test(url) && window.electronAPI?.shell?.openExternal) {
    window.electronAPI.shell.openExternal(url);
  }
}

function goSettings() {
  window.dispatchEvent(new CustomEvent('spm-switch-view', { detail: 'settings' }));
}

/* 消息增长时滚动到底部 */
watch(messages, () => {
  nextTick(() => {
    const el = listRef.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}, { deep: true });

watch(() => props.active, (v) => {
  if (v) refreshConfig();
});

onMounted(() => {
  if (props.active) refreshConfig();
});
</script>

<style scoped>
.ai-chat-view { display: flex; flex-direction: column; gap: 12px; height: 100%; min-height: 0; }

.ai-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-shrink: 0; }
.ai-header h2 { font-size: 18px; font-weight: 600; margin: 0; }
.ai-header-meta { display: flex; align-items: center; gap: 8px; }

/* 模型切换（会话级） */
.ai-model-switch { position: relative; }
.ai-model-chip {
  display: inline-flex; align-items: center; gap: 5px; max-width: 220px;
  padding: 4px 10px; border-radius: 20px; font-size: 12px; font-family: var(--font-mono, monospace);
  background: rgba(59, 130, 246, 0.12); color: var(--accent-blue); border: 1px solid transparent; cursor: pointer;
}
.ai-model-chip:hover { border-color: var(--accent-blue); }
.ai-model-chip.off { background: rgba(245, 158, 11, 0.12); color: var(--accent-amber); }
.ai-model-pop {
  position: absolute; top: calc(100% + 6px); right: 0; z-index: 30; min-width: 240px; max-height: 320px;
  overflow-y: auto; padding: 6px;
  background: var(--bg-elevated); border: 1px solid var(--border-light); border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg); display: flex; flex-direction: column; gap: 2px;
}
.ai-pop-item {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  border: none; background: transparent; cursor: pointer; text-align: left;
  border-radius: var(--radius-sm); padding: 7px 10px;
  font-family: var(--font-mono, monospace); font-size: 12.5px; color: var(--text-primary);
}
.ai-pop-item:hover { background: var(--bg-hover); }
.ai-pop-item.on { color: var(--accent-blue); }
.ai-pop-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ai-pop-empty { padding: 10px; text-align: center; font-size: 12px; color: var(--text-tertiary); }
.ai-pop-manage {
  border: none; border-top: 1px solid var(--border-color); background: transparent; cursor: pointer;
  padding: 8px 10px 4px; margin-top: 4px; font-size: 12px; color: var(--text-secondary); text-align: left;
}
.ai-pop-manage:hover { color: var(--accent-blue); }

.ai-tool-btn {
  background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 6px;
  padding: 5px 12px; font-size: 12px; color: var(--text-secondary); cursor: pointer;
}
.ai-tool-btn:hover:not(:disabled) { color: var(--text-primary); border-color: var(--accent-blue); }
.ai-tool-btn:disabled { opacity: 0.5; cursor: not-allowed; }

/* 布局：会话侧栏 + 聊天面板 */
.ai-layout { flex: 1; display: flex; gap: 12px; min-height: 0; }

/* 会话侧栏 */
.ai-sessions { width: 190px; flex-shrink: 0; display: flex; flex-direction: column; min-height: 0; }
.ai-sessions-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 12px; border-bottom: 1px solid var(--border-color);
}
.ai-sessions-title { font-size: 13px; font-weight: 600; color: var(--text-primary); }
.ai-icon-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; border: none; border-radius: 5px;
  background: transparent; color: var(--text-tertiary); cursor: pointer;
}
.ai-icon-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
.ai-icon-btn.danger:hover { background: rgba(239, 68, 68, 0.14); color: var(--accent-red); }
.ai-sessions-list { flex: 1; overflow-y: auto; padding: 6px; display: flex; flex-direction: column; gap: 2px; }
.ai-session-item {
  display: flex; align-items: center; justify-content: space-between; gap: 6px;
  padding: 7px 8px 7px 10px; border-radius: var(--radius-sm); cursor: pointer;
  color: var(--text-secondary); font-size: 12.5px;
}
.ai-session-item:hover { background: var(--bg-hover); }
.ai-session-item.active { background: var(--accent-blue-glow); color: var(--accent-blue); }
.ai-session-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ai-session-actions { display: none; flex-shrink: 0; gap: 2px; }
.ai-session-item:hover .ai-session-actions { display: inline-flex; }
.ai-rename-input { padding: 3px 8px; font-size: 12px; }

/* 未配置引导 */
.ai-guide-title { font-size: 14px; font-weight: 600; color: var(--text-primary); margin: 0 0 6px; }
.ai-guide-text { font-size: 13px; color: var(--text-secondary); line-height: 1.7; margin: 0 0 14px; }
.ai-primary-btn {
  background: var(--accent-blue); border: none; border-radius: 6px;
  padding: 8px 18px; font-size: 13px; color: #fff; cursor: pointer;
}
.ai-primary-btn:hover { filter: brightness(1.1); }

/* 对话区 */
.ai-chat-panel { flex: 1; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.ai-messages { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 12px; min-height: 0; }

.ai-empty { text-align: center; margin: auto; color: var(--text-tertiary); font-size: 13px; }
.ai-empty p { margin: 0 0 12px; }
.ai-quick { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; }
.ai-chip {
  background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 18px;
  padding: 7px 14px; font-size: 12px; color: var(--text-secondary); cursor: pointer;
}
.ai-chip:hover:not(:disabled) { color: var(--accent-blue); border-color: var(--accent-blue); }
.ai-chip:disabled { opacity: 0.5; cursor: not-allowed; }

.ai-msg { display: flex; }
.ai-msg.user { justify-content: flex-end; }
.ai-msg.assistant { justify-content: flex-start; }
.ai-bubble {
  max-width: 86%; padding: 10px 14px; border-radius: 10px;
  font-size: 13px; line-height: 1.7; word-break: break-word;
}
.ai-msg.user .ai-bubble { background: var(--accent-blue); color: #fff; border-bottom-right-radius: 3px; }
.ai-msg.assistant .ai-bubble { background: var(--bg-secondary); border: 1px solid var(--border-light); color: var(--text-primary); border-bottom-left-radius: 3px; }
.ai-user-text { white-space: pre-wrap; }
.ai-error {
  margin-top: 6px; padding-top: 6px; border-top: 1px dashed var(--border-light);
  color: var(--accent-red); font-size: 12px; display: flex; align-items: flex-start; gap: 6px;
}
.ai-error-icon { flex-shrink: 0; margin-top: 1px; }

/* AI 回复内的 Markdown 元素（紧凑排版） */
.ai-p { display: block; }
.ai-tools { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
.ai-tool-chip {
  display: inline-flex; align-items: center; gap: 4px; max-width: 100%;
  background: var(--bg-hover); border: 1px solid var(--border-light); border-radius: 4px;
  padding: 2px 7px; font-size: 11px; font-family: var(--font-mono, monospace);
  color: var(--text-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ai-tool-chip svg { flex-shrink: 0; }
.ai-tool-chip.err { color: var(--accent-red); border-color: var(--accent-red); }
.ai-copy-btn {
  display: inline-flex; align-self: flex-start; margin-top: 6px;
  background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 6px;
  padding: 4px 10px; font-size: 12px; color: var(--text-secondary); cursor: pointer;
}
.ai-copy-btn:hover { color: var(--text-primary); border-color: var(--accent-blue); }
.ai-h { margin: 16px 0 7px; font-weight: 700; color: var(--text-primary); line-height: 1.4; }
.ai-bubble .ai-h:first-child { margin-top: 0; }
.ai-h1 { font-size: 15.5px; }
.ai-h2 { font-size: 14.5px; padding-bottom: 5px; border-bottom: 1px solid var(--border-color); }
.ai-h3 { font-size: 13.5px; }
.ai-h-badge {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 18px; height: 18px; padding: 0 5px; margin-right: 7px;
  border-radius: 4px; background: var(--accent-blue); color: #fff;
  font-size: 11.5px; font-weight: 600; vertical-align: 2px;
}
.ai-hr { border: none; border-top: 1px solid var(--border-color); margin: 14px 0; }
.ai-list { margin: 2px 0; padding-left: 22px; }
.ai-list li { margin: 3px 0; }
.ai-list li::marker { color: var(--text-tertiary); }
.ai-list .ai-list { margin: 1px 0; }
.ai-quote { border-left: 3px solid var(--accent-blue); margin: 8px 0; padding: 2px 12px; color: var(--text-secondary); }
.ai-inline-code {
  background: var(--bg-hover); border: 1px solid var(--border-light); border-radius: 4px;
  padding: 1px 6px; font-family: var(--font-mono, monospace); font-size: 12px; color: var(--text-primary);
}
.ai-link { color: var(--accent-blue); text-decoration: underline; text-underline-offset: 2px; }
.ai-link:hover { opacity: 0.85; }
.ai-table {
  border-collapse: collapse; margin: 6px 0 2px; font-size: 12px;
  max-width: 100%; display: block; overflow-x: auto;
}
.ai-table th, .ai-table td { border: 1px solid var(--border-color); padding: 5px 10px; text-align: left; white-space: nowrap; }
.ai-table th { background: var(--bg-hover); font-weight: 700; }

.ai-code {
  background: rgba(0, 0, 0, 0.25); border: 1px solid var(--border-light); border-radius: 6px;
  padding: 10px 12px; margin: 8px 0 2px; overflow-x: auto;
  font-family: Consolas, Monaco, monospace; font-size: 12px; line-height: 1.6;
  color: var(--text-primary); white-space: pre;
}
.ai-caret { color: var(--accent-blue); animation: ai-blink 0.9s infinite; margin-left: 1px; }
@keyframes ai-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
/* 首 token 延迟期的"思考中"指示 */
.ai-thinking {
  display: inline-flex; align-items: center; gap: 3px;
  color: var(--text-tertiary); font-size: 12px;
}
.ai-dot {
  width: 4px; height: 4px; border-radius: 50%; background: var(--accent-blue);
  animation: ai-bounce 1.2s infinite;
}
.ai-dot:nth-child(2) { animation-delay: 0.15s; }
.ai-dot:nth-child(3) { animation-delay: 0.3s; }
@keyframes ai-bounce { 0%, 60%, 100% { transform: translateY(0); opacity: 0.4; } 30% { transform: translateY(-3px); opacity: 1; } }

/* 输入区 */
.ai-input-area { border-top: 1px solid var(--border-light); padding: 10px 14px 12px; }
.ai-ctx-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }.ai-ctx-chip {
  display: inline-flex; align-items: center; gap: 5px;
  background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 999px;
  padding: 4px 12px; font-size: 12px; color: var(--text-tertiary); cursor: pointer; transition: all 0.15s ease;
}
.ai-ctx-chip svg { flex-shrink: 0; }
.ai-ctx-chip:hover { color: var(--text-secondary); }
.ai-ctx-chip.on {
  background: var(--accent-blue-glow); border-color: var(--accent-blue); color: var(--accent-blue);
}
.ai-ctx-tip, .ai-ctx-building { font-size: 11px; color: var(--text-tertiary); }
.ai-ctx-building { color: var(--accent-blue); }
.ai-input {
  width: 100%; box-sizing: border-box; resize: none;
  background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 8px;
  padding: 9px 12px; font-size: 13px; color: var(--text-primary); outline: none;
  font-family: inherit; line-height: 1.6;
}
.ai-input:focus { border-color: var(--accent-blue); }
.ai-input:disabled { opacity: 0.6; }
.ai-input-actions { display: flex; align-items: center; justify-content: space-between; margin-top: 8px; }
.ai-privacy-hint { font-size: 11px; color: var(--text-tertiary); }
.ai-send-btn, .ai-stop-btn {
  display: inline-flex; align-items: center; gap: 6px;
  border: none; border-radius: 6px; padding: 7px 16px; font-size: 13px; cursor: pointer;
}
.ai-send-btn { background: var(--accent-blue); color: #fff; }
.ai-send-btn:hover:not(:disabled) { filter: brightness(1.1); }
.ai-send-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.ai-stop-btn { background: rgba(239, 68, 68, 0.14); color: #ef4444; }
.ai-stop-btn:hover { background: rgba(239, 68, 68, 0.24); }

/* 拖拽附件高亮 */
.ai-chat-panel.ai-drag-over { outline: 2px dashed var(--accent-blue); outline-offset: -4px; background: var(--accent-blue-glow); }

/* 附件异常提示 */
.ai-attach-error {
  display: flex; align-items: center; gap: 5px; margin-bottom: 6px;
  font-size: 12px; color: var(--accent-red);
}

/* 待发送附件预览条 */
.ai-att-strip { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
.ai-att-item {
  position: relative; display: flex; align-items: center; gap: 6px;
  max-width: 190px; padding: 5px 26px 5px 6px;
  background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 8px;
}
.ai-att-item-thumb { width: 36px; height: 36px; object-fit: cover; border-radius: 5px; flex-shrink: 0; }
.ai-att-item-icon { flex-shrink: 0; color: var(--text-tertiary); }
.ai-att-item-name {
  font-size: 12px; color: var(--text-secondary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ai-att-remove {
  position: absolute; top: -6px; right: -6px;
  display: inline-flex; align-items: center; justify-content: center;
  width: 17px; height: 17px; border: none; border-radius: 50%;
  background: var(--bg-elevated, #fff); color: var(--text-secondary);
  border: 1px solid var(--border-light); cursor: pointer; padding: 0;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
}
.ai-att-remove:hover { color: var(--accent-red); border-color: var(--accent-red); }

/* 隐藏的原生文件选择框 */
.ai-file-input { display: none; }

/* 输入动作区：附件按钮 */
.ai-input-left { display: flex; align-items: center; gap: 6px; min-width: 0; }
.ai-attach-btn {
  display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0;
  background: transparent; border: 1px solid transparent; border-radius: 6px;
  padding: 4px 8px; font-size: 12px; color: var(--text-tertiary); cursor: pointer;
}
.ai-attach-btn:hover:not(:disabled) { color: var(--accent-blue); background: var(--bg-hover); }
.ai-attach-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.ai-input-left .ai-privacy-hint { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 用户气泡内的附件 */
.ai-att-row { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; align-items: flex-end; }
.ai-att-row:last-child { margin-bottom: 0; }
.ai-att-thumb {
  width: 96px; height: 96px; object-fit: cover; border-radius: 7px;
  border: 1px solid rgba(255, 255, 255, 0.4); cursor: zoom-in; display: block;
}
.ai-att-file-chip {
  display: inline-flex; align-items: center; gap: 4px; max-width: 190px;
  background: rgba(255, 255, 255, 0.16); border: 1px solid rgba(255, 255, 255, 0.35);
  border-radius: 6px; padding: 3px 8px; font-size: 11.5px; color: #fff;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ai-att-file-chip svg { flex-shrink: 0; }

/* 图片灯箱 */
.ai-lightbox {
  position: fixed; inset: 0; z-index: 200;
  background: rgba(0, 0, 0, 0.72);
  display: flex; align-items: center; justify-content: center;
  cursor: zoom-out;
}
.ai-lightbox img { max-width: 92vw; max-height: 92vh; border-radius: 8px; box-shadow: var(--shadow-lg); }
</style>
