<template>
  <div class="embedded-view">
    <!-- 运行配置 -->
    <div class="panel">
      <div class="panel-header">
        <h3>运行配置</h3>
      </div>
      <div class="panel-body">
        <!-- 串口选择 + 执行模式 -->
        <div class="form-row inline">
          <div>
            <label>目标串口</label>
            <select class="input" v-model="selectedPort" :disabled="sending">
              <option value="">— 选择串口 —</option>
              <option v-for="p in portList" :key="p" :value="p">{{ p }}</option>
            </select>
          </div>
          <div>
            <label>执行模式</label>
            <div class="mode-toggle-group">
              <button
                v-for="m in loopOptions"
                :key="m.value"
                :class="['btn', 'btn-small', loopMode === m.value ? 'btn-primary' : 'btn-secondary']"
                @click="loopMode = m.value"
                :disabled="sending"
              >{{ m.label }}</button>
            </div>
          </div>
        </div>

        <!-- 次数 / 间隔 -->
        <div class="form-row inline">
          <div>
            <label>循环次数</label>
            <input type="number" class="input" v-model.number="loopCount" min="1" max="10000"
              :disabled="sending || loopMode !== 1" placeholder="10" />
          </div>
          <div>
            <label>条目间隔 (ms)</label>
            <input type="number" class="input" v-model.number="itemIntervalMs" min="0" max="600000" step="10"
              :disabled="sending" />
          </div>
          <div>
            <label>循环间隔 (ms)</label>
            <input type="number" class="input" v-model.number="loopIntervalMs" min="0" max="600000" step="10"
              :disabled="sending || loopMode === 0" />
          </div>
        </div>

        <!-- 操作按钮 -->
        <div class="form-row" style="margin-bottom: 0;">
          <div class="action-group">
            <button class="btn btn-primary" :disabled="!canStart" @click="startSend">
              {{ sending ? '发送中… (' + (currentItem + 1) + '/' + checkedItems.length + ')' : '开始发送 (' + checkedItems.length + ' 条)' }}
            </button>
            <button class="btn btn-danger" :disabled="!sending" @click="stopSend">停止</button>
            <button class="btn btn-secondary" :disabled="sending" @click="openItemEditor()">添加条目</button>
            <button class="btn btn-secondary" :disabled="sending || !items.length" @click="clearAll">清空列表</button>
          </div>
        </div>

        <!-- 进度条 -->
        <div v-if="sending || totalProgress.total > 0" class="progress-section">
          <div class="progress-meta">
            <span>轮次 {{ currentLoop }} / {{ totalLoopsLabel }}</span>
            <span>条目 {{ currentItem + 1 }} / {{ checkedItems.length }}</span>
            <span class="progress-ok">✓ {{ totalProgress.success }}</span>
            <span class="progress-err">✗ {{ totalProgress.fail }}</span>
          </div>
          <div class="progress-bar">
            <div class="progress-fill" :style="{ width: progressPercent + '%' }"></div>
          </div>
        </div>
      </div>
    </div>

    <!-- 发送条目 -->
    <div class="panel" style="margin-top: 20px;">
      <div class="panel-header">
        <h3>发送条目</h3>
        <div class="panel-header-actions">
          <span>{{ items.length }} 条</span>
          <span>{{ checkedItems.length }} 已启用</span>
          <span>默认 {{ sendFormat }} 模式</span>
        </div>
      </div>

      <!-- 空状态 -->
      <div v-if="!items.length" class="empty-state">
        <p>暂无发送条目</p>
        <div class="empty-actions">
          <button class="btn btn-primary btn-small" @click="openItemEditor()">添加条目</button>
          <button class="btn btn-secondary btn-small" @click="addDemoItems">加载示例</button>
        </div>
      </div>

      <!-- 条目表格 -->
      <div v-else class="table-wrap">
        <table class="list-table">
          <thead>
            <tr>
              <th style="width: 36px;"></th>
              <th style="width: 40px;">
                <label class="check-box">
                  <input type="checkbox" :checked="allChecked" :indeterminate.prop="partiallyChecked"
                    @change="toggleAllChecked($event.target.checked)" :disabled="sending" />
                </label>
              </th>
              <th style="width: 40px;">#</th>
              <th style="width: 180px;">条目</th>
              <th style="width: 80px;">格式</th>
              <th style="width: 100px;">间隔</th>
              <th>数据预览</th>
              <th style="width: 110px;">状态</th>
              <th style="width: 110px;">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(it, idx) in items"
              :key="it.id"
              :class="{ 'row-active': sending && runState.itemId === it.id, 'row-ok': it.lastResult === 'success', 'row-err': it.lastResult === 'fail' }"
              draggable="true"
              @dragstart="onItemDragStart(idx, $event)"
              @dragover.prevent="onItemDragOver(idx)"
              @drop.prevent="onItemDrop(idx)"
              @dragend="onItemDragEnd"
            >
              <td class="drag-cell"><span class="drag-handle">⋮⋮</span></td>
              <td>
                <label class="check-box">
                  <input type="checkbox" v-model="it.enabled" :disabled="sending" />
                </label>
              </td>
              <td>{{ idx + 1 }}</td>
              <td>
                <input type="text" class="input name-input" v-model="it.name" maxlength="64"
                  placeholder="指令名称" :disabled="sending" />
              </td>
              <td><span class="format-tag" :class="it.format === 'HEX' ? 'hex' : 'ascii'">{{ it.format }}</span></td>
              <td>
                <input type="number" class="input interval-input" v-model.number="it.interval"
                  min="0" max="600000" step="10" placeholder="默认" :disabled="sending" />
              </td>
              <td><code class="preview-code" :title="it.data || '(空)'">{{ previewText(it) }}</code></td>
              <td>
                <span v-if="!it.lastResult" class="state-tag idle">待命</span>
                <span v-else-if="it.lastResult === 'success'" class="state-tag ok">成功 ({{ it.lastSendCount }})</span>
                <span v-else class="state-tag err">失败 ({{ it.lastSendCount }})<em v-if="it.lastError">{{ it.lastError }}</em></span>
              </td>
              <td>
                <div class="row-actions">
                  <button class="btn btn-secondary btn-small" :disabled="sending" @click="openItemEditor(it)">编辑</button>
                  <button class="btn btn-secondary btn-small" :disabled="sending" @click="removeItem(it.id)">删除</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 编辑条目弹窗 -->
    <Transition name="modal-fade">
      <div v-if="editorVisible" class="modal-overlay" @mousedown.self="closeEditor">
        <div class="modal-dialog" style="min-width: 480px; max-width: 560px;">
          <div class="modal-header">
            <h3>{{ editingItem ? '编辑条目' : '新条目' }}</h3>
          </div>
          <div class="modal-body">
            <div class="form-row">
              <label>名称</label>
              <input type="text" class="input" v-model="editorDraft.name" maxlength="64"
                placeholder="如：心跳帧 / 读寄存器 01" />
            </div>

            <div class="form-row">
              <label>数据格式</label>
              <div class="mode-toggle-group">
                <button :class="['btn', 'btn-small', editorDraft.format === 'HEX' ? 'btn-primary' : 'btn-secondary']"
                  @click="editorDraft.format = 'HEX'" type="button">HEX</button>
                <button :class="['btn', 'btn-small', editorDraft.format === 'ASCII' ? 'btn-primary' : 'btn-secondary']"
                  @click="editorDraft.format = 'ASCII'" type="button">ASCII</button>
              </div>
            </div>

            <div class="form-row">
              <label>数据内容 <em v-if="editorDraft.format === 'HEX'" style="font-size: 12px; color: var(--text-tertiary);">空格分隔，奇数位自动补 0</em></label>
              <textarea
                class="input"
                v-model="editorDraft.data"
                rows="5"
                :spellcheck="editorDraft.format !== 'HEX'"
                :placeholder="editorDraft.format === 'HEX' ? 'AA 55 01 02 FF' : '直接填写文本'"
                style="resize: vertical; font-family: var(--font-mono);"
              ></textarea>
              <div v-if="editorDraft.format === 'HEX'" style="margin-top: 6px; font-size: 12px;" :style="{ color: hexValid ? 'var(--accent-green)' : 'var(--accent-red)' }">
                {{ hexValid ? '✓ 合法，' + hexByteCount + ' 字节' : '✗ 非法字符或半字节' }}
              </div>
            </div>

            <div class="form-row inline">
              <div>
                <label>发送后间隔 (ms)</label>
                <input type="number" class="input" v-model.number="editorDraft.interval"
                  min="0" max="600000" step="10" placeholder="留空 = 全局间隔" />
              </div>
              <div>
                <label>状态</label>
                <label class="modal-checkbox">
                  <input type="checkbox" v-model="editorDraft.enabled" />
                  {{ editorDraft.enabled ? '启用（加入发送队列）' : '暂不发送' }}
                </label>
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" @click="closeEditor">取消</button>
            <button class="btn btn-primary" :disabled="!canSaveEditor" @click="saveEditor">保存</button>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<script setup>
