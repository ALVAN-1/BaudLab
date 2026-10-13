<template>
  <div class="view">
    <div class="view-header">
      <div>
        <h1 class="view-title">串口通信</h1>
        <p class="view-subtitle">多串口监控 · 列表发送 · 文件传输</p>
      </div>
      <div class="view-actions">
        <button v-show="activeTab === 'debug'" class="btn btn-secondary" @click="clearAllLogs">清空全部日志</button>
        <button v-show="activeTab === 'debug'" class="btn btn-primary" @click="addSession">新建连接</button>
      </div>
    </div>

    <!-- 子页签切换 -->
    <div class="tab-bar">
      <button :class="['tab-btn', { active: activeTab === 'debug' }]" @click="activeTab = 'debug'">
        <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#i-serial"/></svg>
        调试
      </button>
      <button :class="['tab-btn', { active: activeTab === 'list' }]" @click="activeTab = 'list'">
        <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#i-list"/></svg>
        列表发送
      </button>
      <button :class="['tab-btn', { active: activeTab === 'file' }]" @click="activeTab = 'file'">
        <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#i-file-send"/></svg>
        文件发送
      </button>
    </div>

    <!-- 调试（子标签切换带过渡动效：out-in 避免两页同帧叠放造成布局跳动） -->
    <Transition name="tab-fade" mode="out-in">
      <div v-show="activeTab === 'debug'" class="debugger-layout">
      <div class="subwindow-container">
        <div
          v-for="session in sessions"
          :key="session.id"
          class="subwindow"
          :class="{ 'collapsed-left': session.leftCollapsed }"
        >
          <!-- 子窗口头 -->
          <div class="subwindow-header">
            <div class="subwindow-title">
              <span class="status-dot" :class="{ connected: session.open }"></span>
              <code :class="{ 'port-empty': !session.port }">{{ session.port || 'None' }}</code>
              <span v-if="session.viaMcp" class="mcp-badge" title="此连接由外部 AI 客户端经 MCP 打开：终端实时显示 AI 的收发数据">MCP</span>
              <span v-if="session.open" style="font-size: 11px; color: var(--text-tertiary);">{{ session.baud }} bps</span>
            </div>
            <div class="subwindow-stats-inline">
              <span class="stat-rx" title="接收字节">RX: {{ session.rx }}</span>
              <span class="stat-tx" title="发送字节">TX: {{ session.tx }}</span>
              <span class="stat-fps" title="帧速率">FPS: {{ session.fps }}</span>
              <span class="stat-err error" title="错误帧">ERR: {{ session.err }}</span>
            </div>
            <div class="subwindow-tools">
              <button
                class="subwindow-tool btn-toggle-left"
                title="收起/展开左侧栏"
                @click="session.leftCollapsed = !session.leftCollapsed"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 17l-5-5 5-5M19 17l-5-5 5-5"/></svg>
              </button>
              <button
                class="subwindow-tool btn-clear-sublog"
                title="清空日志"
                @click="clearSessionLog(session)"
              >
                <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#i-trash"/></svg>
              </button>
              <button
                class="subwindow-tool close btn-close-subwindow"
                title="关闭窗口"
                @click="removeSession(session.id)"
              >✕</button>
            </div>
          </div>

          <!-- 子窗口体 -->
          <div class="subwindow-body">
            <!-- 左侧参数区 -->
            <div class="subwindow-left" :class="{ collapsed: session.leftCollapsed }">
              <!-- Panel: 端口参数 -->
              <div class="panel collapsible" :class="{ collapsed: session.panel1Collapsed }">
                <div
                  class="panel-header"
                  data-collapse
                  @click="session.panel1Collapsed = !session.panel1Collapsed"
                >
                  <h3>端口参数</h3>
                  <button
                    class="panel-toggle"
                    title="收起/展开"
                    type="button"
                    @click.stop="session.panel1Collapsed = !session.panel1Collapsed"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
                  </button>
                </div>
                <div class="panel-body">
                  <div class="form-row">
                    <label>串口号</label>
                    <select class="input port-select" v-model="session.port">
                      <option v-if="availablePorts.length === 0" value="" disabled>未检测到串口</option>
                      <option v-for="p in availablePorts" :key="p" :value="p">{{ p }}</option>
                    </select>
                  </div>
                  <div class="form-row">
                    <label>波特率</label>
                    <div class="baud-wrapper">
                      <select class="input baud-select" v-model="session.baudSelect" @change="onBaudChange(session)">
                        <option value="9600">9600</option>
                        <option value="19200">19200</option>
                        <option value="38400">38400</option>
                        <option value="57600">57600</option>
                        <option value="115200">115200</option>
                        <option value="921600">921600</option>
                        <option value="custom">自定义</option>
                      </select>
                      <input
                        v-if="session.baudSelect === 'custom'"
                        type="number"
                        class="input baud-custom"
                        v-model.number="session.baud"
                        placeholder="自定义"
                      >
                    </div>
                  </div>
                  <div class="form-row inline">
                    <div>
                      <label>数据位</label>
                      <select class="input small" v-model="session.dataBits">
                        <option :value="8">8</option>
                        <option :value="7">7</option>
                      </select>
                    </div>
                    <div>
                      <label>校验</label>
                      <select class="input small" v-model="session.parity">
                        <option value="none">None</option>
                        <option value="even">Even</option>
                        <option value="odd">Odd</option>
                      </select>
                    </div>
                    <div>
                      <label>停止位</label>
                      <select class="input small" v-model="session.stopBits">
                        <option :value="1">1</option>
                        <option :value="2">2</option>
                      </select>
                    </div>
                  </div>
                  <button
                    :class="['btn', 'btn-connect', session.open ? 'btn-danger' : 'btn-primary']"
                    @click="toggleConnection(session)"
                  >{{ session.open ? '断开连接' : '连接串口' }}</button>
                </div>
              </div>

              <!-- Panel: 当前协议 -->
              <div class="panel collapsible" :class="{ collapsed: session.panel2Collapsed }">
                <div
                  class="panel-header"
                  data-collapse
                  @click="session.panel2Collapsed = !session.panel2Collapsed"
                >
                  <h3>当前协议</h3>
                  <button
                    class="panel-toggle"
                    title="收起/展开"
                    type="button"
                    @click.stop="session.panel2Collapsed = !session.panel2Collapsed"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
                  </button>
                </div>
                <div class="panel-body">
                  <div class="form-row">
                    <label>选择协议</label>
                    <select class="input protocol-select" v-model="session.selectedProtocol" @change="onProtocolChange(session)">
                      <option v-for="name in dbProtocolNames" :key="name" :value="name">{{ name }}</option>
                    </select>
                  </div>
                  <div class="protocol-meta" v-if="session.selectedProtocol">
                    <div class="meta-row"><span>版本</span><code>{{ dbProtocolMeta[session.selectedProtocol]?.version || '-' }}</code></div>
                    <div class="meta-row"><span>审核状态</span><code>{{ dbProtocolMeta[session.selectedProtocol]?.auditStatus || '-' }}</code></div>
                  </div>
                </div>
              </div>
            </div>

            <!-- 右侧日志区 -->
            <div class="subwindow-right">
              <!-- Panel: 发送帧配置 -->
              <div class="panel frame-builder-panel">
                <div class="panel-header">
                  <h3>发送帧配置</h3>
                  <select class="input cmd-select" v-model="session.selectedCmd" @change="onCmdChange(session)">
                    <option
                      v-for="cmd in getProtocol(session)?.cmds || []"
                      :key="cmd.cmd"
                      :value="cmd.cmd"
                    >0x{{ cmdCodeHex(session, cmd) }} — {{ cmd.name }}</option>
                  </select>
                </div>
                <div class="panel-body">
                  <div class="frame-fields" v-if="getCurrentCmd(session)?.fields?.length > 0">
                    <template v-for="(field, fi) in getCurrentCmd(session).fields" :key="fi">
                      <!-- 位域字段 -->
                      <div class="frame-field bitmap-field" v-if="field.type === 'bitmap'">
                        <div class="field-header">
                          <span class="field-name">{{ field.name }}</span>
                        </div>
                        <div class="bit-group">
                          <label
                            v-for="bit in field.bits"
                            :key="bit.bit"
                            class="bit-toggle"
                            :title="bit.name"
                          >
                            <input
                              type="checkbox"
                              class="bit-checkbox"
                              :checked="getBitValue(session, fi, bit.bit) === 1"
                              @change="toggleBit(session, fi, bit.bit, $event)"
                            >
                            <span class="bit-name">{{ bit.name }} (bit{{ bit.bit }})</span>
                            <span class="bit-value">{{ getBitValue(session, fi, bit.bit) }}</span>
                          </label>
                        </div>
                      </div>

                      <!-- 枚举字段 -->
                      <div class="frame-field enum-field" v-else-if="field.type === 'enum'">
                        <div class="field-header">
                          <span class="field-name">{{ field.name }}</span>
                        </div>
                        <select
                          class="input enum-select"
                          :value="getEnumValue(session, fi)"
                          @change="setEnumValue(session, fi, $event)"
                        >
                          <option
                            v-for="opt in field.options"
                            :key="opt.value"
                            :value="opt.value"
                          >0x{{ opt.value.toString(16).padStart(2, '0').toUpperCase() }} — {{ opt.label }}</option>
                        </select>
                      </div>

                      <!-- 数值字段 -->
                      <div class="frame-field number-field" v-else>
                        <div class="field-header">
                          <span class="field-name">{{ field.name }}</span>
                        </div>
                        <div class="number-inputs">
                          <div
                            class="byte-input-group"
                            v-for="(b, bi) in getFieldBytes(session, fi)"
                            :key="bi"
                          >
                            <label>{{ getByteLabel(field.length, bi) }}</label>
                            <input
                              type="text"
                              class="input byte-input"
                              maxlength="4"
                              placeholder="00"
                              :value="b"
                              @input="setFieldByte(session, fi, bi, $event)"
                            >
                          </div>
                        </div>
                        <div class="value-row" v-if="field.scale">
                          <label>物理值</label>
                          <input
                            type="number"
                            class="input value-input"
                            :value="getPhysicalValue(session, fi, field)"
                            :step="field.scale"
                            @input="setPhysicalValue(session, fi, field, $event.target.value)"
                          >
                        </div>
                      </div>
                    </template>
                  </div>

                  <!-- 帧预览 -->
                  <div class="frame-preview">
                    <div class="frame-preview-header">
                      <label>帧预览</label>
                      <button class="btn btn-secondary btn-load-frame" @click="loadFrameToSend(session)">加入发送</button>
                    </div>
                    <div class="frame-bytes">
                      <div
                        v-for="(byte, i) in buildFrame(session)"
                        :key="i"
                        class="byte-box"
                        :class="{ highlight: byte.highlight }"
                      >
                        <span class="byte">{{ byte.hex }}</span>
                        <span class="byte-idx">{{ i }}</span>
                        <span class="byte-meaning" :title="byte.meaning">{{ byte.meaning }}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <!-- Panel: 通信日志 -->
              <div class="panel subwindow-terminal">
                <div class="panel-header">
                  <h3>通信日志</h3>
                  <div class="terminal-tools">
                    <button
                      class="tool-btn"
                      :class="{ active: session.logMode === 'hex' }"
                      @click="session.logMode = 'hex'"
                    >HEX</button>
                    <button
                      class="tool-btn"
                      :class="{ active: session.logMode === 'ascii' }"
                      @click="session.logMode = 'ascii'"
                    >ASCII</button>
                    <button
                      class="tool-btn"
                      :class="{ active: session.parseEnabled }"
                      @click="toggleParse(session)"
                    >解析</button>
                    <label class="checkbox">
                      <input type="checkbox" class="auto-scroll" v-model="session.autoScroll">
                      <span>自动滚动</span>
                    </label>
                    <button class="tool-btn fullscreen-btn" title="放大查看日志" @click="openFullscreenLog(session)">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 00-2 2v3M21 8V5a2 2 0 00-2-2h-3M3 16v3a2 2 0 002 2h3M16 21h3a2 2 0 002-2v-3"/></svg>
                    </button>
                  </div>
                </div>
                <div class="terminal" :ref="el => setTerminalRef(el, session.id)">
                  <div
                    v-for="(line, i) in session.terminalLines"
                    :key="i"
                    class="terminal-line"
                    :class="[line.dir, line.type || '']"
                  >
                    <div class="line-row">
                      <span class="line-time">{{ line.time }}</span>
                      <span class="line-dir">{{ formatTerminalDir(line) }}</span>
                      <span
                        class="line-data"
                        :class="{ 'frame-hover': session.parseEnabled && (line.dir === 'tx' || line.dir === 'rx') }"
                        @mouseenter="session.parseEnabled && (line.dir === 'tx' || line.dir === 'rx') && showSegCard($event, buildFrameParse(session, line))"
                        @mousemove="moveSegCard"
                        @mouseleave="hideSegCard"
                      >{{ formatTerminalData(line, session.logMode) }}</span>
                      <span class="line-desc" v-if="line.desc">{{ line.desc }}</span>
                    </div>
                  </div>
                </div>
              </div>

              <!-- Terminal input -->
              <div class="terminal-input">
                <select class="input send-mode" v-model="session.sendMode">
                  <option value="HEX">HEX</option>
                  <option value="ASCII">ASCII</option>
                </select>
                <input
                  type="text"
                  class="input send-input"
                  :class="{ invalid: !!sendInputError(session) }"
                  :title="sendInputError(session)"
                  v-model="session.sendInput"
                  placeholder="输入要发送的数据..."
                  @keydown.enter="sendData(session)"
                >
                <div class="newline-wrapper">
                  <select class="input newline-select" v-model="session.newlineMode">
                    <option value="none">无换行</option>
                    <option value="cr">\r</option>
                    <option value="lf">\n</option>
                    <option value="crlf">\r\n</option>
                  </select>
                </div>
                <button
                  class="btn btn-primary btn-send"
                  @click="sendData(session)"
                  :disabled="!session.open"
                >发送</button>
                <div class="cycle-wrapper">
                  <input
                    type="number"
                    class="input cycle-interval"
                    v-model.number="session.cycleInterval"
                    min="10"
                    step="10"
                  >
                  <span class="cycle-unit">ms</span>
                  <button
                    :class="['btn', session.cycle ? 'btn-danger' : 'btn-secondary', 'btn-cycle']"
                    @click="toggleCycle(session)"
                  >{{ session.cycle ? '停止循环' : '循环发送' }}</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    </Transition>

    <!-- 信号解析悬浮卡片 -->
    <Teleport to="body">
      <div
        v-if="segCard.visible"
        class="seg-card"
        :style="{ left: segCard.x + 'px', top: segCard.y + 'px' }"
      >
        <div class="seg-card-title">{{ segCard.title }}</div>
        <table class="seg-card-table">
          <thead>
            <tr>
              <th class="seg-card-head">字段</th>
              <th class="seg-card-head raw">原始值</th>
              <th class="seg-card-head parsed">解析值</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="(g, gi) in segCard.groups" :key="gi">
              <tr class="seg-card-row group">
                <td class="seg-card-label">{{ g.name }}</td>
                <td class="seg-card-raw">{{ g.raw }}</td>
                <td class="seg-card-value">{{ g.parsed }}</td>
              </tr>
              <tr v-for="(c, ci) in g.children || []" :key="gi + '-' + ci" class="seg-card-row child">
                <td class="seg-card-label">{{ c.label }}</td>
                <td class="seg-card-raw">{{ c.raw || '—' }}</td>
                <td class="seg-card-value">{{ c.parsed }}</td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </Teleport>

    <!-- 列表发送 -->
    <Transition name="tab-fade" mode="out-in">
      <ListSendView v-show="activeTab === 'list'" />
    </Transition>

    <!-- 文件发送 -->
    <Transition name="tab-fade" mode="out-in">
      <FileSendView v-show="activeTab === 'file'" />
    </Transition>

    <!-- 通信日志全屏遮罩 -->
    <Transition name="modal-fade">
      <div v-if="fullscreenLogSession" class="log-fullscreen-overlay" @click.self="closeFullscreenLog">
        <div class="log-fullscreen-container">
          <div class="panel-header">
            <h3>通信日志 — {{ fullscreenLogSession.port || '会话' }}</h3>
            <div class="terminal-tools">
              <button
                class="tool-btn"
                :class="{ active: fullscreenLogSession.logMode === 'hex' }"
                @click="fullscreenLogSession.logMode = 'hex'"
              >HEX</button>
              <button
                class="tool-btn"
                :class="{ active: fullscreenLogSession.logMode === 'ascii' }"
                @click="fullscreenLogSession.logMode = 'ascii'"
              >ASCII</button>
              <button
                class="tool-btn"
                :class="{ active: fullscreenLogSession.parseEnabled }"
                @click="toggleParse(fullscreenLogSession)"
              >解析</button>
              <label class="checkbox">
                <input type="checkbox" class="auto-scroll" v-model="fullscreenLogSession.autoScroll">
                <span>自动滚动</span>
              </label>
              <button class="tool-btn" title="关闭全屏" @click="closeFullscreenLog">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v3a2 2 0 01-2 2H3M21 8h-3a2 2 0 01-2-2V3M3 16h3a2 2 0 012 2v3M16 21v-3a2 2 0 012-2h3"/></svg>
              </button>
            </div>
          </div>
          <div class="terminal log-fullscreen-terminal" :ref="el => setFullscreenTerminalRef(el)">
            <div
              v-for="(line, i) in fullscreenLogSession.terminalLines"
              :key="i"
              class="terminal-line"
              :class="[line.dir, line.type || '']"
            >
              <div class="line-row">
                <span class="line-time">{{ line.time }}</span>
                <span class="line-dir">{{ formatTerminalDir(line) }}</span>
                <span
                  class="line-data"
                  :class="{ 'frame-hover': fullscreenLogSession.parseEnabled && (line.dir === 'tx' || line.dir === 'rx') }"
                  @mouseenter="fullscreenLogSession.parseEnabled && (line.dir === 'tx' || line.dir === 'rx') && showSegCard($event, buildFrameParse(fullscreenLogSession, line))"
                  @mousemove="moveSegCard"
                  @mouseleave="hideSegCard"
                >{{ formatTerminalData(line, fullscreenLogSession.logMode) }}</span>
                <span class="line-desc" v-if="line.desc">{{ line.desc }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<script setup>
import { ref, reactive, nextTick, onMounted, onUnmounted, watch } from 'vue';
import { useSerial } from '../composables/useSerial';
import { useLogSettings } from '../composables/useLogSettings';
import { protocolDefinitions, crc16, sumCheck, formatTime, getByteLabel } from '../data/protocolDefinitions';
import ListSendView from './ListSendView.vue';
import FileSendView from './FileSendView.vue';

const activeTab = ref('debug');

const emit = defineEmits(['connection-change']);

const props = defineProps({
  active: { type: Boolean, default: false },
});

const { availablePorts, hasElectron, refreshPorts, openPort, closePort, sendPort, onData, onError, onPortsChanged, onMcpOpened, onMcpClosed, onMcpTx, getMcpPorts } = useSerial();

/* 从数据库加载的协议名称列表 */
const dbProtocolNames = ref([]);
const dbProtocolMeta = ref({});
const protocols = ref({ ...protocolDefinitions });

let nextSessionId = 2;
const terminalRefs = {};

/**
 * 创建新调试会话
 * 初始化所有会话状态字段，使用静态分配，禁止动态内存
 */
function createSession(opts = {}) {
  return reactive({
    id: `session-${nextSessionId++}`,
    port: opts.port || '',
    baud: opts.baud || 115200,
    baudSelect: opts.baudSelect || '115200',
    dataBits: 8,
    parity: 'none',
    stopBits: 1,
    open: opts.open || false,
    viaMcp: opts.viaMcp || false,
    cycle: false,
    cycleInterval: 1000,
    cycleTimer: null,
    rx: opts.rx || 0,
    tx: opts.tx || 0,
    fps: 0,
    err: opts.err || 0,
    terminalLines: opts.terminalLines || [],
    selectedProtocol: '',
    selectedCmd: 0x01,
    sendMode: 'HEX',
    sendInput: '',
    newlineMode: 'crlf',
    autoScroll: true,
    logMode: 'hex',
    parseEnabled: false,
    leftCollapsed: false,
    panel1Collapsed: false,
    panel2Collapsed: false,
    fieldValues: {},
  });
}

// 初始会话：默认未连接状态，等待用户手动打开串口
const sessions = ref([createSession()]);

/* ==================== 终端 DOM 引用与滚动 ==================== */

function setTerminalRef(el, sessionId) {
  if (el) terminalRefs[sessionId] = el;
}

function scrollToBottom(sessionId) {
  nextTick(() => {
    const el = terminalRefs[sessionId];
    if (el) el.scrollTop = el.scrollHeight;
  });
}

/* ==================== 通信日志全屏 ==================== */
const fullscreenLogSession = ref(null);
let fullscreenTerminalEl = null;

function setFullscreenTerminalRef(el) {
  fullscreenTerminalEl = el;
}

function openFullscreenLog(session) {
  fullscreenLogSession.value = session;
  nextTick(() => {
    if (fullscreenTerminalEl) {
      fullscreenTerminalEl.scrollTop = fullscreenTerminalEl.scrollHeight;
    }
  });
}

function closeFullscreenLog() {
  fullscreenLogSession.value = null;
  fullscreenTerminalEl = null;
}

function onFullscreenKeydown(e) {
  if (e.key === 'Escape' && fullscreenLogSession.value) {
    closeFullscreenLog();
  }
}

/* ==================== DB → 协议定义映射 ==================== */

/**
 * 将 DB commands 表中的字段结构映射为 DebuggerView 期望的格式
 * DB: { type: 'bitfield', bits: [{bit, zero, one}] }
 *     { type: 'enum', enumItems: [{value, meaning}] }
 *     { type: 'raw', rawValue: '00' }
 * 视图期望: { type: 'bitmap', bits: [{bit, name}] }
 *           { type: 'enum', options: [{value, label}] }
 *           { type: 'uint8', length: 1 }
 */
function mapDbFieldToProtoField(field) {
  if (field.type === 'bitfield') {
    return {
      name: field.name,
      type: 'bitmap',
      length: field.length || 1,
      bits: (field.bits || []).map(b => ({ bit: b.bit, name: b.one || b.zero || `bit${b.bit}` })),
    };
  }
  if (field.type === 'enum') {
    return {
      name: field.name,
      type: 'enum',
      length: field.length || 1,
      options: (field.enumItems || []).map(item => ({
        value: parseInt(item.value, 16) || 0,
        label: item.meaning || item.value,
      })),
    };
  }
  if (field.type === 'number') {
    const encMap = { uint8: 1, int8: 1, uint16: 2, int16: 2, uint32: 4, int32: 4, float32: 4, float64: 8 };
    const len = encMap[field.encoding] || field.length || 2;
    const isSigned = (field.encoding || '').startsWith('int') || (field.encoding || '').startsWith('float');
    return {
      name: field.name,
      type: 'number',
      encoding: field.encoding || 'uint16',
      length: len,
      scale: field.scale != null ? field.scale : 1,
      signed: isSigned,
      unit: field.unit || '',
    };
  }
  if (field.type === 'text') {
    return {
      name: field.name,
      type: 'text',
      lengthMode: field.lengthMode || 'varlen-field',
      lengthField: field.lengthField || 'len',
      length: field.length || 0,
      delimiter: field.delimiter || '',
      encoding: field.encoding || 'utf8',
      format: field.format || 'raw',
    };
  }
  if (field.type === 'binary') {
    return {
      name: field.name,
      type: 'binary',
      lengthMode: field.lengthMode || 'varlen-rest',
      lengthField: field.lengthField || 'len',
      length: field.length || 0,
      delimiter: field.delimiter || '',
      encoding: field.encoding || 'hex',
    };
  }
  /* 兼容旧 raw 类型 */
  const rawParts = (field.rawValue || '00').trim().split(/\s+/);
  return {
    name: field.name,
    type: 'number',
    encoding: 'uint8',
    length: rawParts.length || 1,
    scale: 1,
    signed: false,
    unit: '',
  };
}

/**
 * 从数据库协议行 + config_json 构建协议定义对象
 * 匹配 protocolDefinitions 中的静态格式
 */
function buildProtoDefFromDB(protoRow, protoConfig) {
  const fieldConfig = protoConfig.fieldConfig || {};

  /* 帧头：SOF 字段的 defaults */
  const sofCfg = fieldConfig.sof;
  const frameHeader = (sofCfg && sofCfg.enabled && sofCfg.defaults)
    ? sofCfg.defaults.map(h => parseInt(h, 16) || 0)
    : [];

  /* 帧尾：EOF 字段的 defaults */
  const eofCfg = fieldConfig.eof;
  const frameTail = (eofCfg && eofCfg.enabled && eofCfg.defaults)
    ? eofCfg.defaults.map(h => parseInt(h, 16) || 0)
    : [];

  /* 校验类型映射：CRC* → 'CRC16', 其他 → 'SUM' */
  const checkMethod = protoConfig.checkType || protoRow.check_method || 'CRC16-MODBUS';
  const checkType = checkMethod.includes('CRC') ? 'CRC16' : 'SUM';

  /* 地址：从 SRC 字段提取，默认 0x01 */
  let address = 0x01;
  const srcCfg = fieldConfig.src;
  if (srcCfg && srcCfg.enabled && srcCfg.defaults && srcCfg.defaults.length > 0) {
    address = parseInt(srcCfg.defaults[0], 16) || 0x01;
  }

  /* 命令字节数：CMD 字段 byteCount（1/2/3/自定义），默认 1 */
  let cmdLen = 1;
  const cmdCfg = fieldConfig.cmd;
  if (cmdCfg && cmdCfg.enabled) {
    cmdLen = cmdCfg.byteCount === 'custom'
      ? (parseInt(cmdCfg.customCount, 10) || 1)
      : (parseInt(cmdCfg.byteCount, 10) || 1);
  }

  return {
    frameHeader,
    frameTail,
    checkType,
    address,
    cmdLen,
    cmds: [],
  };
}

/* ==================== 协议/命令辅助 ==================== */

function getProtocol(session) {
  return protocols.value[session.selectedProtocol];
}

function getCurrentCmd(session) {
  const proto = getProtocol(session);
  if (!proto) return null;
  const cmdVal = typeof session.selectedCmd === 'string'
    ? parseInt(session.selectedCmd)
    : session.selectedCmd;
  return proto.cmds.find(c => c.cmd === cmdVal);
}

/**
 * 命令码显示（不含 0x 前缀）：按协议 CMD 字节数补零
 * 如 CMD 2 字节: 0x440 → "0440"
 */
function cmdCodeHex(session, cmd) {
  const cmdLen = getProtocol(session)?.cmdLen || 1;
  return cmd.cmd.toString(16).toUpperCase().padStart(cmdLen * 2, '0');
}

/**
 * 协议切换：重置命令字为该协议第一个命令，清空字段值
 */
function onProtocolChange(session) {
  const proto = getProtocol(session);
  if (proto && proto.cmds.length > 0) {
    session.selectedCmd = proto.cmds[0].cmd;
  }
  session.fieldValues = {};
}

/**
 * 命令字切换：清空字段值
 */
function onCmdChange(session) {
  session.fieldValues = {};
}

/* ==================== 字段值操作 ==================== */

/**
 * 获取位域某一位的值 (0/1)
 * 位操作：右移后与 1 进行与运算
 */
function getBitValue(session, fieldIndex, bit) {
  const key = `field_${fieldIndex}`;
  const val = session.fieldValues[key] || 0;
  return (val >> bit) & 1;
}

/**
 * 切换位域某一位
 * 置位：val |= (1 << bit)
 * 清位：val &= ~(1 << bit)
 */
function toggleBit(session, fieldIndex, bit, event) {
  const key = `field_${fieldIndex}`;
  let val = session.fieldValues[key] || 0;
  if (event.target.checked) {
    val |= (1 << bit);
  } else {
    val &= ~(1 << bit);
  }
  session.fieldValues[key] = val;
}

function getEnumValue(session, fieldIndex) {
  const key = `field_${fieldIndex}`;
  return session.fieldValues[key] || 0;
}

function setEnumValue(session, fieldIndex, event) {
  const key = `field_${fieldIndex}`;
  session.fieldValues[key] = parseInt(event.target.value);
}

/**
 * 获取数值字段的各字节显示值 (0xNN 格式)
 * 大端序：高字节在前
 */
function getFieldBytes(session, fieldIndex) {
  const key = `field_${fieldIndex}`;
  const val = session.fieldValues[key] || 0;
  const cmd = getCurrentCmd(session);
  if (!cmd || !cmd.fields[fieldIndex]) return [];
  const len = cmd.fields[fieldIndex].length;
  const bytes = [];
  for (let i = 0; i < len; i++) {
    const shift = (len - 1 - i) * 8;
    const byteVal = (val >> shift) & 0xFF;
    bytes.push(byteVal.toString(16).padStart(2, '0').toUpperCase());
  }
  return bytes;
}

/**
 * 设置数值字段的某个字节
 * 输入实时校验：仅保留十六进制字符（支持 "0x" 前缀），最多两位
 * 非法字符（如 "S3" 中的 S）在输入瞬间即被过滤，不会残留在输入框
 * 位操作：先清除目标字节位置，再写入新值
 */
function setFieldByte(session, fieldIndex, byteIndex, event) {
  const raw = event.target.value;
  const prefix = /^0x/i.test(raw) ? '0x' : '';
  const body = raw.replace(/^0x/i, '').toUpperCase().replace(/[^0-9A-F]/g, '').slice(0, 2);
  /* 强制同步 DOM：清洗结果与派生值一致时 Vue 不会重渲染，需手动回写防止非法字符残留 */
  if (raw !== prefix + body) event.target.value = prefix + body;
  if (body.length === 0) return;
  const byteVal = parseInt(body, 16);
  if (isNaN(byteVal)) return;
  const key = `field_${fieldIndex}`;
  let val = session.fieldValues[key] || 0;
  const cmd = getCurrentCmd(session);
  if (!cmd || !cmd.fields[fieldIndex]) return;
  const len = cmd.fields[fieldIndex].length;
  const shift = (len - 1 - byteIndex) * 8;
  val = (val & ~(0xFF << shift)) | ((byteVal & 0xFF) << shift);
  session.fieldValues[key] = val;
}

/**
 * 获取物理值 = 原始值 × 缩放系数
 * 支持有符号数（二补码转换）
 */
function getPhysicalValue(session, fieldIndex, field) {
  const val = session.fieldValues[`field_${fieldIndex}`] || 0;
  if (field.signed && val > Math.pow(2, field.length * 8 - 1)) {
    return parseFloat(((val - Math.pow(2, field.length * 8)) * field.scale).toFixed(2));
  }
  return parseFloat((val * field.scale).toFixed(2));
}

/**
 * 设置物理值：反向计算原始值 = 物理值 / 缩放系数
 * 边界检查：限制在字段长度允许的范围内
 */
function setPhysicalValue(session, fieldIndex, field, value) {
  if (value === '' || isNaN(parseFloat(value))) return;
  const key = `field_${fieldIndex}`;
  const physicalVal = parseFloat(value);
  let rawVal = physicalVal / field.scale;
  const max = Math.pow(2, field.length * 8) - 1;
  rawVal = Math.max(0, Math.min(Math.round(rawVal), max));
  session.fieldValues[key] = rawVal;
}

/* ==================== 帧构建 ==================== */

/**
 * 构建完整帧的字节数组（带标注）
 * 帧结构: 帧头 + 地址 + 命令字 + 长度 + 载荷 + 校验 + 帧尾
 * 校验范围: 地址 + 命令字 + 长度 + 载荷 (不含帧头帧尾)
 */
function buildFrame(session) {
  const proto = getProtocol(session);
  if (!proto) return [];
  const cmd = getCurrentCmd(session);
  if (!cmd) return [];

  const bytes = [];

  // 帧头
  proto.frameHeader.forEach(b => bytes.push({
    hex: b.toString(16).padStart(2, '0').toUpperCase(),
    meaning: '帧头',
    highlight: true,
  }));

  // 地址
  bytes.push({
    hex: proto.address.toString(16).padStart(2, '0').toUpperCase(),
    meaning: '地址',
    highlight: false,
  });

  // 命令字（按 CMD 字节数展开，大端序：高字节在前，与配置页 cmdBytes 顺序一致）
  const cmdLen = proto.cmdLen || 1;
  const cmdBytesArr = [];
  for (let i = cmdLen - 1; i >= 0; i--) {
    cmdBytesArr.push((cmd.cmd >> (i * 8)) & 0xFF);
  }
  cmdBytesArr.forEach(b => bytes.push({
    hex: b.toString(16).padStart(2, '0').toUpperCase(),
    meaning: 'CMD',
    highlight: false,
  }));

  // 载荷（从字段值构建）
  const payload = [];
  if (cmd.fields) {
    cmd.fields.forEach((field, fi) => {
      const val = session.fieldValues[`field_${fi}`] || 0;
      for (let i = 0; i < field.length; i++) {
        const shift = (field.length - 1 - i) * 8;
        payload.push((val >> shift) & 0xFF);
      }
    });
  }

  // 长度字节
  bytes.push({
    hex: payload.length.toString(16).padStart(2, '0').toUpperCase(),
    meaning: '长度',
    highlight: false,
  });

  // 数据载荷
  payload.forEach(b => bytes.push({
    hex: b.toString(16).padStart(2, '0').toUpperCase(),
    meaning: '数据',
    highlight: false,
  }));

  // 校验计算范围: 地址 + 命令字（全部字节）+ 长度 + 载荷
  const checkBytes = [];
  checkBytes.push(proto.address);
  cmdBytesArr.forEach(b => checkBytes.push(b));
  checkBytes.push(payload.length);
  payload.forEach(b => checkBytes.push(b));

  let checkResult;
  if (proto.checkType === 'CRC16') {
    // CRC16-MODBUS: 返回 [低字节, 高字节]
    checkResult = crc16(checkBytes);
  } else {
    // 累加和校验: 返回 [单字节]
    checkResult = sumCheck(checkBytes);
  }
  checkResult.forEach(b => bytes.push({
    hex: b.toString(16).padStart(2, '0').toUpperCase(),
    meaning: '校验',
    highlight: false,
  }));

  // 帧尾
  proto.frameTail.forEach(b => bytes.push({
    hex: b.toString(16).padStart(2, '0').toUpperCase(),
    meaning: '帧尾',
    highlight: false,
  }));

  return bytes;
}

/**
 * 将帧预览的 HEX 数据填入发送输入框
 */
function loadFrameToSend(session) {
  const frameBytes = buildFrame(session);
  if (frameBytes.length === 0) return;
  session.sendMode = 'HEX';
  session.sendInput = frameBytes.map(b => b.hex).join(' ');
}

/**
 * 格式化字节数组为可读字符串
 */
function formatBytes(arr) {
  if (!arr || arr.length === 0) return '无';
  return arr.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

/**
 * 格式化终端方向标签
 * TX: → TX  RX: ← RX  INFO/ERR: 对应文字
 */
/**
 * 切换解析模式开关
 */
function toggleParse(session) {
  session.parseEnabled = !session.parseEnabled;
}

function formatTerminalDir(line) {
  if (line.dir === 'tx') return 'TX';
  if (line.dir === 'rx') return 'RX';
  if (line.type === 'info') return 'INFO';
  if (line.type === 'err') return 'ERR';
  return '';
}

/**
 * 根据显示模式格式化终端数据（仅格式化原始帧显示，不做解析）
 * hex:    以十六进制空格分隔显示（默认）
 * ascii:  将十六进制字节序列转为 ASCII 文本，不可打印字符以 . 代替
 * 换行符 (0D/0A) 默认隐藏，由系统设置「显示换行符」控制
 * 协议解析由 parseFrame() 单独输出到原始帧下方的解析块
 */
const { showNewline } = useLogSettings();

function formatTerminalData(line, logMode) {
  let raw = line.data || '';
  if (!raw) return '';

  if (!showNewline.value) {
    raw = raw.trim().split(/\s+/).filter(b => b.toUpperCase() !== '0D' && b.toUpperCase() !== '0A').join(' ');
  }

  if (logMode === 'ascii') {
    const bytes = raw.trim().split(/\s+/);
    return bytes.map(b => {
      const code = parseInt(b, 16);
      if (isNaN(code)) return b;
      return (code >= 0x20 && code <= 0x7E) ? String.fromCharCode(code) : '.';
    }).join('');
  }

  return raw.toUpperCase();
}

/**
 * 信号解析悬浮卡片状态（fixed 定位跟随鼠标，Teleport 到 body）
 * groups: [{ name, value, children: [{ label, value }] }]
 */
const segCard = reactive({ visible: false, x: 0, y: 0, title: '', groups: [] });

function showSegCard(e, parse) {
  if (!parse || !parse.groups || parse.groups.length === 0) {
    hideSegCard();
    return;
  }
  segCard.title = parse.title;
  segCard.groups = parse.groups;
  segCard.visible = true;
  moveSegCard(e);
}

function moveSegCard(e) {
  if (!segCard.visible) return;
  const cardW = 300;
  const lineCount = segCard.groups.reduce((n, g) => n + 1 + (g.children ? g.children.length : 0), 0);
  const cardH = 48 + lineCount * 26;
  let x = e.clientX + 16;
  let y = e.clientY + 18;
  /* 视口边界：右侧/底部不足时翻转到鼠标左上侧 */
  if (x + cardW > window.innerWidth - 8) x = e.clientX - cardW - 16;
  if (y + cardH > window.innerHeight - 8) y = Math.max(8, e.clientY - cardH - 18);
  segCard.x = x;
  segCard.y = y;
}

function hideSegCard() {
  segCard.visible = false;
}

/**
 * 构建整帧解析（悬浮卡片内容）
 * 按 CMD → Payload 字段层级组织，每组区分原始值（raw）与解析值（parsed）:
 *   CMD 组: raw = 命令码, parsed = 命令名
 *   Payload0 (信号名): raw = 原始 hex, parsed = 位域各 bit / 枚举含义 / 物理值
 * 无协议定义或无法定位命令时返回 null
 */
function buildFrameParse(session, line) {
  const bytes = (line.data || '').trim().split(/\s+/).map(b => parseInt(b, 16));
  if (bytes.length < 3 || bytes.some(isNaN)) return null;

  const hex = n => n.toString(16).toUpperCase().padStart(2, '0');
  const proto = getProtocol(session);
  if (!proto) return null;

  const hLen = (proto.frameHeader || []).length;
  const tLen = (proto.frameTail || []).length;
  const chkLen = proto.checkType === 'CRC16' ? 2 : 1;
  const cmdLen = proto.cmdLen || 1;
  if (bytes.length < hLen + 1 + cmdLen + 1) return null;

  /* 定位命令字: 帧头 + 地址；按 CMD 字节数读取（大端序，高字节在前） */
  const cmdIdx = hLen + 1;
  let cmdVal = 0;
  for (let i = 0; i < cmdLen; i++) cmdVal = (cmdVal << 8) | (bytes[cmdIdx + i] || 0);
  const cmdDef = (proto.cmds || []).find(c => c.cmd === cmdVal);
  if (!cmdDef) return null;

  /* 载荷范围: 跳过长度字节，末尾去掉校验 + 帧尾 */
  const lenIdx = cmdIdx + cmdLen;
  const lenValue = bytes[lenIdx] || 0;
  const dataStart = lenIdx + 1;
  const dataEnd = bytes.length - chkLen - tLen;
  const dataBytes = bytes.slice(dataStart, Math.max(dataStart, dataEnd));

  const groups = [];

  /* CMD 组 */
  groups.push({ name: 'CMD', raw: `0x${cmdVal.toString(16).toUpperCase().padStart(cmdLen * 2, '0')}`, parsed: cmdDef.name });

  /* Payload 组: 按字段字节偏移编号 */
  if (cmdDef.fields && cmdDef.fields.length > 0) {
    let off = 0;
    cmdDef.fields.forEach(f => {
      /* 确定本字段字节数 */
      let fieldLen;
      if (f.type === 'text' || f.type === 'binary') {
        if (f.lengthMode === 'varlen-field') {
          fieldLen = lenValue;
        } else if (f.lengthMode === 'varlen-delim') {
          const delim = (f.delimiter || '0D0A').trim().split(/\s+/).map(b => parseInt(b, 16));
          fieldLen = dataBytes.length - off;
          for (let i = off; i <= dataBytes.length - delim.length; i++) {
            let match = true;
            for (let j = 0; j < delim.length; j++) {
              if (dataBytes[i + j] !== delim[j]) { match = false; break; }
            }
            if (match) { fieldLen = i - off; break; }
          }
        } else if (f.lengthMode === 'varlen-rest') {
          fieldLen = dataBytes.length - off;
        } else {
          fieldLen = f.length || 1;
        }
      } else {
        fieldLen = f.length || 1;
      }
      fieldLen = Math.max(0, Math.min(fieldLen, dataBytes.length - off));
      const fb = dataBytes.slice(off, off + fieldLen);
      const range = fieldLen === 1 ? `Payload${off}` : `Payload${off}-${off + fieldLen - 1}`;
      const name = `${range} (${f.name})`;
      const rawHex = `0x${fb.map(hex).join(' ') || '00'}`;
      let group;

      if (f.type === 'bitmap') {
        const b0 = fb.length ? fb[0] : 0;
        const setBits = (f.bits || []).filter(b => (b0 >> b.bit) & 1).map(b => b.name);
        group = { name, raw: rawHex, parsed: setBits.length > 0 ? setBits.join(' / ') : '全部清零', children: [] };
        (f.bits || []).forEach(b => {
          group.children.push({ label: `bit${b.bit} ${b.name}`, raw: '', parsed: String((b0 >> b.bit) & 1) });
        });
      } else if (f.type === 'enum') {
        const v = fb.length ? fb[0] : 0;
        const opt = (f.options || []).find(o => o.value === v);
        group = { name, raw: rawHex, parsed: opt ? opt.label : '未知值' };
      } else if (f.type === 'number') {
        let v = 0;
        if (f.encoding === 'float32' && fb.length >= 4) {
          const buf = new ArrayBuffer(4); const view = new DataView(buf);
          for (let i = 0; i < 4; i++) view.setUint8(i, fb[i]);
          v = view.getFloat32(0, true);
        } else if (f.encoding === 'float64' && fb.length >= 8) {
          const buf = new ArrayBuffer(8); const view = new DataView(buf);
          for (let i = 0; i < 8; i++) view.setUint8(i, fb[i]);
          v = view.getFloat64(0, true);
        } else {
          fb.forEach(b => { v = (v << 8) | b; });
          if (f.signed && fb.length > 0 && (fb[0] & 0x80)) v = v - (1 << (fb.length * 8));
        }
        const phys = f.scale && f.scale !== 1
          ? `${(v * f.scale).toFixed(4)}${f.unit || ''}`
          : `${v}${f.unit || ''}`;
        group = { name, raw: rawHex, parsed: phys };
      } else if (f.type === 'text') {
        let text = '';
        try {
          const dec = new TextDecoder(f.encoding || 'utf-8');
          text = dec.decode(new Uint8Array(fb));
        } catch {
          text = fb.map(b => String.fromCharCode(b)).join('');
        }
        if (f.format === 'json') {
          try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { /* keep raw */ }
        }
        group = { name, raw: `${fieldLen}B`, parsed: text };
      } else if (f.type === 'binary') {
        let binVal;
        if (f.encoding === 'base64') {
          try { binVal = btoa(String.fromCharCode(...fb)); } catch { binVal = '(decode error)'; }
        } else {
          binVal = fb.map(b => hex(b)).join(' ');
        }
        group = { name, raw: `${fieldLen}B`, parsed: binVal };
      } else {
        /* 兼容旧 uint8 类型 */
        let v = 0;
        fb.forEach(b => { v = (v << 8) | b; });
        if (f.signed && fb.length > 0 && (fb[0] & 0x80)) {
          v = v - (1 << (fb.length * 8));
        }
        const phys = f.scale && f.scale !== 1
          ? `${(v * f.scale).toFixed(2)}${f.unit || ''}`
          : `${v}${f.unit || ''}`;
        group = { name, raw: rawHex, parsed: phys };
      }
      groups.push(group);
      off += fieldLen;
    });

    /* 未被信号定义覆盖的剩余字节 */
    if (off < dataBytes.length) {
      const rest = dataBytes.slice(off);
      const range = rest.length === 1 ? `Payload${off}` : `Payload${off}-${dataBytes.length - 1}`;
      groups.push({ name: range, raw: `0x${rest.map(hex).join(' ')}`, parsed: '' });
    }
  } else if (dataBytes.length > 0) {
    dataBytes.forEach((b, i) => {
      groups.push({ name: `Payload${i}`, raw: `0x${hex(b)}`, parsed: '' });
    });
  }

  if (groups.length <= 1) return null;

  return { title: cmdDef.name, groups };
}

/* ==================== 波特率处理 ==================== */

function onBaudChange(session) {
  if (session.baudSelect !== 'custom') {
    session.baud = parseInt(session.baudSelect);
  }
}

/* ==================== 串口连接/断开 ==================== */

async function toggleConnection(session) {
  if (session.open) {
    await disconnectPort(session);
  } else {
    await connectPort(session);
  }
}

/**
 * 连接串口
 * 通过 IPC 调用主进程打开串口，失败时返回错误码
 */
async function connectPort(session) {
  if (!hasElectron) {
    // 模拟模式：无 Electron 环境时直接标记为已连接
    session.open = true;
    session.terminalLines.push({
      time: formatTime(new Date()),
      dir: '',
      type: 'info',
      data: `[INFO] ${session.port} 已连接（模拟模式）`,
      desc: '',
    });
    capLines(session);
    scrollToBottom(session.id);
    emitConnectionChange();
    return;
  }
  const result = await openPort({
    path: session.port,
    baudRate: parseInt(session.baud),
    dataBits: session.dataBits,
    stopBits: session.stopBits,
    parity: session.parity,
  });
  if (result.success) {
    session.open = true;
    session.terminalLines.push({
      time: formatTime(new Date()),
      dir: '',
      type: 'info',
      data: `[INFO] ${session.port} 已连接 @ ${session.baud}`,
      desc: '',
    });
    capLines(session);
    scrollToBottom(session.id);
    emitConnectionChange();
  } else {
    session.err++;
    session.terminalLines.push({
      time: formatTime(new Date()),
      dir: '',
      type: 'err',
      data: `[ERR] 连接失败: ${result.error}`,
      desc: '',
    });
    capLines(session);
    scrollToBottom(session.id);
  }
}

/**
 * 断开串口
 * 先停止循环发送，再通过 IPC 关闭串口
 */
async function disconnectPort(session) {
  if (session.cycle) toggleCycle(session);
  if (!hasElectron) {
    session.open = false;
    session.terminalLines.push({
      time: formatTime(new Date()),
      dir: '',
      type: 'info',
      data: `[INFO] ${session.port} 已断开`,
      desc: '',
    });
    capLines(session);
    scrollToBottom(session.id);
    emitConnectionChange();
    return;
  }
  await closePort(session.port);
  session.open = false;
  session.terminalLines.push({
    time: formatTime(new Date()),
    dir: '',
    type: 'info',
    data: `[INFO] ${session.port} 已断开`,
    desc: '',
  });
  capLines(session);
  scrollToBottom(session.id);
  emitConnectionChange();
}

function emitConnectionChange() {
  const hasOpen = sessions.value.some(s => s.open);
  emit('connection-change', hasOpen);
}

/* ==================== MCP 会话镜像 ====================
 * 外部 AI 客户端经 MCP 打开/发送/关闭串口时，在调试页镜像出
 * 带 MCP 徽章的真实会话：RX 走 onData 通用通道（按端口路由），
 * TX 由主进程单独广播（渲染层自己的发送不入此通道，避免重复计数） */

function pushInfoLine(session, text) {
  session.terminalLines.push({
    time: formatTime(new Date()),
    dir: '',
    type: 'info',
    data: `[INFO] ${text}`,
    desc: '',
  });
  capLines(session);
  scrollToBottom(session.id);
}

/* 找到或创建某端口的 MCP 镜像会话。
 * 附加优先级：已选同端口的窗口 > 第一个未连接的空窗口 > 新建窗口，
 * 避免用户明明开着准备好的窗口，AI 却另起一个 */
function ensureMcpSession(info, announce) {
  const port = info.port;
  const baud = info.baudRate || 115200;
  let session = sessions.value.find(s => s.port === port);
  if (!session) {
    session = sessions.value.find(s => !s.port && !s.open && !s.viaMcp);
  }
  if (session) {
    const adopt = !session.open;
    session.port = port;
    session.baud = baud;
    session.baudSelect = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600].includes(baud) ? String(baud) : 'custom';
    session.dataBits = info.dataBits || 8;
    session.parity = info.parity || 'none';
    session.stopBits = info.stopBits || 1;
    session.viaMcp = true;
    if (adopt) {
      session.open = true;
      if (announce) {
        pushInfoLine(session, `${port} 已由 AI（MCP）接管打开（${baud}-${session.dataBits}-${(session.parity || 'none')[0].toUpperCase()}-${session.stopBits}）`);
      }
      emitConnectionChange();
    }
    return session;
  }
  session = createSession({
    port,
    baud,
    baudSelect: [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600].includes(baud) ? String(baud) : 'custom',
    open: true,
    viaMcp: true,
  });
  session.dataBits = info.dataBits || 8;
  session.parity = info.parity || 'none';
  session.stopBits = info.stopBits || 1;
  sessions.value.push(session);
  if (announce) {
    pushInfoLine(session, `${port} 已由 AI（MCP）打开（${baud}-${session.dataBits}-${(session.parity || 'none')[0].toUpperCase()}-${session.stopBits}）`);
  }
  emitConnectionChange();
  return session;
}

function handleMcpOpened(info) {
  if (!hasElectron || !info || !info.port) return;
  ensureMcpSession(info, true);
}

function handleMcpClosed(payload) {
  if (!payload || !payload.port) return;
  const session = sessions.value.find(s => s.port === payload.port && s.viaMcp);
  if (!session) return;
  session.open = false;
  pushInfoLine(session, 'AI（MCP）已关闭该串口');
  emitConnectionChange();
}

function handleMcpTx(payload) {
  if (!hasElectron || !payload || !payload.port) return;
  const session = ensureMcpSession({ port: payload.port }, false);
  session.tx++;
  session.terminalLines.push({
    time: formatTime(new Date()),
    dir: 'tx',
    type: '',
    data: payload.hex,
    desc: session.viaMcp ? `${payload.length} bytes` : `${payload.length} bytes · MCP`,
  });
  capLines(session);
  if (session.autoScroll) scrollToBottom(session.id);
}

/* ==================== 数据发送 ==================== */

/**
 * 根据换行模式获取对应的 HEX 字符串
 * none:   空字符串
 * cr:     0D
 * lf:     0A
 * crlf:   0D 0A
 */
function getNewlineHex(session) {
  switch (session.newlineMode) {
    case 'cr':    return '0D';
    case 'lf':    return '0A';
    case 'crlf':  return '0D 0A';
    default:
      return '';
  }
}

/**
 * HEX 发送输入实时校验
 * 返回错误提示文案；空字符串表示合法（非 HEX 模式或输入为空时不提示）
 * 校验规则与 sendData 发送时的最终校验保持一致
 */
function sendInputError(session) {
  if (session.sendMode !== 'HEX') return '';
  const raw = session.sendInput.trim();
  if (!raw) return '';
  const compact = raw.split(/\s+/).map(t => t.replace(/^0[xX]/, '')).join('');
  if (!/^[0-9A-Fa-f]*$/.test(compact)) return 'HEX 输入包含非十六进制字符（只允许 0-9 A-F）';
  if (compact.length % 2 !== 0) return `HEX 共 ${compact.length} 位，应为偶数位（每字节两位，如 04 40）`;
  return '';
}

/**
 * 发送数据
 * HEX 模式：将输入转为大写十六进制
 * ASCII 模式：原样发送
 */
async function sendData(session) {
  if (!session.sendInput.trim()) return;
  const inputRaw = session.sendInput.trim();

  // 根据 sendMode 将输入转为 HEX 字符串（用于终端显示）和原始数据（用于 IPC 发送）
  let hexDisplay, sendDataStr;
  if (session.sendMode === 'ASCII') {
    // ASCII 模式：将每个字符转为对应的十六进制字节
    const bytes = [];
    for (let i = 0; i < inputRaw.length; i++) {
      const code = inputRaw.charCodeAt(i);
      if (code > 0xFF) {
        // 多字节字符拆为高低字节
        bytes.push((code >> 8) & 0xFF);
        bytes.push(code & 0xFF);
      } else {
        bytes.push(code);
      }
    }
    hexDisplay = bytes.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
    sendDataStr = hexDisplay;
  } else {
    // HEX 模式：校验合法性（纯十六进制且偶数位，每字节两位），规范化为字节精确显示
    // 防止 "440" 这类奇数位输入被主进程 Buffer.from 静默截断（只发 44），日志却原样回显误导用户
    const compact = inputRaw.trim().split(/\s+/).map(t => t.replace(/^0[xX]/, '')).join('');
    if (compact.length === 0 || !/^[0-9A-Fa-f]+$/.test(compact) || compact.length % 2 !== 0) {
      const reason = !/^[0-9A-Fa-f]*$/.test(compact)
        ? '包含非十六进制字符'
        : `共 ${compact.length} 位（应为偶数位，每字节两位，如 04 40，请检查是否丢失前导 0）`;
      session.err++;
      session.terminalLines.push({
        time: formatTime(new Date()),
        dir: '',
        type: 'err',
        data: `[ERR] HEX 输入无效（${reason}）: ${inputRaw}`,
        desc: '',
      });
      capLines(session);
      scrollToBottom(session.id);
      return;
    }
    hexDisplay = compact.match(/.{2}/g).map(s => s.toUpperCase()).join(' ');
    sendDataStr = hexDisplay;
  }

  // 追加换行：支持 CR / LF / CR+LF / 自定义 HEX
  const newlineHex = getNewlineHex(session);
  if (newlineHex) {
    hexDisplay += ' ' + newlineHex;
    sendDataStr += ' ' + newlineHex;
  }

  if (!hasElectron) {
    session.tx++;
    session.terminalLines.push({
      time: formatTime(new Date()),
      dir: 'tx',
      type: '',
      data: hexDisplay,
      desc: '手动发送',
    });
    capLines(session);
    scrollToBottom(session.id);
    return;
  }
  const result = await sendPort({
    portPath: session.port,
    data: sendDataStr,
    format: 'hex',
  });
  if (result.success) {
    session.tx++;
    session.terminalLines.push({
      time: formatTime(new Date()),
      dir: 'tx',
      type: '',
      data: hexDisplay,
      desc: '手动发送',
    });
    capLines(session);
    scrollToBottom(session.id);
  } else {
    session.err++;
    session.terminalLines.push({
      time: formatTime(new Date()),
      dir: '',
      type: 'err',
      data: `[ERR] 发送失败: ${result.error}`,
      desc: '',
    });
    capLines(session);
    scrollToBottom(session.id);
  }
}

/**
 * 限制终端行数上限为 200 行（边界检查）
 */
function capLines(session) {
  if (session.terminalLines.length > 200) {
    session.terminalLines = session.terminalLines.slice(-200);
  }
}

/* ==================== 循环发送 ==================== */

/**
 * 切换循环发送
 * 使用 setInterval 定时发送，间隔由 cycleInterval 控制
 * 停止时清除定时器
 */
function toggleCycle(session) {
  if (session.cycle) {
    session.cycle = false;
    if (session.cycleTimer) {
      clearInterval(session.cycleTimer);
      session.cycleTimer = null;
    }
  } else {
    session.cycle = true;
    const interval = session.cycleInterval || 1000;
    session.cycleTimer = setInterval(() => sendData(session), interval);
  }
}

/* ==================== IPC 数据/错误回调 ==================== */

let unsubData = null;
let unsubError = null;
let unsubPorts = null;
let unsubMcpOpened = null;
let unsubMcpClosed = null;
let unsubMcpTx = null;
let fpsTimer = null;

/**
 * 从数据库加载协议名称列表
 * 仅展示数据库中真实存在的协议
 */
async function loadProtocolsFromDB() {
  if (!hasElectron) {
    dbProtocolNames.value = Object.keys(protocolDefinitions);
    return;
  }
  try {
    const result = await window.electronAPI.db.query(
      'SELECT id, name, version, check_method, config_json FROM protocols ORDER BY id',
    );
    if (result.success && result.rows && result.rows.length > 0) {
      const names = [];
      const meta = {};

      for (const p of result.rows) {
        names.push(p.name);
        meta[p.name] = { version: p.version || '-' };

        /* 查询该协议的最新审核状态 */
        try {
          const auditResult = await window.electronAPI.db.query(
            'SELECT status FROM audit_logs WHERE protocol_name = ? ORDER BY id DESC LIMIT 1',
            [p.name],
          );
          if (auditResult.success && auditResult.rows && auditResult.rows.length > 0) {
            const statusMap = { pending: '审核中', approved: '已通过', rejected: '已驳回', published: '已生效', withdrawn: '已撤回' };
            meta[p.name].auditStatus = statusMap[auditResult.rows[0].status] || '-';
          } else {
            meta[p.name].auditStatus = '-';
          }
        } catch {
          meta[p.name].auditStatus = '-';
        }

        /* 解析协议 config_json 构建协议定义 */
        let protoConfig = {};
        try {
          protoConfig = JSON.parse(p.config_json || '{}');
        } catch { /* ignore */ }

        const protoDef = buildProtoDefFromDB(p, protoConfig);

        /* 从 commands 表加载命令列表 */
        try {
          const cmdResult = await window.electronAPI.db.query(
            'SELECT code, name, config_json FROM commands WHERE protocol_id = ? ORDER BY id',
            [p.id],
          );
          if (cmdResult.success && cmdResult.rows) {
            protoDef.cmds = cmdResult.rows.map(c => {
              let cmdData = {};
              try { cmdData = JSON.parse(c.config_json || '{}'); } catch { /* ignore */ }
              const cmdCode = parseInt(c.code, 16) || 0;
              const fields = (cmdData.fields || []).map(mapDbFieldToProtoField);
              return { cmd: cmdCode, name: c.name, fields };
            });
          }
        } catch { /* ignore */ }

        /* 用数据库构建的定义覆盖静态定义 */
        protocols.value[p.name] = protoDef;
      }

      dbProtocolNames.value = names;
      dbProtocolMeta.value = meta;

      /* 更新会话的默认选中协议 */
      if (names.length > 0) {
        sessions.value.forEach(s => {
          if (!names.includes(s.selectedProtocol)) {
            s.selectedProtocol = names[0];
            onProtocolChange(s);
          } else {
            /* 协议仍存在，但命令列表可能已变化：校验 selectedCmd 是否仍有效 */
            const proto = protocols.value[s.selectedProtocol];
            if (proto && proto.cmds.length > 0) {
              const cmdVal = typeof s.selectedCmd === 'string'
                ? parseInt(s.selectedCmd)
                : s.selectedCmd;
              if (!proto.cmds.some(c => c.cmd === cmdVal)) {
                s.selectedCmd = proto.cmds[0].cmd;
                s.fieldValues = {};
              }
            }
          }
        });
      }
    } else {
      dbProtocolNames.value = Object.keys(protocolDefinitions);
    }
  } catch {
    dbProtocolNames.value = Object.keys(protocolDefinitions);
  }
}

/* 视图切换到串口调试时重新加载数据库（v-show 不会重新挂载，需主动刷新） */
watch(() => props.active, (val) => {
  if (val) loadProtocolsFromDB();
});

onMounted(() => {
  // 从数据库加载协议名称列表
  loadProtocolsFromDB();

  // 数据接收回调：按串口号查找对应会话
  unsubData = onData((data) => {
    const session = sessions.value.find(s => s.port === data.port);
    if (!session) return;
    session.rx++;
    session.fps++;
    session.terminalLines.push({
      time: formatTime(new Date()),
      dir: 'rx',
      type: '',
      data: data.hex,
      desc: `${data.length} bytes`,
    });
    capLines(session);
    if (session.autoScroll) scrollToBottom(session.id);
    if (fullscreenLogSession.value === session && fullscreenTerminalEl) {
      nextTick(() => { fullscreenTerminalEl.scrollTop = fullscreenTerminalEl.scrollHeight; });
    }
  });

  // Esc 关闭全屏日志
  window.addEventListener('keydown', onFullscreenKeydown);

  // 错误回调：递增错误计数，标记断开
  unsubError = onError((data) => {
    const session = sessions.value.find(s => s.port === data.port);
    if (!session) return;
    session.err++;
    session.open = false;
    session.terminalLines.push({
      time: formatTime(new Date()),
      dir: '',
      type: 'err',
      data: `[ERR] ${data.error}`,
      desc: '',
    });
    capLines(session);
    scrollToBottom(session.id);
    emitConnectionChange();
  });

  // 端口变化回调：串口被拔出时清空会话端口并断开
  unsubPorts = onPortsChanged((portPaths) => {
    sessions.value.forEach(s => {
      if (s.port && !portPaths.includes(s.port)) {
        if (s.open) {
          s.open = false;
          s.terminalLines.push({
            time: formatTime(new Date()),
            dir: '',
            type: 'err',
            data: `[ERR] ${s.port} 已断开（设备被拔出）`,
            desc: '',
          });
          capLines(s);
          scrollToBottom(s.id);
          emitConnectionChange();
        }
        s.port = '';
      }
    });
  });

  // MCP 串口活动镜像：AI 打开/关闭/发送实时同步到调试页
  unsubMcpOpened = onMcpOpened(handleMcpOpened);
  unsubMcpClosed = onMcpClosed(handleMcpClosed);
  unsubMcpTx = onMcpTx(handleMcpTx);
  // 挂载时补一次同步：视图未挂载期间 AI 打开的串口也能镜像出来
  getMcpPorts().then((ports) => {
    (ports || []).forEach(p => ensureMcpSession(p, true));
  }).catch(() => {});

  // FPS 计数器每秒重置
  fpsTimer = setInterval(() => {
    sessions.value.forEach(s => { s.fps = 0; });
  }, 1000);
});

onUnmounted(() => {
  if (unsubData) unsubData();
  if (unsubError) unsubError();
  if (unsubPorts) unsubPorts();
  if (unsubMcpOpened) unsubMcpOpened();
  if (unsubMcpClosed) unsubMcpClosed();
  if (unsubMcpTx) unsubMcpTx();
  if (fpsTimer) clearInterval(fpsTimer);
  window.removeEventListener('keydown', onFullscreenKeydown);
  sessions.value.forEach(s => {
    if (s.cycleTimer) clearInterval(s.cycleTimer);
  });
});

/* ==================== 会话管理 ==================== */

/**
 * 添加新会话
 * 自动选择下一个可用的 COM 端口
 */
function addSession() {
  const session = createSession();
  const usedPorts = sessions.value.map(s => s.port);
  const nextPort = availablePorts.value.find(p => !usedPorts.includes(p));
  if (nextPort) session.port = nextPort;

  /* 设置默认协议为数据库中的第一个 */
  if (dbProtocolNames.value.length > 0) {
    session.selectedProtocol = dbProtocolNames.value[0];
  }

  sessions.value.push(session);
}

/**
 * 移除会话
 * 若会话处于连接状态则先断开，移除后若列表为空则自动新建一个
 */
function removeSession(id) {
  const session = sessions.value.find(s => s.id === id);
  if (session && session.open) disconnectPort(session);
  if (session && session.cycleTimer) clearInterval(session.cycleTimer);
  sessions.value = sessions.value.filter(s => s.id !== id);
  if (sessions.value.length === 0) {
    nextTick(() => addSession());
  }
  emitConnectionChange();
}

/**
 * 清空单个会话的通信日志
 */
function clearSessionLog(session) {
  session.terminalLines = [];
}

/**
 * 清空全部会话的通信日志
 */
function clearAllLogs() {
  sessions.value.forEach(s => { s.terminalLines = []; });
}
</script>
