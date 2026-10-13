<template>
  <div class="embedded-view">
    <!-- 传输配置 -->
    <div class="panel">
      <div class="panel-header">
        <h3>传输配置</h3>
        <div class="panel-header-actions">
          <span>协议 AFT-1 · MTU {{ effectiveMtu }}B · 单帧 {{ chunkSize }}B 数据</span>
        </div>
      </div>
      <div class="panel-body">
        <!-- 串口 -->
        <div class="form-row inline">
          <div>
            <label>目标串口</label>
            <select class="input" v-model="selectedPort" :disabled="transferActive">
              <option value="">— 选择串口 —</option>
              <option v-for="p in portList" :key="p" :value="p">{{ p }}</option>
            </select>
          </div>
          <div>
            <label>波特率</label>
            <select class="input" v-model.number="baudRate" :disabled="transferActive || portOpened">
              <option v-for="b in baudOptions" :key="b" :value="b">{{ b }}</option>
            </select>
          </div>
          <div>
            <label>串口状态</label>
            <div class="port-open-group">
              <button class="btn btn-primary btn-small" :disabled="!selectedPort || portOpened || transferActive" @click="openSelectedPort">
                打开串口
              </button>
              <button class="btn btn-secondary btn-small" :disabled="!selectedPort || !portOpened || transferActive" @click="closeSelectedPort">
                关闭串口
              </button>
              <span class="state-tag" :class="portOpened ? 'ok' : 'idle'">{{ portOpened ? '已打开' : '未打开' }}</span>
            </div>
          </div>
        </div>

        <!-- 分块参数 -->
        <div class="form-row inline">
          <div>
            <label>单帧 MTU (字节)</label>
            <select class="input" v-model.number="mtuPreset" :disabled="transferActive">
              <option v-for="m in mtuPresets" :key="m" :value="m">{{ m }}</option>
              <option :value="-1">自定义</option>
            </select>
          </div>
          <div v-if="mtuPreset === -1">
            <label>自定义 MTU</label>
            <input type="number" class="input" v-model.number="customMtu" min="64" max="1024" step="8" :disabled="transferActive" />
          </div>
          <div>
            <label>滑动窗口 (块)</label>
            <input type="number" class="input" v-model.number="windowSize" min="1" max="32" :disabled="transferActive" />
          </div>
          <div>
            <label>块超时 (ms)</label>
            <input type="number" class="input" v-model.number="timeoutMs" min="100" max="5000" step="50" :disabled="transferActive" />
          </div>
          <div>
            <label>帧间隔 (ms)</label>
            <input type="number" class="input" v-model.number="interFrameDelayMs" min="0" max="100" step="1" :disabled="transferActive" />
          </div>
        </div>

        <!-- 模拟接收端 -->
        <div class="form-row" style="margin-bottom: 0;">
          <label class="mock-toggle">
            <input type="checkbox" v-model="mockEnabled" :disabled="transferActive" />
            模拟接收端（无需硬件，本机回环联调协议）
          </label>
          <template v-if="mockEnabled">
            <span class="mock-slider-label">丢包率 {{ Math.round(mockDropRate * 100) }}%</span>
            <input type="range" class="mock-slider" min="0" max="30" step="1" v-model.number="mockDropPercent" :disabled="transferActive" />
            <button class="btn btn-secondary btn-small" :disabled="transferActive" @click="resetMock">重置模拟端</button>
          </template>
        </div>
        <p class="hint-text" style="margin-top: 8px; margin-bottom: 0;">
          对端（设备固件/下位机）需实现 AFT-1 接收协议，帧格式见页面底部「协议说明」。仅发送数据不校验应答时可使用「调试」页直接发送。
        </p>
      </div>
    </div>

    <!-- OTA 助手 -->
    <div class="panel" style="margin-top: 20px;">
      <div class="panel-header">
        <h3>OTA 助手</h3>
        <div class="panel-header-actions">
          <label class="mock-toggle">
            <input type="checkbox" v-model="ota.enabled" />
            启用（前置/后置指令 + 重连查版本）
          </label>
        </div>
      </div>
      <div v-if="ota.enabled" class="panel-body">
        <div class="form-row inline">
          <div class="ota-cmd-col">
            <label>
              传输前指令（每行一条，如：进入 OTA / 擦除命令）
              <span class="mode-toggle-group ota-fmt">
                <button :class="['btn', 'btn-small', ota.preFormat === 'HEX' ? 'btn-primary' : 'btn-secondary']"
                  @click="ota.preFormat = 'HEX'" type="button">HEX</button>
                <button :class="['btn', 'btn-small', ota.preFormat === 'ASCII' ? 'btn-primary' : 'btn-secondary']"
                  @click="ota.preFormat = 'ASCII'" type="button">ASCII</button>
              </span>
            </label>
            <textarea class="input" v-model="ota.preText" rows="2" :spellcheck="false"
              placeholder="AT+OTA=1&#10;或 A5 5A 01"
              style="resize: vertical; font-family: var(--font-mono);"></textarea>
          </div>
          <div>
            <label>指令间隔 (ms)</label>
            <input type="number" class="input" v-model.number="ota.preDelayMs" min="0" max="60000" step="50" />
          </div>
        </div>

        <div class="form-row inline">
          <div class="ota-cmd-col">
            <label>
              传输后指令（每行一条，如：切换启动标记）
              <span class="mode-toggle-group ota-fmt">
                <button :class="['btn', 'btn-small', ota.postFormat === 'HEX' ? 'btn-primary' : 'btn-secondary']"
                  @click="ota.postFormat = 'HEX'" type="button">HEX</button>
                <button :class="['btn', 'btn-small', ota.postFormat === 'ASCII' ? 'btn-primary' : 'btn-secondary']"
                  @click="ota.postFormat = 'ASCII'" type="button">ASCII</button>
              </span>
            </label>
            <textarea class="input" v-model="ota.postText" rows="2" :spellcheck="false"
              placeholder="AT+OTA_SWITCH"
              style="resize: vertical; font-family: var(--font-mono);"></textarea>
          </div>
          <div>
            <label>指令间隔 (ms)</label>
            <input type="number" class="input" v-model.number="ota.postDelayMs" min="0" max="60000" step="50" />
          </div>
        </div>

        <div class="form-row" style="margin-bottom: 0;">
          <label class="mock-toggle">
            <input type="checkbox" v-model="ota.autoVerify" />
            传输完成后自动重连查版本
          </label>
          <label class="mock-toggle">
            <input type="checkbox" v-model="ota.asciiCrlf" />
            ASCII 指令自动追加 \r\n
          </label>
        </div>

        <template v-if="ota.autoVerify">
          <div class="form-row inline">
            <div>
              <label>重启等待 (ms)</label>
              <input type="number" class="input" v-model.number="ota.rebootWaitMs" min="0" max="120000" step="500" />
            </div>
            <div>
              <label>应答监听 (ms)</label>
              <input type="number" class="input" v-model.number="ota.watchMs" min="200" max="60000" step="200" />
            </div>
            <div class="ota-cmd-col">
              <label>
                查询指令（重连后发送，可留空只监听）
                <span class="mode-toggle-group ota-fmt">
                  <button :class="['btn', 'btn-small', ota.queryFormat === 'HEX' ? 'btn-primary' : 'btn-secondary']"
                    @click="ota.queryFormat = 'HEX'" type="button">HEX</button>
                  <button :class="['btn', 'btn-small', ota.queryFormat === 'ASCII' ? 'btn-primary' : 'btn-secondary']"
                    @click="ota.queryFormat = 'ASCII'" type="button">ASCII</button>
                </span>
              </label>
              <input type="text" class="input" v-model="ota.queryText" placeholder="AT+VERSION?" />
            </div>
          </div>
          <div class="form-row">
            <div class="ota-cmd-col">
              <label>期望应答包含（关键字，留空只记录不校验）</label>
              <input type="text" class="input" v-model="ota.expected" placeholder="如 OK 或 V1.4.2" />
            </div>
          </div>
        </template>

        <p class="hint-text" style="margin-top: 8px; margin-bottom: 0;">
          执行顺序：前置指令 → AFT-1 文件传输 → 后置指令 → 关闭串口等待重启 → 重开串口 → 查询指令 → 监听应答并校验关键字。
          仅真实串口模式生效；模拟回环时自动跳过指令阶段。配置自动保存在本机。
        </p>
      </div>
    </div>

    <!-- 传输文件 -->
    <div class="panel" style="margin-top: 20px;">
      <div class="panel-header">
        <h3>传输文件</h3>
        <div class="panel-header-actions" v-if="fileInfo">
          <span>CRC32 {{ fileInfo.crc32Hex }}</span>
          <span>{{ fileInfo.sizeText }}</span>
        </div>
      </div>
      <div class="panel-body">
        <!-- 拖拽/选择区 -->
        <div
          v-if="!fileInfo"
          class="dropzone"
          :class="{ 'drop-hover': dropHover }"
          @dragover.prevent="dropHover = true"
          @dragleave.prevent="dropHover = false"
          @drop.prevent="onDropFile"
          @click="browseFile"
        >
          <div class="dropzone-icon">
            <svg width="36" height="36" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#i-folder"/></svg>
          </div>
          <p class="dropzone-title">拖拽文件到此处，或点击浏览</p>
          <p class="dropzone-desc">支持二进制 / 文本文件（固件、配置、日志等），单文件上限 64 MB</p>
        </div>

        <!-- 已选文件卡片 -->
        <div v-else class="file-card">
          <div class="file-card-icon">
            <svg width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#i-file-text"/></svg>
          </div>
          <div class="file-card-info">
            <b class="file-card-name" :title="fileInfo.path">{{ fileInfo.name }}</b>
            <span class="file-card-meta">
              {{ fileInfo.sizeText }} · {{ totalBlocks }} 块（{{ chunkSize }}B/块）
              <template v-if="fileInfo.mtimeText"> · 修改于 {{ fileInfo.mtimeText }}</template>
            </span>
            <span v-if="fileInfo.large" class="file-card-warn">文件较大，传输耗时较长，建议提高 MTU 并保持窗口 ≥ 8</span>
          </div>
          <button class="btn btn-secondary btn-small" :disabled="transferActive" @click="clearFile">移除</button>
        </div>
      </div>
    </div>

    <!-- 传输控制 -->
    <div class="panel" style="margin-top: 20px;">
      <div class="panel-header">
        <h3>传输控制</h3>
        <div class="panel-header-actions">
          <span class="state-tag" :class="displayStateClass">{{ displayStateText }}</span>
        </div>
      </div>
      <div class="panel-body">
        <div class="action-group">
          <button class="btn btn-primary" :disabled="!canStart" @click="startTransfer">开始传输</button>
          <button class="btn btn-secondary" :disabled="stats.state !== 'transfer'" @click="pauseTransfer">暂停</button>
          <button class="btn btn-secondary" :disabled="stats.state !== 'paused'" @click="resumeTransfer">继续</button>
          <button class="btn btn-danger" :disabled="!transferActive" @click="cancelTransfer">取消</button>
        </div>

        <!-- 进度 -->
        <div v-if="stats.totalBlocks > 0 || stats.state !== 'idle'" class="progress-section">
          <div class="progress-meta">
            <span>{{ stats.ackedBlocks }} / {{ stats.totalBlocks }} 块</span>
            <span>{{ percentText }}</span>
            <span>速率 {{ speedText }}</span>
            <span>已用 {{ elapsedText }}</span>
            <span>剩余 {{ etaText }}</span>
            <span class="progress-err" v-if="stats.retransmitCount > 0">重传 {{ stats.retransmitCount }}</span>
            <span class="progress-ok" v-if="stats.state === 'done'">✓ 校验通过</span>
          </div>
          <div class="progress-bar">
            <div class="progress-fill" :class="{ 'fill-done': stats.state === 'done' }" :style="{ width: stats.percent + '%' }"></div>
          </div>
          <div class="progress-sub err" v-if="stats.state === 'error'">✗ {{ stats.errorMessage }}</div>
          <div class="progress-sub muted" v-else-if="stats.resumeFrom > 0 && stats.state !== 'done'">
            断点续传：已跳过接收端已有的前 {{ stats.resumeFrom }} 块
          </div>
        </div>

        <!-- 传输日志 -->
        <div class="ft-log-header">
          <span>传输日志</span>
          <label class="mock-toggle" style="font-size: 12px;">
            <input type="checkbox" v-model="autoScroll" /> 自动滚动
          </label>
          <button class="btn btn-secondary btn-small" @click="logs = []">清空</button>
        </div>
        <div class="ft-log" ref="logEl">
          <div v-for="entry in logs" :key="entry.id" class="ft-log-line" :class="'lv-' + entry.level">{{ entry.text }}</div>
          <div v-if="!logs.length" class="ft-log-empty">暂无日志</div>
        </div>
      </div>
    </div>

    <!-- 协议说明 -->
    <div class="panel" style="margin-top: 20px;">
      <div class="panel-body" style="padding-top: 14px; padding-bottom: 14px;">
        <details class="proto-doc">
          <summary>协议说明：AFT-1 串口文件传输协议（对接固件必读）</summary>
          <div class="proto-doc-body">
            <p>帧格式（所有多字节字段为<b>小端</b>），单帧总长 ≤ MTU：</p>
            <table class="proto-table">
              <thead><tr><th>偏移</th><th>长度</th><th>字段</th><th>说明</th></tr></thead>
              <tbody>
                <tr><td>0</td><td>2</td><td>0xA5 0x5A</td><td>帧头魔数</td></tr>
                <tr><td>2</td><td>1</td><td>TYPE</td><td>帧类型</td></tr>
                <tr><td>3</td><td>1</td><td>SEQ</td><td>帧序号（调试用）</td></tr>
                <tr><td>4</td><td>2</td><td>LEN</td><td>PAYLOAD 字节数</td></tr>
                <tr><td>6</td><td>LEN</td><td>PAYLOAD</td><td>帧内容</td></tr>
                <tr><td>6+LEN</td><td>2</td><td>CRC16</td><td>CRC-16/CCITT-FALSE，对偏移 2 起（TYPE..PAYLOAD）计算</td></tr>
              </tbody>
            </table>
            <p>帧类型：</p>
            <table class="proto-table">
              <thead><tr><th>方向</th><th>TYPE</th><th>名称</th><th>PAYLOAD</th><th>说明</th></tr></thead>
              <tbody>
                <tr><td>→</td><td>0x01</td><td>FILE_BEGIN</td><td>ver u8 · chunk u16 · fileSize u32 · totalBlocks u32 · fileCrc32 u32 · nameLen u8 · name</td><td>发起/续传握手</td></tr>
                <tr><td>→</td><td>0x02</td><td>DATA</td><td>blockIdx u32 + 数据块</td><td>块数据，末块可短</td></tr>
                <tr><td>→</td><td>0x03</td><td>FILE_END</td><td>fileCrc32 u32</td><td>请求最终校验</td></tr>
                <tr><td>→</td><td>0x04</td><td>CANCEL</td><td>discard u8（1=丢弃已收数据）</td><td>取消传输</td></tr>
                <tr><td>←</td><td>0x10</td><td>READY</td><td>mode u8 · resumeFrom u32</td><td>应答握手；mode=1 且 resumeFrom&gt;0 表示断点续传位置</td></tr>
                <tr><td>←</td><td>0x11</td><td>ACK</td><td>blockIdx u32</td><td>单块确认（重复 DATA 需重复 ACK）</td></tr>
                <tr><td>←</td><td>0x12</td><td>RESEND</td><td>count u16 + blockIdx[count]</td><td>缺失块清单（单帧装不下拆多帧）</td></tr>
                <tr><td>←</td><td>0x13</td><td>FINAL</td><td>status u8（0=OK 1=CRC不符 2=版本不支持 3=无会话）</td><td>最终结果</td></tr>
                <tr><td>←</td><td>0x14</td><td>CANCEL_ACK</td><td>空</td><td>取消确认</td></tr>
              </tbody>
            </table>
            <p>接收端要点：逐字节状态机找魔数解析 → DATA 按 blockIdx×chunk 写入并 ACK（重复块覆盖重发）→ FILE_END 时若有缺失回 RESEND、收齐后校验整包 CRC32 回 FINAL → 断点续传按「文件名|大小|CRC32」保存进度。参考实现见 <code>src/renderer/utils/fileTransferProtocol.js</code>（内置模拟接收端）。</p>
          </div>
        </details>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import { useSerial } from '../composables/useSerial';