import { ref, computed, onBeforeUnmount, watch } from 'vue';
import { useSerial } from '../composables/useSerial';

const { availablePorts, hasElectron, refreshPorts, sendPort } = useSerial();

const portList = computed(() => availablePorts.value || []);

/* ============ 运行配置 ============ */
const selectedPort = ref('');
const sendFormat = ref('HEX');
const loopMode = ref(0); // 0 单次 / 1 自定义 / -1 无限
const loopCount = ref(10);
const itemIntervalMs = ref(300);
const loopIntervalMs = ref(1000);

const loopOptions = [
  { value: 0,  label: '单次', icon: '①' },
  { value: 1,  label: 'N轮',  icon: '↻' },
  { value: -1, label: '无限', icon: '∞' },
];

/* ============ 条目 ============ */
const uid = (() => { let i = 1000; return () => ++i; })();
const items = ref([]);

function addDemoItems() {
  items.value = [
    {
      id: uid(), enabled: true, name: '心跳帧',
      format: 'HEX', data: 'AA 55 00 00', interval: null,
      lastResult: '', lastSendCount: 0, lastError: '',
    },
    {
      id: uid(), enabled: true, name: '查询寄存器 01',
      format: 'HEX', data: 'AA 55 01 02', interval: 500,
      lastResult: '', lastSendCount: 0, lastError: '',
    },
    {
      id: uid(), enabled: false, name: 'ASCII：hello',
      format: 'ASCII', data: 'hello', interval: 200,
      lastResult: '', lastSendCount: 0, lastError: '',
    },
  ];
}

