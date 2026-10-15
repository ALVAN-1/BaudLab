<template>
  <!-- 数据/数据库保存目录选择器：更新时内嵌询问，用户可浏览改为自定义文件夹 -->
  <div v-if="supported" class="ddp">
    <div class="ddp-label">数据与数据库保存目录</div>
    <div class="dirpick-row">
      <input
        v-model="dir"
        class="dirpick-input"
        type="text"
        spellcheck="false"
        placeholder="选择协议数据与数据库保存的文件夹"
        @keyup.enter="save"
      />
      <button type="button" class="dirpick-btn" :disabled="busy" @click="browse">浏览</button>
      <button type="button" class="dirpick-btn primary" :disabled="busy || !dir.trim()" @click="save">保存</button>
    </div>
    <div class="dirpick-hint" :class="{ ok, err }">{{ hint }}</div>
    <button v-if="requireRestart" type="button" class="ddp-restart" :disabled="busy" @click="relaunch">
      立即重启应用使新目录生效
    </button>
  </div>
</template>

<script setup>
/* 编辑协议产生的数据文件与数据库（serial_protocol.db 及草稿/配置/令牌）
 * 默认落在应用数据目录。此处允许用户浏览改到自定义文件夹：
 *   - 浏览 → 系统文件夹选择器（data-dir:choose）
 *   - 保存 → 主进程校验、用 VACUUM INTO 迁移一致性快照 + 复制其余数据文件、
 *             写指针文件；数据库句柄在启动时已绑定，所以需重启应用才生效。
 * 行内样式（.dirpick-*）定义在 styles.css 里全局共用，
 * 「创建团队」的数据目录弹窗复用同一套。
 * 环境不支持（无 electronAPI）时整体不渲染，避免在纯 web 预览里出现无效控件。 */
import { computed, onMounted, ref } from 'vue';

const DEFAULT_HINT = '编辑协议的数据文件与数据库会保存到这里；切换后需重启应用生效';

const dir = ref('');
const busy = ref(false);
const hint = ref(DEFAULT_HINT);
const ok = ref(false);
const err = ref(false);
const requireRestart = ref(false);

const supported = computed(() =>
  typeof window !== 'undefined' && !!(window.electronAPI && window.electronAPI.dataDir)
);
const api = () => window.electronAPI.dataDir;

function reset() {
  hint.value = DEFAULT_HINT;
  ok.value = false;
  err.value = false;
  requireRestart.value = false;
}

async function load() {
  if (!supported.value) return;
  try {
    const r = await api().get();
    if (r && r.success) dir.value = r.dataDir || '';
  } catch { /* 读取失败不打断更新流程，保留占位让用户手动填写 */ }
}

async function browse() {
  if (!supported.value || busy.value) return;
  try {
    const r = await api().choose();
    if (r && r.success && r.path) {
      dir.value = r.path;
      reset();
    }
  } catch { /* 用户取消或系统对话框调用失败 */ }
}

async function save() {
  if (!supported.value || busy.value || !dir.value.trim()) return;
  busy.value = true;
  reset();
  try {
    const r = await api().set(dir.value);
    if (!r || !r.success) {
      err.value = true;
      hint.value = (r && r.error) || '保存失败，请重试';
    } else if (r.changed === false) {
      ok.value = true;
      hint.value = '当前已是该目录，无需更改';
    } else {
      ok.value = true;
      dir.value = r.dataDir;
      requireRestart.value = true;
      const notes = Array.isArray(r.notes) && r.notes.length ? `（${r.notes.join('；')}）` : '';
      hint.value = `已保存${notes}，重启应用后生效`;
    }
  } catch (e) {
    err.value = true;
    hint.value = String(e.message || e);
  } finally {
    busy.value = false;
  }
}

async function relaunch() {
  if (!supported.value || busy.value) return;
  try { await api().relaunch(); }
  catch { /* 主进程退出失败时由用户手动重启即可 */ }
}

onMounted(load);
</script>

<style scoped>
.ddp {
  display: flex;
  flex-direction: column;
  gap: 8px;
  text-align: left;
  padding-top: 12px;
  border-top: 1px dashed var(--border-light);
}

.ddp-label {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-primary);
}

.ddp-restart {
  align-self: flex-start;
  padding: 0;
  font-size: 12.5px;
  color: var(--accent);
  background: none;
  border: none;
  cursor: pointer;
}

.ddp-restart:hover { text-decoration: underline; }
</style>