import {
  FRAME_OVERHEAD, MIN_MTU, MAX_MTU,
  crc32, MockReceiver, formatSpeed, formatDuration, formatBytes,
} from '../utils/fileTransferProtocol';
import { FileTransferSender, SENDER_STATE } from '../utils/fileTransferSender';

const { availablePorts, hasElectron, openPort, closePort, sendPort, onData, onError, refreshPorts } = useSerial();
const portList = computed(() => availablePorts.value || []);

/* ============ 串口配置 ============ */
const selectedPort = ref('');
const baudRate = ref(115200);
const baudOptions = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];
const portOpened = ref(false);

async function refreshOpenState() {
  if (!hasElectron || !window.electronAPI.serial?.active) { portOpened.value = false; return; }
  try {
    const active = await window.electronAPI.serial.active();
    portOpened.value = !!selectedPort.value && active.includes(selectedPort.value);
  } catch { portOpened.value = false; }
}

async function openSelectedPort() {
  if (!selectedPort.value) return;
  const result = await openPort({
    path: selectedPort.value,
    baudRate: baudRate.value,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
  });
  if (result.success) {
    portOpened.value = true;
    pushLog('ok', `串口 ${selectedPort.value} 已打开 @ ${baudRate.value}`);
  } else {
    portOpened.value = false;
    pushLog('err', `打开串口失败: ${result.error || '未知错误'}`);
  }
}