const checkedItems = computed(() => items.value.filter(it => it.enabled));
const allChecked = computed(() => items.value.length > 0 && items.value.every(it => it.enabled));
const partiallyChecked = computed(() => items.value.some(it => it.enabled) && !allChecked.value);
function toggleAllChecked(checked) { items.value.forEach(it => (it.enabled = checked)); }
function clearAll() {
  if (!confirm('确定清空所有条目吗？')) return;
  items.value = [];
}
function removeItem(id) {
  items.value = items.value.filter(it => it.id !== id);
}

/* ============ 拖动排序 ============ */
let dragItemIdx = null;
function onItemDragStart(idx, e) {
  if (sending.value) { e.preventDefault(); return; }
  dragItemIdx = idx;
  if (e?.dataTransfer) {
    try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(idx)); } catch {}
  }
}
function onItemDragOver() {}
function onItemDrop(idx) {
  if (sending.value || dragItemIdx === null || dragItemIdx === idx) { dragItemIdx = null; return; }
  const arr = items.value.slice();
  const [moved] = arr.splice(dragItemIdx, 1);
  arr.splice(idx, 0, moved);
  items.value = arr;
  dragItemIdx = null;
}
function onItemDragEnd() { dragItemIdx = null; }

/* ============ 预览与 HEX 校验 ============ */
function previewText(it) {
  if (!it.data) return '(空)';
  if (it.format === 'ASCII') {
    const s = it.data.replace(/[\r\n]+/g, '␤').replace(/\s+/g, ' ');
    return s.length > 60 ? s.slice(0, 60) + '…' : s;
  }
  const compact = normalizeHex(it.data);
  if (!compact) return '(空)';
  const spaced = compact.match(/.{1,2}/g)?.join(' ') || compact;
  return spaced.length > 78 ? spaced.slice(0, 78) + '…' : spaced;
}
function normalizeHex(text) {
  if (!text) return '';
  return String(text).trim().split(/\s+/).map(t => t.replace(/^0[xX]/, '')).join('').toUpperCase();
}
function validateHex(text) {
  const c = normalizeHex(text);
  return { valid: !c || /^[0-9A-F]*$/.test(c), compact: c };
}

/* ============ 编辑器 ============ */
const editorVisible = ref(false);
const editingItem = ref(null);
const editorDraft = ref(makeDraft());
function makeDraft() {
  return { id: 0, enabled: true, name: '', format: 'HEX', data: '', interval: null };
}
const hexValid = computed(() => {
  if (editorDraft.value.format !== 'HEX') return true;
  const { valid, compact } = validateHex(editorDraft.value.data);
  return valid && compact.length % 2 === 0;
});
const hexByteCount = computed(() => Math.floor(normalizeHex(editorDraft.value.data).length / 2));
const canSaveEditor = computed(() => {
  const d = editorDraft.value;
  if (d.format === 'HEX') {
    const { valid, compact } = validateHex(d.data);
    if (!valid || compact.length % 2 !== 0) return false;
    if (!compact.length && !d.name) return false;
  } else {
    if (!String(d.data || '').length && !d.name) return false;
  }
  return true;
});