async function closeSelectedPort() {
  if (!selectedPort.value) return;
  const result = await closePort(selectedPort.value);
  if (result && result.success) {
    portOpened.value = false;
    pushLog('info', `串口 ${selectedPort.value} 已关闭`);
  } else {
    pushLog('err', `关闭串口失败: ${result?.error || '未知错误'}`);
  }
  refreshOpenState();
}

watch(selectedPort, () => { refreshOpenState(); });

/* ============ 分块参数 ============ */
const mtuPresets = [64, 128, 256, 512, 1024];
const mtuPreset = ref(256);
const customMtu = ref(512);
const windowSize = ref(8);
const timeoutMs = ref(600);
const interFrameDelayMs = ref(0);

const effectiveMtu = computed(() => {
  const raw = mtuPreset.value === -1 ? customMtu.value : mtuPreset.value;
  return Math.min(MAX_MTU, Math.max(MIN_MTU, Math.floor(raw) || MIN_MTU));
});
const chunkSize = computed(() => effectiveMtu.value - FRAME_OVERHEAD);

/* ============ 模拟接收端 ============ */
const mockEnabled = ref(false);
const mockDropPercent = ref(0);
const mockDropRate = computed(() => Math.min(0.5, mockDropPercent.value / 100));
const mock = new MockReceiver({
  onEvent: (level, msg) => pushLog(level === 'ok' ? 'ok' : level === 'err' ? 'err' : 'info', msg),
});
watch(mockDropRate, (v) => { mock.dropRate = v; });