function openItemEditor(item) {
  editingItem.value = item || null;
  editorDraft.value = item
    ? { id: item.id, enabled: !!item.enabled, name: item.name || '', format: item.format || 'HEX', data: item.data || '', interval: item.interval ?? null }
    : makeDraft();
  editorVisible.value = true;
}
function closeEditor() {
  editorVisible.value = false;
  editingItem.value = null;
  editorDraft.value = makeDraft();
}
function saveEditor() {
  if (!canSaveEditor.value) return;
  const d = editorDraft.value;
  let finalData = d.data;
  if (d.format === 'HEX') {
    const compact = normalizeHex(d.data);
    const padded = compact.length % 2 ? '0' + compact : compact;
    finalData = padded.match(/.{1,2}/g)?.join(' ') || '';
  }
  if (editingItem.value) {
    const it = items.value.find(x => x.id === editingItem.value.id);
    if (it) {
      it.enabled = d.enabled;
      it.name = d.name || ('未命名-' + it.id);
      it.format = d.format;
      it.data = finalData;
      it.interval = d.interval ?? null;
    }
  } else {
    items.value.push({
      id: uid(),
      enabled: d.enabled,
      name: d.name || ('新条目-' + uid()),
      format: d.format,
      data: finalData,
      interval: d.interval ?? null,
      lastResult: '', lastSendCount: 0, lastError: '',
    });
  }
  closeEditor();
}

/* ============ 发送引擎 ============ */
const sending = ref(false);
const stopRequested = ref(false);
const currentLoop = ref(0);
const currentItem = ref(0);
const totalProgress = ref({ success: 0, fail: 0, total: 0 });
const runState = ref({ itemId: null });

const canStart = computed(() => {
  if (sending.value) return false;
  if (!selectedPort.value) return false;
  if (!checkedItems.value.length) return false;
  if (loopMode.value === 1 && !(loopCount.value > 0)) return false;
  return true;
});
const totalLoopsLabel = computed(() =>
  loopMode.value === 0 ? '1' : (loopMode.value === -1 ? '∞' : loopCount.value)
);
const progressPercent = computed(() => {
  const totalLoops = loopMode.value === 0 ? 1 : (loopMode.value === -1 ? 1 : loopCount.value);
  if (loopMode.value === -1) {
    return Math.min(100, Math.round(((currentItem.value + 1) / Math.max(1, checkedItems.value.length)) * 100));
  }
  const total = Math.max(1, totalLoops * checkedItems.value.length);
  const done = Math.max(0, (currentLoop.value - 1)) * checkedItems.value.length + (currentItem.value + 1);
  return Math.min(100, Math.round((Math.min(total, done) / total) * 100));
});

const sleep = (ms) => new Promise(r => setTimeout(r, Math.max(0, ms | 0)));

async function buildBytesForSend(item) {
  if (item.format === 'ASCII') {
    const s = String(item.data || '');
    const bytes = [];
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      if (code > 0xFF) { bytes.push((code >> 8) & 0xFF); bytes.push(code & 0xFF); }
      else bytes.push(code);
    }
    return bytes.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
  }
  const compact = normalizeHex(item.data);
  if (!compact) return '';
  const padded = compact.length % 2 ? '0' + compact : compact;
  return padded.match(/.{1,2}/g).join(' ');
}
async function sendOneItem(item) {
  const dataStr = await buildBytesForSend(item);
  item.lastSendCount = (item.lastSendCount | 0) + 1;
  totalProgress.value.total++;
  if (!hasElectron) {
    item.lastResult = 'success'; item.lastError = ''; totalProgress.value.success++;
    return true;
  }
  const result = await sendPort({ portPath: selectedPort.value, data: dataStr, format: 'hex' });
  if (result && result.success) {
    item.lastResult = 'success'; item.lastError = ''; totalProgress.value.success++;
    return true;
  }
  item.lastResult = 'fail';
  item.lastError = (result && result.error) ? ' · ' + String(result.error).slice(0, 24) : '';
  totalProgress.value.fail++;
  return false;
}