function resetMock() {
  mock.reset();
  pushLog('info', '模拟接收端已重置（清空断点数据）');
}

/* ============ OTA 助手 ============ */
const OTA_STORAGE_KEY = 'alvan-ota-assistant-v1';
const OTA_DEFAULTS = {
  enabled: false,
  preText: '', preFormat: 'HEX', preDelayMs: 300,
  postText: '', postFormat: 'HEX', postDelayMs: 300,
  autoVerify: false, rebootWaitMs: 3000, watchMs: 2000,
  queryText: '', queryFormat: 'ASCII', expected: '',
  asciiCrlf: true,
};

function loadOtaSettings() {
  try {
    const raw = localStorage.getItem(OTA_STORAGE_KEY);
    return raw ? { ...OTA_DEFAULTS, ...JSON.parse(raw) } : { ...OTA_DEFAULTS };
  } catch { return { ...OTA_DEFAULTS }; }
}

const ota = ref(loadOtaSettings());
watch(ota, (v) => {
  try { localStorage.setItem(OTA_STORAGE_KEY, JSON.stringify(v)); } catch { /* 忽略 */ }
}, { deep: true });

const runBusy = ref(false);          // 整个编排流程（前置→传输→后置→校验）进行中
const phaseNote = ref('');           // 编排阶段提示（状态标签显示）
let otaRunToken = 0;                 // 取消令牌：++ 即中断前置/后置/校验阶段

const sleep = (ms) => new Promise(r => setTimeout(r, Math.max(0, ms | 0)));

/** 可被取消按钮打断的等待 */
async function otaSleep(ms) {
  const token = otaRunToken;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (otaRunToken !== token) throw new Error('已取消');
    await sleep(100);
  }
}

function normalizeHexText(text) {
  if (!text) return '';
  return String(text).trim().split(/\s+/).map(t => t.replace(/^0[xX]/, '')).join('').toUpperCase();
}

function asciiToHex(content) {
  const bytes = [];
  for (const ch of String(content)) {
    const code = ch.codePointAt(0);
    if (code > 0xFF) { bytes.push((code >> 8) & 0xFF, code & 0xFF); } else bytes.push(code);
  }
  if (ota.value.asciiCrlf) bytes.push(0x0D, 0x0A);
  return bytes.map(b => b.toString(16).padStart(2, '0')).join(' ');
}

/** 发送一条 OTA 指令（自动转 HEX 串走串口） */
async function sendOtaCommand(content, format, label) {
  let hexStr;
  if (format === 'HEX') {
    const compact = normalizeHexText(content);
    if (!compact || compact.length % 2 !== 0 || !/^[0-9A-F]+$/.test(compact)) {
      throw new Error(`${label} HEX 指令无效: ${content}`);
    }
    hexStr = compact.match(/.{1,2}/g).join(' ');
  } else {
    if (!String(content).length) throw new Error(`${label} 指令为空`);
    hexStr = asciiToHex(content);
  }
  const r = await sendPort({ portPath: selectedPort.value, data: hexStr, format: 'hex' });
  if (!r || !r.success) throw new Error(r?.error || '串口发送失败');
  const preview = format === 'HEX' ? hexStr : JSON.stringify(String(content)) + (ota.value.asciiCrlf ? ' +\\r\\n' : '');
  pushLog('info', `${label}指令 → ${preview}`);
}

/** 按行批量发送指令块；fatal=false 时单条失败仅告警并继续 */
async function sendCommandBlock(text, format, delayMs, label, { fatal = true } = {}) {
  const lines = String(text || '').split('\n').map(s => s.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    try {
      await sendOtaCommand(lines[i], format, label);
    } catch (e) {
      pushLog(fatal ? 'err' : 'warn', `${label}指令失败: ${e.message}`);
      if (fatal) throw e;
      continue;
    }
    if (i < lines.length - 1 && delayMs > 0) await otaSleep(delayMs);
  }
}

/* 应答监听：OTA 校验阶段把选中串口的 RX 收集起来做关键字检查 */
const rxMonitor = ref({ active: false, chunks: [] });

function bytesToAscii(bytes) {
  let s = '';
  for (const b of bytes) {
    s += (b >= 0x20 && b < 0x7F) ? String.fromCharCode(b) : (b === 0x0D || b === 0x0A ? '\n' : '·');
  }
  return s;
}

/** 传输完成后：关串口 → 等重启 → 重开 → 发查询指令 → 监听应答 → 校验关键字 */
async function runOtaVerify() {
  if (portOpened.value) {
    try { await closePort(selectedPort.value); } catch { /* 忽略 */ }
    portOpened.value = false;
    pushLog('info', '已关闭串口，等待设备重启…');
  }
  await otaSleep(Math.max(0, ota.value.rebootWaitMs | 0));

  await refreshPorts();
  if (!(availablePorts.value || []).includes(selectedPort.value)) {
    pushLog('warn', `重启后未找到 ${selectedPort.value}，当前可用端口: ${(availablePorts.value || []).join(', ') || '无'}`);
  }

  let reopened = false;
  for (let attempt = 1; attempt <= 2 && !reopened; attempt++) {
    const r = await openPort({ path: selectedPort.value, baudRate: baudRate.value, dataBits: 8, stopBits: 1, parity: 'none' });
    reopened = !!(r && r.success);
    if (reopened) {
      portOpened.value = true;
      pushLog('ok', `串口已重连 @ ${baudRate.value}`);
    } else {
      pushLog('warn', `重连失败（第 ${attempt} 次）: ${r?.error || '未知错误'}，2s 后重试`);
      await otaSleep(2000);
      await refreshPorts();
    }
  }
  if (!reopened) {
    pushLog('err', '重连失败，跳过版本校验');
    return;
  }

  rxMonitor.value = { active: true, chunks: [] };
  try {
    if (String(ota.value.queryText || '').trim()) {
      await otaSleep(500);   // 给设备就绪时间
      await sendOtaCommand(ota.value.queryText, ota.value.queryFormat, '查询');
    }
    await otaSleep(Math.max(200, ota.value.watchMs | 0));
  } finally {
    rxMonitor.value.active = false;
  }

  const text = rxMonitor.value.chunks.map(bytesToAscii).join('');
  if (!text) {
    pushLog('warn', '应答监听窗口内未收到任何数据');
    if (ota.value.expected) pushLog('err', `✗ 未找到期望关键字「${ota.value.expected}」`);
    return;
  }
  const shown = text.replace(/\n+/g, ' | ');
  pushLog('info', `设备应答（ASCII）: ${shown.length > 200 ? shown.slice(0, 200) + '…' : shown}`);
  if (ota.value.expected) {
    if (text.includes(ota.value.expected)) {
      pushLog('ok', `✓ 版本校验通过：应答包含「${ota.value.expected}」`);
    } else {
      pushLog('err', `✗ 应答未包含期望关键字「${ota.value.expected}」，请人工确认固件版本`);
    }
  }
}

/* ============ 文件选择 ============ */
const fileInfo = ref(null);   // { name, path, size, sizeText, data, crc32, crc32Hex, mtimeText, large }
const dropHover = ref(false);

function decodeBase64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function applyFileResult(res) {
  if (!res) return;
  if (res.canceled) return;
  if (!res.success) {
    pushLog('err', `读取文件失败: ${res.error || '未知错误'}`);
    return;
  }
  const data = decodeBase64(res.base64);
  const sum = crc32(data);
  fileInfo.value = {
    name: res.name,
    path: res.filePath,
    size: res.size,
    sizeText: formatBytes(res.size),
    data,
    crc32: sum,
    crc32Hex: '0x' + sum.toString(16).toUpperCase().padStart(8, '0'),
    mtimeText: res.mtimeMs ? new Date(res.mtimeMs).toLocaleString('zh-CN', { hour12: false }) : '',
    large: res.size > 8 * 1024 * 1024,
  };
  pushLog('info', `已加载文件「${res.name}」${formatBytes(res.size)}，CRC32=${fileInfo.value.crc32Hex}`);
}