async function runSendRoutine() {
  sending.value = true;
  stopRequested.value = false;
  currentLoop.value = 0;
  currentItem.value = 0;
  totalProgress.value = { success: 0, fail: 0, total: 0 };
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      currentLoop.value++;
      const list = checkedItems.value.slice();
      for (let i = 0; i < list.length; i++) {
        if (stopRequested.value) return;
        const it = list[i];
        currentItem.value = i;
        runState.value = { itemId: it.id };

        await sendOneItem(it);

        if (stopRequested.value) return;
        const wait = it.interval != null && it.interval >= 0 ? it.interval : itemIntervalMs.value;
        if (wait > 0 && i < list.length - 1) await sleep(wait);
      }
      if (loopMode.value === 0) break;
      if (loopMode.value === 1 && currentLoop.value >= loopCount.value) break;
      if (stopRequested.value) return;
      if (loopIntervalMs.value > 0) await sleep(loopIntervalMs.value);
    }
  } finally {
    sending.value = false;
    stopRequested.value = false;
    runState.value = { itemId: null };
  }
}
function startSend() {
  if (!canStart.value) return;
  items.value.forEach(it => { it.lastResult = ''; it.lastError = ''; });
  runSendRoutine().catch(() => { sending.value = false; });
}
function stopSend() { stopRequested.value = true; }

watch(availablePorts, (ports) => {
  if (ports && ports.length && !selectedPort.value) selectedPort.value = ports[0];
}, { immediate: true });

onBeforeUnmount(() => { stopRequested.value = true; sending.value = false; });
</script>

<style scoped>
/* 嵌入式视图容器 */
.embedded-view {
  height: 100%;
  overflow-y: auto;
  padding-bottom: 20px;
}

/* 模式切换按钮组 */
.mode-toggle-group {
  display: inline-flex;
  gap: 6px;
}

/* 操作按钮组 */
.action-group {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

/* 状态指示器 */
.status-indicator {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-secondary);
}

/* 进度区 */
.progress-section {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--border-color);
}

.progress-meta {
  display: flex;
  gap: 16px;
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 8px;
}

.progress-ok { color: var(--accent-green); }
.progress-err { color: var(--accent-red); }

.progress-bar {
  height: 6px;
  background: var(--bg-hover);
  border-radius: 3px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: var(--accent-amber);
  border-radius: 3px;
  transition: width 0.2s ease;
}

/* 空状态 */
.empty-state {
  text-align: center;
  padding: 48px 20px;
}

.empty-state p {
  color: var(--text-tertiary);
  font-size: 14px;
  margin-bottom: 16px;
}

.empty-actions {
  display: flex;
  gap: 10px;
  justify-content: center;
}

/* 表格 */
.table-wrap {
  overflow-x: auto;
}

.list-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.list-table th {
  text-align: left;
  padding: 8px 10px;
  font-weight: 600;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border-color);
  white-space: nowrap;
}

.list-table td {
  padding: 8px 10px;
  border-bottom: 1px solid var(--border-light);
  vertical-align: middle;
}

.list-table tr:hover td {
  background: var(--bg-hover);
}

.list-table tr.row-active td {
  background: rgba(245, 158, 11, 0.08);
}

.list-table tr.row-ok td {
  background: rgba(16, 185, 129, 0.04);
}

.list-table tr.row-err td {
  background: rgba(239, 68, 68, 0.04);
}

/* 复选框 */
.check-box {
  display: inline-flex;
  align-items: center;
  cursor: pointer;
}

.check-box input {
  cursor: pointer;
}

/* 拖拽手柄 */
.drag-cell {
  cursor: grab;
}

.drag-handle {
  color: var(--text-tertiary);
  font-size: 14px;
  letter-spacing: -2px;
  user-select: none;
}

/* 条目名称输入 */
.name-input {
  width: 100%;
  min-width: 0;
}

/* 格式标签 */
.format-tag {
  display: inline-block;
  padding: 2px 8px;
  border-radius: var(--radius-sm);
  font-size: 11px;
  font-weight: 600;
  font-family: var(--font-mono);
}

.format-tag.hex {
  background: rgba(245, 158, 11, 0.12);
  color: var(--accent-amber);
}

.format-tag.ascii {
  background: rgba(6, 182, 212, 0.12);
  color: var(--accent-cyan, #06b6d4);
}

/* 间隔输入 */
.interval-input {
  width: 80px;
}

/* 数据预览 */
.preview-code {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-secondary);
  word-break: break-all;
}

/* 状态标签 */
.state-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  font-weight: 500;
}

.state-tag.idle {
  background: var(--bg-hover);
  color: var(--text-tertiary);
}

.state-tag.ok {
  background: rgba(16, 185, 129, 0.12);
  color: var(--accent-green);
}

.state-tag.err {
  background: rgba(239, 68, 68, 0.12);
  color: var(--accent-red);
}

.state-tag em {
  font-style: normal;
  font-size: 10px;
  opacity: 0.8;
}

/* 行操作 */
.row-actions {
  display: flex;
  gap: 6px;
}

/* 过渡动画 */
.fade-enter-active, .fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from, .fade-leave-to {
  opacity: 0;
}
</style>