async function browseFile() {
  if (!hasElectron || !window.electronAPI.fileTransfer?.pickFile) {
    pushLog('err', '当前环境不支持文件选择（需要 Electron）');
    return;
  }
  try { applyFileResult(await window.electronAPI.fileTransfer.pickFile()); }
  catch (e) { pushLog('err', `选择文件失败: ${e.message}`); }
}

async function onDropFile(e) {
  dropHover.value = false;
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  if (!hasElectron || !window.electronAPI.fileTransfer?.readFile) {
    pushLog('err', '当前环境不支持拖拽读取（需要 Electron）');
    return;
  }
  let path = '';
  try { path = window.electronAPI.fileTransfer.getPathForFile(file); }
  catch { path = file.path || ''; }
  if (!path) {
    pushLog('err', '无法获取拖拽文件路径，请使用「点击浏览」选择');
    return;
  }
  try { applyFileResult(await window.electronAPI.fileTransfer.readFile(path)); }
  catch (e) { pushLog('err', `读取文件失败: ${e.message}`); }
}

function clearFile() {
  fileInfo.value = null;
  pushLog('info', '已移除待发送文件');
}

const totalBlocks = computed(() => {
  if (!fileInfo.value) return 0;
  return fileInfo.value.size > 0 ? Math.ceil(fileInfo.value.size / chunkSize.value) : 0;
});

/* ============ 传输引擎 ============ */
const logs = ref([]);
let logId = 0;
const logEl = ref(null);
const autoScroll = ref(true);

function pushLog(level, text) {
  logs.value.push({ id: ++logId, level, text });
  if (logs.value.length > 500) logs.value.splice(0, logs.value.length - 500);
  if (autoScroll.value) {
    requestAnimationFrame(() => {
      if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight;
    });
  }
}

const state = ref(SENDER_STATE.IDLE);
const stats = ref(emptyStats());
let latestStats = emptyStats();
let sender = null;
let uiFlushTimer = null;
let dataFrameLogCount = 0;

function emptyStats() {
  return {
    state: SENDER_STATE.IDLE, percent: 0, totalBlocks: 0, ackedBlocks: 0, inFlight: 0,
    ackedBytes: 0, fileSize: 0, resumeFrom: 0, retransmitCount: 0, syncRounds: 0,
    resendRounds: 0, speed: 0, activeMs: 0, etaMs: Infinity, errorMessage: '',
  };
}

const engineActive = computed(() =>
  [SENDER_STATE.HANDSHAKE, SENDER_STATE.TRANSFER, SENDER_STATE.FINALIZE].includes(state.value));
/** 引擎活跃或 OTA 编排流程（前置/后置/校验阶段）进行中 */
const transferActive = computed(() => runBusy.value || engineActive.value);
const canStart = computed(() => {
  if (transferActive.value || state.value === SENDER_STATE.PAUSED) return false;
  if (!fileInfo.value) return false;
  if (!mockEnabled.value && !portOpened.value) return false;
  return true;
});

const stateTextMap = {
  [SENDER_STATE.IDLE]: '待命',
  [SENDER_STATE.HANDSHAKE]: '握手中…',
  [SENDER_STATE.TRANSFER]: '传输中',
  [SENDER_STATE.FINALIZE]: '校验收尾中…',
  [SENDER_STATE.DONE]: '传输完成',
  [SENDER_STATE.ERROR]: '传输失败',
  [SENDER_STATE.CANCELLED]: '已取消',
  [SENDER_STATE.PAUSED]: '已暂停',
};
const stateClassMap = {
  [SENDER_STATE.IDLE]: 'idle',
  [SENDER_STATE.HANDSHAKE]: 'busy',
  [SENDER_STATE.TRANSFER]: 'busy',
  [SENDER_STATE.FINALIZE]: 'busy',
  [SENDER_STATE.DONE]: 'ok',
  [SENDER_STATE.ERROR]: 'err',
  [SENDER_STATE.CANCELLED]: 'idle',
  [SENDER_STATE.PAUSED]: 'busy',
};
const stateText = computed(() => stateTextMap[state.value] || state.value);
const stateClass = computed(() => stateClassMap[state.value] || 'idle');

/* 编排阶段提示优先显示在状态标签上（如「发送 OTA 前置指令…」） */
const displayStateText = computed(() => (runBusy.value && phaseNote.value) ? phaseNote.value : stateText.value);
const displayStateClass = computed(() => (runBusy.value && phaseNote.value) ? 'busy' : stateClass.value);

const percentText = computed(() => {
  if (stats.value.fileSize > 0) {
    return `${formatBytes(stats.value.ackedBytes)} / ${formatBytes(stats.value.fileSize)}（${stats.value.percent}%）`;
  }
  return stats.value.state === SENDER_STATE.DONE ? '空文件传输完成' : '0%';
});
const speedText = computed(() => formatSpeed(stats.value.speed));
const elapsedText = computed(() => formatDuration(stats.value.activeMs));
const etaText = computed(() => stats.value.state === SENDER_STATE.DONE ? '0s' : formatDuration(stats.value.etaMs));

/* ---- 传输介质：真实串口 / 模拟回环 ---- */
function hexToBytes(hex) {
  const clean = (hex || '').replace(/[^0-9a-fA-F]/g, '');
  const len = clean.length & ~1;
  const out = new Uint8Array(len / 2);
  for (let i = 0; i < len; i += 2) out[i / 2] = parseInt(clean.substr(i, 2), 16);
  return out;
}

function makeTransport() {
  if (mockEnabled.value) {
    return {
      send: (bytes) => {
        setTimeout(() => {
          const replies = mock.feed(bytes);
          if (replies.length) {
            setTimeout(() => {
              for (const r of replies) { if (sender) sender.consumeLinkBytes(r); }
            }, mock.latencyMs);
          }
        }, mock.latencyMs);
      },
    };
  }
  return {
    send: async (bytes) => {
      const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(' ');
      const r = await sendPort({ portPath: selectedPort.value, data: hex, format: 'hex' });
      if (!r || !r.success) throw new Error(r?.error || '串口发送失败');
    },
  };
}

/** 引擎一次完整传输（含握手→数据→收尾），resolve(是否成功) */
function runEngineTransfer() {
  return new Promise((resolve, reject) => {
    if (sender) { sender.dispose(); sender = null; }
    sender = new FileTransferSender({
      send: makeTransport().send,
      options: {
        mtu: effectiveMtu.value,
        windowSize: Math.min(32, Math.max(1, windowSize.value | 0)),
        timeoutMs: Math.min(5000, Math.max(100, timeoutMs.value | 0)),
        interFrameDelayMs: Math.min(100, Math.max(0, interFrameDelayMs.value | 0)),
      },
      onState: (s) => {
        state.value = s;
        if ([SENDER_STATE.DONE, SENDER_STATE.ERROR, SENDER_STATE.CANCELLED].includes(s)) {
          resolve(s === SENDER_STATE.DONE);
        }
      },
      onProgress: (p) => { latestStats = p; },
      onLog: (level, msg) => pushLog(level, msg),
      onFrame: (dir, typeName, len) => {
        // DATA 帧量太大按 1/32 抽样记录，控制帧全记
        if (typeName === 'DATA') {
          dataFrameLogCount++;
          if (dataFrameLogCount % 32 !== 1) return;
        }
        pushLog('info', `${dir === 'tx' ? '→ 发送' : '← 收到'} ${typeName}（${len}B）`);
      },
    });
    if (!mockEnabled.value) {
      pushLog('info', `通过 ${selectedPort.value} @ ${baudRate.value} 发送`);
    }
    sender.start({ name: fileInfo.value.name, data: fileInfo.value.data }).catch(reject);
  });
}

/** 编排入口：前置指令 → 传输 → 后置指令 → 重连校验 */
async function startTransfer() {
  if (!canStart.value || !fileInfo.value) return;
  runBusy.value = true;
  const token = ++otaRunToken;
  const useOta = ota.value.enabled && !mockEnabled.value;
  try {
    if (ota.value.enabled && mockEnabled.value) {
      pushLog('info', 'OTA 助手已启用：模拟回环模式跳过指令阶段，仅执行传输');
    }
    if (useOta && String(ota.value.preText || '').trim()) {
      phaseNote.value = '发送 OTA 前置指令…';
      await sendCommandBlock(ota.value.preText, ota.value.preFormat, ota.value.preDelayMs, '前置', { fatal: true });
    }
    phaseNote.value = '';
    const ok = await runEngineTransfer();
    if (ok && useOta) {
      if (String(ota.value.postText || '').trim()) {
        phaseNote.value = '发送 OTA 后置指令…';
        await sendCommandBlock(ota.value.postText, ota.value.postFormat, ota.value.postDelayMs, '后置', { fatal: false });
      }
      if (ota.value.autoVerify) {
        phaseNote.value = '重连并校验设备版本…';
        await runOtaVerify();
      }
    }
  } catch (e) {
    if (otaRunToken !== token) {
      pushLog('warn', 'OTA 流程已取消');
    } else {
      pushLog('err', `OTA 流程中止: ${e.message}`);
    }
  } finally {
    runBusy.value = false;
    phaseNote.value = '';
  }
}

function pauseTransfer() { sender?.pause(); }
function resumeTransfer() { sender?.resume(); }

function cancelTransfer() {
  if (sender && [SENDER_STATE.HANDSHAKE, SENDER_STATE.TRANSFER, SENDER_STATE.FINALIZE, SENDER_STATE.PAUSED].includes(state.value)) {
    sender.cancel(false);
    return;
  }
  otaRunToken++;   // 中断前置/后置/校验阶段的等待
  if (runBusy.value) pushLog('warn', '正在取消 OTA 流程…');
}

/* UI 以 ~10fps 节流刷新进度，避免 40fps 全量重渲染 */
function startUiFlush() {
  if (uiFlushTimer) return;
  uiFlushTimer = setInterval(() => {
    stats.value = { ...latestStats };
    if (![SENDER_STATE.HANDSHAKE, SENDER_STATE.TRANSFER, SENDER_STATE.FINALIZE].includes(state.value)) {
      clearInterval(uiFlushTimer);
      uiFlushTimer = null;
    }
  }, 100);
}

/* ============ 串口数据接线 ============ */
let unsubData = null;
let unsubError = null;

function handleSerialData(d) {
  if (d?.port !== selectedPort.value) return;
  const bytes = hexToBytes(d.hex);
  /* OTA 校验阶段：先收集应答供关键字检查 */
  if (rxMonitor.value.active && bytes.length) {
    rxMonitor.value.chunks.push(bytes);
  }
  if (!sender || !engineActive.value) return;
  if (mockEnabled.value) return;                       // 模拟模式不经真实串口
  sender.consumeLinkBytes(bytes);
}

function handleSerialError(d) {
  if (sender && engineActive.value && d?.port === selectedPort.value) {
    sender.failExternal(`串口异常: ${d.error || '未知错误'}`);
  }
  refreshOpenState();
}

watch(state, (s) => {
  if ([SENDER_STATE.HANDSHAKE, SENDER_STATE.TRANSFER, SENDER_STATE.FINALIZE].includes(s)) {
    startUiFlush();
  }
});

onMounted(() => {
  refreshOpenState();
  unsubData = onData(handleSerialData);
  unsubError = onError(handleSerialError);
});

onBeforeUnmount(() => {
  otaRunToken++;   // 中断 OTA 编排等待
  sender?.cancel(true);
  sender?.dispose();
  sender = null;
  if (uiFlushTimer) { clearInterval(uiFlushTimer); uiFlushTimer = null; }
  unsubData?.();
  unsubError?.();
});
</script>

<style scoped>
.embedded-view {
  height: 100%;
  overflow-y: auto;
  padding-bottom: 20px;
}

/* 表单行内的串口开关组合 */
.port-open-group {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

/* 模拟接收端开关行 */
.mock-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-secondary);
  cursor: pointer;
  margin-right: 12px;
}

.mock-toggle input {
  cursor: pointer;
}

.mock-slider {
  width: 140px;
  accent-color: var(--accent-amber);
}

.mock-slider-label {
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
}

/* OTA 助手 */
.ota-cmd-col {
  flex: 1;
  min-width: 0;
}

.ota-fmt {
  margin-left: 10px;
  display: inline-flex;
  vertical-align: middle;
}

.hint-text {
  font-size: 12px;
  color: var(--text-tertiary);
  line-height: 1.6;
}

/* 拖拽选择区 */
.dropzone {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 36px 20px;
  border: 2px dashed var(--border-color);
  border-radius: var(--radius-md);
  background: var(--bg-secondary);
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}

.dropzone:hover,
.dropzone.drop-hover {
  border-color: var(--accent-amber);
  background: rgba(245, 158, 11, 0.05);
}

.dropzone-icon {
  color: var(--accent-amber);
  line-height: 0;
}

.dropzone-title {
  font-size: 14px;
  color: var(--text-primary);
  font-weight: 600;
  margin: 0;
}

.dropzone-desc {
  font-size: 12px;
  color: var(--text-tertiary);
  margin: 0;
}

/* 已选文件卡片 */
.file-card {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 16px;
  border: 1px solid var(--border-light);
  border-radius: var(--radius-md);
  background: var(--bg-secondary);
}

.file-card-icon {
  color: var(--text-secondary);
  line-height: 0;
  flex-shrink: 0;
}

.file-card-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.file-card-name {
  font-size: 14px;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-card-meta {
  font-size: 12px;
  color: var(--text-tertiary);
}

.file-card-warn {
  font-size: 12px;
  color: var(--accent-amber);
}

/* 操作按钮组 */
.action-group {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

/* 进度区（与列表发送页风格一致） */
.progress-section {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--border-color);
}

.progress-meta {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
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
  transition: width 0.15s linear;
}

.progress-fill.fill-done {
  background: var(--accent-green);
}

.progress-sub.err {
  margin-top: 8px;
  font-size: 12px;
  color: var(--accent-red);
}

.progress-sub.muted {
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-tertiary);
}

/* 传输日志 */
.ft-log-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--border-color);
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
}

.ft-log-header .mock-toggle {
  font-weight: 400;
  margin-right: auto;
}

.ft-log {
  margin-top: 8px;
  height: 220px;
  overflow-y: auto;
  background: var(--bg-secondary);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-md);
  padding: 8px 10px;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.7;
}

.ft-log-line.lv-info { color: var(--text-secondary); }
.ft-log-line.lv-ok { color: var(--accent-green); }
.ft-log-line.lv-warn { color: var(--accent-amber); }
.ft-log-line.lv-err { color: var(--accent-red); }

.ft-log-empty {
  color: var(--text-tertiary);
  text-align: center;
  padding-top: 80px;
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

.state-tag.busy {
  background: rgba(245, 158, 11, 0.12);
  color: var(--accent-amber);
}

/* 协议说明 */
.proto-doc summary {
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  user-select: none;
}

.proto-doc summary:hover {
  color: var(--text-primary);
}

.proto-doc-body {
  margin-top: 12px;
  font-size: 12.5px;
  color: var(--text-secondary);
  line-height: 1.7;
}

.proto-doc-body p {
  margin: 10px 0 6px;
}

.proto-doc-body code {
  font-family: var(--font-mono);
  background: var(--bg-hover);
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 11.5px;
}

.proto-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  margin: 6px 0 10px;
}

.proto-table th,
.proto-table td {
  border: 1px solid var(--border-light);
  padding: 5px 8px;
  text-align: left;
  vertical-align: top;
}

.proto-table th {
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-weight: 600;
  white-space: nowrap;
}

.proto-table td {
  color: var(--text-tertiary);
}

.proto-table td:nth-child(4),
.proto-table td:last-child {
  color: var(--text-secondary);
}
</style>
