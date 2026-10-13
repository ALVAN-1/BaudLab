<template>
  <div class="view">
    <div class="view-header">
      <div>
        <h1 class="view-title">自定义看板</h1>
        <p class="view-subtitle">从左侧组件库拖拽卡片到右侧画布，绑定信号实时监控</p>
      </div>
      <div class="view-actions">
        <button class="btn btn-secondary" @click="clearBoard">清空画布</button>
      </div>
    </div>

    <div class="board-layout">
      <!-- 左侧组件库 -->
      <aside class="board-sidebar">
        <div class="sidebar-section">
          <h3>组件库</h3>
          <p class="sidebar-hint">拖拽到右侧画布</p>
        </div>
        <div class="proto-selector-section">
          <label class="proto-selector-label">协议版本</label>
          <select class="input proto-selector" v-model="selectedProtoId" @change="onProtoChange">
            <option value="">— 选择协议 —</option>
            <option v-for="p in protoList" :key="p.id" :value="p.id">
              {{ p.name }} {{ p.version }}
            </option>
          </select>
        </div>
        <div class="component-list">
          <div
            v-for="comp in componentLibrary"
            :key="comp.type"
            class="component-item"
            draggable="true"
            @dragstart="onDragStart($event, comp)"
            @mouseenter="onCompHover($event, comp.type)"
            @mouseleave="hoveredComp = null; stopDemoAnimation()"
          >
            <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="component-icon"><use :href="'#' + comp.iconRef" /></svg>
            <div class="component-info">
              <b>{{ comp.name }}</b>
              <span>{{ comp.desc }}</span>
            </div>
            <!-- 悬浮预览窗 -->
            <Transition name="comp-preview">
              <div v-if="hoveredComp && hoveredComp.type === comp.type" class="comp-preview-popover" :style="{ top: hoveredComp.top + 'px' }">
                <div class="comp-preview-title">{{ comp.name }} — 使用示例</div>
                <!-- 数据卡片示例 -->
                <div v-if="hoveredComp && hoveredComp.type === 'data-card'" class="comp-preview-demo data-card-demo">
                  <div class="demo-card">
                    <div class="demo-card-header">环境温度</div>
                    <div class="demo-card-value number">{{ demoData.temp.toFixed(1) }}℃</div>
                    <div class="demo-card-unit">温度传感器</div>
                  </div>
                  <div class="demo-card">
                    <div class="demo-card-header">总电源</div>
                    <div class="demo-card-value boolean" :class="{ flash: demoData.switchA }">{{ demoData.switchA ? 'ON' : 'OFF' }}</div>
                    <div class="demo-card-unit">开关量</div>
                  </div>
                </div>
                <!-- 趋势曲线示例 -->
                <div v-else-if="hoveredComp && hoveredComp.type === 'line-chart'" class="comp-preview-demo chart-demo">
                  <div class="demo-chart">
                    <div class="demo-chart-title">温度趋势 (30s)</div>
                    <svg viewBox="0 0 120 50" class="demo-chart-svg" preserveAspectRatio="none">
                      <line x1="0" y1="12.5" x2="120" y2="12.5" stroke="#3a3a4e" stroke-width="0.5" stroke-dasharray="2 2" />
                      <line x1="0" y1="25" x2="120" y2="25" stroke="#3a3a4e" stroke-width="0.5" stroke-dasharray="2 2" />
                      <line x1="0" y1="37.5" x2="120" y2="37.5" stroke="#3a3a4e" stroke-width="0.5" stroke-dasharray="2 2" />
                      <polyline :points="demoChartPoints" fill="none" stroke="#f59e0b" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
                      <circle :cx="120" :cy="demoChartLastY" r="2" fill="#f59e0b" />
                    </svg>
                    <div class="demo-chart-axis"><span>30s前</span><span>现在</span></div>
                  </div>
                </div>
                <!-- 信号开关示例 -->
                <div v-else-if="hoveredComp && hoveredComp.type === 'signal-switch'" class="comp-preview-demo switch-demo">
                  <div class="demo-switch-row" v-for="(sw, i) in demoSwitches" :key="i">
                    <span class="demo-switch-label">{{ sw.label }}</span>
                    <div class="demo-switch-track" :class="sw.on ? 'on' : 'off'"><div class="demo-switch-knob"></div></div>
                    <span class="demo-switch-state" :class="sw.on ? 'on' : 'off'">{{ sw.on ? 'ON' : 'OFF' }}</span>
                  </div>
                </div>
                <div class="comp-preview-tip">拖拽到右侧画布即可使用</div>
              </div>
            </Transition>
          </div>
        </div>
      </aside>

      <!-- 右侧画布（视口 + 可平移内层） -->
      <div
        ref="viewportRef"
        class="board-viewport"
        @dragover.prevent
        @drop="onDrop"
        @mousedown="startPan"
      >
        <div
          ref="canvasRef"
          class="board-canvas-inner"
          :class="{ 'is-panning': isPanning }"
        >
          <!-- SVG 连线层（在卡片下方） -->
          <svg class="connections-layer" width="3000" height="2000">
            <defs>
              <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
                <polygon points="0 0, 10 3.5, 0 7" fill="#f59e0b" />
              </marker>
            </defs>
            <!-- 已保存的连线 -->
            <g v-for="conn in validConnections" :key="conn.id" class="connection-group">
              <path
                :d="bezierPath(
                  getPortPos(getCardById(conn.fromCardId), 'out').x,
                  getPortPos(getCardById(conn.fromCardId), 'out').y,
                  getPortPos(getCardById(conn.toCardId), 'in').x,
                  getPortPos(getCardById(conn.toCardId), 'in').y
                )"
                class="connection-path"
                :class="{ active: conn._flash > 0 }"
                marker-end="url(#arrowhead)"
              />
              <!-- 连线删除按钮（中点位置） -->
              <g
                class="conn-delete-btn"
                :transform="`translate(${midPoint(conn).x}, ${midPoint(conn).y})`"
                @mousedown.stop
                @click.stop="deleteConnection(conn.id)"
              >
                <circle r="10" fill="#fff" stroke="#dc2626" stroke-width="1.5" />
                <text x="0" y="4" text-anchor="middle" fill="#dc2626" font-size="12" font-weight="bold">×</text>
              </g>
            </g>
            <!-- 正在拖拽的临时连线 -->
            <path
              v-if="linkDragState"
              :d="bezierPath(linkDragState.startX, linkDragState.startY, linkDragState.curX, linkDragState.curY)"
              class="connection-path dragging"
              :class="{ snapped: linkDragState.snapping }"
              marker-end="url(#arrowhead)"
            />
            <!-- 待定连线（拖拽结束后、弹窗前的动画） -->
            <path
              v-if="pendingConnection && getCardById(pendingConnection.fromCardId) && getCardById(pendingConnection.toCardId)"
              :d="bezierPath(
                getPortPos(getCardById(pendingConnection.fromCardId), 'out').x,
                getPortPos(getCardById(pendingConnection.fromCardId), 'out').y,
                getPortPos(getCardById(pendingConnection.toCardId), 'in').x,
                getPortPos(getCardById(pendingConnection.toCardId), 'in').y
              )"
              class="connection-path pending"
              marker-end="url(#arrowhead)"
            />
          </svg>

          <div v-if="placedCards.length === 0" class="canvas-empty">
            <div class="canvas-empty-icon">
              <svg width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#i-board-card"/></svg>
            </div>
            <p>从左侧拖拽组件到此处</p>
            <span>放置后可拖动位置、调整大小、绑定信号</span>
            <span class="canvas-empty-tip">💡 拖动画布空白处可平移视图 · 拖拽卡片右侧圆点可连线</span>
          </div>

          <div
            v-for="card in placedCards"
            :key="card.id"
            class="placed-card"
            :class="{ unbound: !card.config.signalName, 'card-flash': card._flash > 0 }"
            :style="{ left: card.x + 'px', top: card.y + 'px', width: card.w + 'px', height: card.h + 'px' }"
            @mousedown="startMove($event, card)"
          >
            <!-- 输入端口（左侧） -->
            <div class="card-port port-in" :class="{ 'port-hover': isPortSnapped(card.id) }" title="输入端口">
              <div class="port-dot"></div>
            </div>
            <!-- 输出端口（右侧） -->
            <div class="card-port port-out" title="拖拽连线到目标卡片" @mousedown="startLinkDrag($event, card)">
              <div class="port-dot"></div>
            </div>
            <div class="placed-card-header">
              <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="placed-card-icon"><use :href="'#' + card.iconRef" /></svg>
              <span class="placed-card-name">{{ card.config.title || card.name }}</span>
              <button class="placed-card-btn" @click.stop="openConfig(card)" title="配置">⚙</button>
              <button class="placed-card-btn close" @click.stop="removeCard(card.id)" title="删除">×</button>
            </div>
            <div class="placed-card-body">
              <!-- 数据卡片 -->
              <div v-if="card.type === 'data-card'" class="data-card-view">
                <template v-if="card.config.signalName && getSignal(card.config.signalName)">
                  <p class="data-value" :class="getSignal(card.config.signalName).type">
                    <template v-if="getSignal(card.config.signalName).type === 'boolean'">
                      {{ getSignal(card.config.signalName).value ? 'ON' : 'OFF' }}
                    </template>
                    <template v-else-if="getSignal(card.config.signalName).type === 'enum'">
                      {{ getEnumLabel(getSignal(card.config.signalName)) }}
                    </template>
                    <template v-else>
                      {{ getSignal(card.config.signalName).value.toFixed(2) }}
                      <small v-if="getSignal(card.config.signalName).unit">{{ getSignal(card.config.signalName).unit }}</small>
                    </template>
                  </p>
                  <p class="data-signal-name">{{ card.config.signalName }}</p>
                </template>
                <p v-else class="data-unbound">未绑定信号<br /><span>点击 ⚙ 配置</span></p>
              </div>

              <!-- 趋势曲线 -->
              <div v-else-if="card.type === 'line-chart'" class="chart-view">
                <template v-if="card.config.signalName && getSignal(card.config.signalName)">
                  <svg
                    class="chart-svg"
                    :width="card.w - 24"
                    :height="card.h - 60"
                    :viewBox="`0 0 ${card.w - 24} ${card.h - 60}`"
                    preserveAspectRatio="none"
                  >
                    <line v-for="gy in [0.25, 0.5, 0.75]" :key="gy"
                      :x1="0" :x2="card.w - 24"
                      :y1="(card.h - 60) * gy" :y2="(card.h - 60) * gy"
                      class="chart-grid-line" />
                    <polyline :points="buildChartPoints(card)" class="chart-line" />
                  </svg>
                  <div class="chart-labels">
                    <span v-if="getSignal(card.config.signalName).type === 'enum'">{{ getEnumLabel(getSignal(card.config.signalName)) }}</span>
                    <span v-else-if="getSignal(card.config.signalName).type === 'boolean'">{{ getSignal(card.config.signalName).value ? 'ON' : 'OFF' }}</span>
                    <span v-else>{{ getSignal(card.config.signalName).value.toFixed(2) }}{{ getSignal(card.config.signalName).unit }}</span>
                    <span>{{ card.config.timeWindow || 30 }}s</span>
                  </div>
                </template>
                <p v-else class="data-unbound">未绑定信号<br /><span>点击 ⚙ 配置</span></p>
              </div>

              <!-- 信号开关 -->
              <div v-else-if="card.type === 'signal-switch'" class="switch-view">
                <template v-if="card.config.signalName && getSignal(card.config.signalName)">
                  <template v-if="getSignal(card.config.signalName).type === 'boolean'">
                    <button
                      class="switch-toggle"
                      :class="{ on: getSignal(card.config.signalName).value }"
                      @click.stop="toggleSwitch(card.config.signalName)"
                    >
                      <span class="switch-knob"></span>
                    </button>
                    <p class="switch-state">{{ getSignal(card.config.signalName).value ? 'ON' : 'OFF' }}</p>
                  </template>
                  <template v-else-if="getSignal(card.config.signalName).type === 'enum'">
                    <button class="enum-cycle-btn" @click.stop="toggleSwitch(card.config.signalName)" title="点击切换枚举值">
                      {{ getEnumLabel(getSignal(card.config.signalName)) }}
                    </button>
                  </template>
                  <template v-else>
                    <p class="switch-state">{{ getSignal(card.config.signalName).value.toFixed(2) }}<small>{{ getSignal(card.config.signalName).unit }}</small></p>
                  </template>
                  <p class="switch-signal-name">{{ card.config.signalName }}</p>
                </template>
                <p v-else class="data-unbound">未绑定信号<br /><span>点击 ⚙ 配置</span></p>
              </div>
            </div>
            <div class="resize-handle" @mousedown.stop="startResize($event, card)"></div>
          </div>
        </div>
      </div>
    </div>

    <!-- 配置弹窗 -->
    <Transition name="modal-fade">
      <div v-if="configVisible" class="modal-overlay" @mousedown.self="closeConfig">
        <div class="modal-dialog" style="min-width: 420px; max-width: 520px;">
          <div class="modal-header">
            <h3>组件配置</h3>
          </div>
          <div class="modal-body">
            <div class="form-row">
              <label>标题</label>
              <input type="text" class="input" v-model="configDraft.title" placeholder="显示标题" maxlength="32" />
            </div>
            <div class="form-row">
              <label>绑定信号</label>
              <select class="input" v-model="configDraft.signalName" :disabled="!selectedProtoId">
                <option value="">{{ selectedProtoId ? '— 选择信号 —' : '— 请先选择协议 —' }}</option>
                <option v-for="sig in signalList" :key="sig.name" :value="sig.name">
                  {{ sig.name }} ({{ sig.type }}{{ sig.unit ? ', ' + sig.unit : '' }})
                </option>
              </select>
            </div>
            <template v-if="configCard?.type === 'line-chart'">
              <div class="form-row">
                <label>时间窗口（秒）</label>
                <input type="number" class="input" v-model.number="configDraft.timeWindow" min="5" max="300" step="5" />
              </div>
            </template>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" @click="closeConfig">取消</button>
            <button class="btn btn-primary" @click="saveConfig">保存</button>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 连线条件配置弹窗 -->
    <Transition name="modal-fade">
      <div v-if="linkConfigVisible" class="modal-overlay" @mousedown.self="cancelLinkConfig">
        <div class="modal-dialog" style="min-width: 440px; max-width: 520px;">
          <div class="modal-header">
            <h3>连线条件配置</h3>
          </div>
          <div class="modal-body">
            <div class="link-config-summary">
              <span class="link-summary-card">{{ getCardById(linkConfigDraft.fromCardId)?.config?.title || getCardById(linkConfigDraft.fromCardId)?.name || '源卡片' }}</span>
              <span class="link-summary-arrow">→</span>
              <span class="link-summary-card">{{ getCardById(linkConfigDraft.toCardId)?.config?.title || getCardById(linkConfigDraft.toCardId)?.name || '目标卡片' }}</span>
            </div>

            <div class="form-row">
              <label>触发条件</label>
              <select class="input" v-model="linkConfigDraft.conditionType">
                <template v-if="isSourceBoolean">
                  <option value="on">信号为 ON 时触发</option>
                  <option value="off">信号为 OFF 时触发</option>
                </template>
                <template v-else-if="isSourceEnum">
                  <option value="enum_eq">等于枚举值时触发</option>
                </template>
                <template v-else>
                  <option value="gt">大于 ( &gt; )</option>
                  <option value="lt">小于 ( &lt; )</option>
                  <option value="eq">等于 ( = )</option>
                </template>
              </select>
            </div>

            <div v-if="isSourceEnum" class="form-row">
              <label>枚举值</label>
              <select class="input" v-model.number="linkConfigDraft.conditionValue">
                <option v-for="opt in sourceEnumOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
              </select>
            </div>
            <div v-else-if="!isSourceBoolean" class="form-row">
              <label>条件值</label>
              <input type="number" class="input" v-model.number="linkConfigDraft.conditionValue" step="0.1" />
            </div>

            <div class="form-row">
              <label>触发动作</label>
              <select class="input" v-model="linkConfigDraft.actionType">
                <template v-if="isTargetToggleable">
                  <option value="toggle">翻转开关状态</option>
                  <option value="on">打开开关</option>
                  <option value="off">关闭开关</option>
                </template>
                <template v-else>
                  <option value="highlight">高亮闪烁</option>
                </template>
              </select>
            </div>

            <div class="link-config-hint">
              💡 当源卡片满足设定条件时，自动对目标卡片执行动作
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" @click="cancelLinkConfig">取消</button>
            <button class="btn btn-primary" @click="saveLinkConfig">创建连线</button>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onUnmounted, watch, nextTick } from 'vue';
import { crc16, sumCheck } from '../data/protocolDefinitions';

const hasElectron = typeof window !== 'undefined' && window.electronAPI && window.electronAPI.db;

const viewportRef = ref(null);
const canvasRef = ref(null);
const isPanning = ref(false);
const hoveredComp = ref(null); // { type, top }

/* 画布平移：拖拽空白处移动视图 */
let panState = null;
function startPan(e) {
  // 只在左键点击画布空白区域时才平移（不拖卡片、不拖 resize 手柄）
  if (e.button !== 0) return;
  if (e.target.closest('.placed-card') || e.target.closest('.resize-handle')) return;

  panState = {
    startX: e.clientX,
    startY: e.clientY,
    scrollLeft: viewportRef.value.scrollLeft,
    scrollTop: viewportRef.value.scrollTop,
  };
  isPanning.value = true;
  e.preventDefault();
}

function onPanMove(e) {
  if (!panState) return;
  const dx = e.clientX - panState.startX;
  const dy = e.clientY - panState.startY;
  viewportRef.value.scrollLeft = panState.scrollLeft - dx;
  viewportRef.value.scrollTop = panState.scrollTop - dy;
}

function onPanEnd() {
  if (panState) {
    panState = null;
    isPanning.value = false;
  }
}

/* ── 组件库 ── */
const componentLibrary = [
  { type: 'data-card', iconRef: 'i-board-card', name: '数据卡片', desc: '显示开关量 / 枚举 / 数值', w: 200, h: 150 },
  { type: 'line-chart', iconRef: 'i-board-chart', name: '趋势曲线', desc: '实时折线图', w: 360, h: 220 },
  { type: 'signal-switch', iconRef: 'i-board-switch', name: '信号开关', desc: '可绑定信号的开/关', w: 180, h: 150 },
];

function onCompHover(e, type) {
  const rect = e.currentTarget.getBoundingClientRect();
  hoveredComp.value = { type, top: rect.top };
  startDemoAnimation(type);
}

/* ── 预览窗动态演示数据 ── */
const demoData = reactive({ temp: 23.5, switchA: true });
const demoChartPoints = ref('0,35 15,28 30,32 45,18 60,22 75,10 90,15 105,8 120,12');
const demoChartLastY = ref(12);
const demoSwitches = reactive([
  { label: '总电源', on: true },
  { label: '加热开关', on: false },
  { label: '蜂鸣器', on: true },
]);
let demoTimer = null;

function startDemoAnimation(type) {
  stopDemoAnimation();
  let tick = 0;
  let chartData = [35, 28, 32, 18, 22, 10, 15, 8, 12]; // 初始9个点
  demoTimer = setInterval(() => {
    tick++;
    if (type === 'data-card') {
      // 温度在 20~28 之间波动
      demoData.temp = 24 + Math.sin(tick * 0.5) * 3 + (Math.random() - 0.5) * 0.8;
      // 每5次切换一次开关
      if (tick % 5 === 0) demoData.switchA = !demoData.switchA;
    } else if (type === 'line-chart') {
      // 模拟新数据点：移除第一个，末尾添加新值
      chartData.shift();
      const lastVal = chartData[chartData.length - 1];
      let newVal = lastVal + (Math.random() - 0.5) * 12;
      newVal = Math.max(2, Math.min(45, newVal));
      chartData.push(newVal);
      const step = 120 / (chartData.length - 1);
      demoChartPoints.value = chartData.map((v, i) => `${(i * step).toFixed(1)},${v.toFixed(1)}`).join(' ');
      demoChartLastY.value = chartData[chartData.length - 1];
    } else if (type === 'signal-switch') {
      // 随机切换开关
      if (tick % 3 === 0) {
        const idx = Math.floor(Math.random() * demoSwitches.length);
        demoSwitches[idx].on = !demoSwitches[idx].on;
      }
    }
  }, 500);
}

function stopDemoAnimation() {
  if (demoTimer) {
    clearInterval(demoTimer);
    demoTimer = null;
  }
}

/* ── 协议选择 + 信号仓库：从数据库提取 ── */
const protoList = ref([]);
const selectedProtoId = ref('');
const signalStore = reactive({});
const signalList = ref([]);
/* 信号名 → 源信息（cmdCode, fieldName, bit, fieldDef）用于开关发送 */
const signalSourceMap = {};

/* 协议帧格式（用于解析串口数据） */
const protoFrame = reactive({
  frameHeader: [],
  frameTail: [],
  checkType: 'CRC16',
  address: 0x01,
  cmdLen: 1,
  cmds: [],
});

/* DB 字段类型 → 解析用字段类型 */
function mapDbField(field) {
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

async function loadProtoList() {
  if (!hasElectron) return;
  try {
    const res = await window.electronAPI.db.query(
      'SELECT id, name, version FROM protocols ORDER BY name', [],
    );
    if (res.success && res.rows) {
      protoList.value = res.rows;
    }
  } catch { /* ignore */ }
}

async function onProtoChange() {
  signalList.value = [];
  for (const k of Object.keys(signalStore)) {
    delete signalStore[k];
  }
  for (const k of Object.keys(signalSourceMap)) {
    delete signalSourceMap[k];
  }
  protoFrame.cmds = [];
  if (!selectedProtoId.value) return;
  await loadProtoFrame(selectedProtoId.value);
  await buildSignals(selectedProtoId.value);
}

/* 加载协议帧格式（header/tail/checkType/cmdLen/address） */
async function loadProtoFrame(protoId) {
  if (!hasElectron || !protoId) return;
  try {
    const pRes = await window.electronAPI.db.query(
      'SELECT config_json, check_method FROM protocols WHERE id = ?',
      [protoId],
    );
    if (!pRes.success || !pRes.rows || pRes.rows.length === 0) return;
    const p = pRes.rows[0];
    let protoConfig = {};
    try { protoConfig = JSON.parse(p.config_json || '{}'); } catch { /* ignore */ }
    const fieldConfig = protoConfig.fieldConfig || {};

    const sofCfg = fieldConfig.sof;
    protoFrame.frameHeader = (sofCfg && sofCfg.enabled && sofCfg.defaults)
      ? sofCfg.defaults.map(h => parseInt(h, 16) || 0) : [];

    const eofCfg = fieldConfig.eof;
    protoFrame.frameTail = (eofCfg && eofCfg.enabled && eofCfg.defaults)
      ? eofCfg.defaults.map(h => parseInt(h, 16) || 0) : [];

    const checkMethod = protoConfig.checkType || p.check_method || 'CRC16-MODBUS';
    protoFrame.checkType = checkMethod.includes('CRC') ? 'CRC16' : 'SUM';

    const srcCfg = fieldConfig.src;
    protoFrame.address = (srcCfg && srcCfg.enabled && srcCfg.defaults && srcCfg.defaults.length > 0)
      ? (parseInt(srcCfg.defaults[0], 16) || 0x01) : 0x01;

    const cmdCfg = fieldConfig.cmd;
    if (cmdCfg && cmdCfg.enabled) {
      protoFrame.cmdLen = cmdCfg.byteCount === 'custom'
        ? (parseInt(cmdCfg.customCount, 10) || 1)
        : (parseInt(cmdCfg.byteCount, 10) || 1);
    } else {
      protoFrame.cmdLen = 1;
    }
  } catch (e) {
    console.warn('[CustomBoard] 帧格式加载失败:', e);
  }
}

async function buildSignals(protoId) {
  if (!hasElectron || !protoId) return;
  const list = [];
  const cmds = [];
  try {
    const cmdRes = await window.electronAPI.db.query(
      'SELECT code, name, config_json FROM commands WHERE protocol_id = ? ORDER BY id',
      [protoId],
    );
    if (!cmdRes.success || !cmdRes.rows) return;
    for (const c of cmdRes.rows) {
      let cmdData = {};
      try { cmdData = JSON.parse(c.config_json || '{}'); } catch { /* ignore */ }
      const cmdCode = parseInt(c.code, 16) || 0;
      const fields = (cmdData.fields || []).map(mapDbField);
      cmds.push({ cmd: cmdCode, name: c.name, fields });

      for (const field of fields) {
        if (field.type === 'bitmap' && field.bits) {
          for (const bit of field.bits) {
            const name = `${field.name}·${bit.name}`;
            signalStore[name] = { name, type: 'boolean', value: false, history: [] };
            list.push({ name, type: 'boolean' });
            signalSourceMap[name] = { cmdCode, fieldName: field.name, bit: bit.bit, fieldDef: field };
          }
        } else if (field.type === 'enum' && field.options) {
          const name = `${c.name}·${field.name}`;
          signalStore[name] = { name, type: 'enum', options: field.options, value: 0, history: [] };
          list.push({ name, type: 'enum' });
          signalSourceMap[name] = { cmdCode, fieldName: field.name, fieldDef: field };
        } else if (field.type === 'text') {
          const name = `${c.name}·${field.name}`;
          signalStore[name] = { name, type: 'text', value: '', history: [] };
          list.push({ name, type: 'text' });
          signalSourceMap[name] = { cmdCode, fieldName: field.name, fieldDef: field };
        } else if (field.type === 'binary') {
          const name = `${c.name}·${field.name}`;
          signalStore[name] = { name, type: 'binary', value: '', history: [] };
          list.push({ name, type: 'binary' });
          signalSourceMap[name] = { cmdCode, fieldName: field.name, fieldDef: field };
        } else {
          const name = `${c.name}·${field.name}`;
          signalStore[name] = { name, type: 'number', unit: field.unit || '', scale: field.scale || 1, value: 0, history: [] };
          list.push({ name, type: 'number', unit: field.unit || '' });
          signalSourceMap[name] = { cmdCode, fieldName: field.name, fieldDef: field };
        }
      }
    }
    protoFrame.cmds = cmds;
  } catch (e) {
    console.warn('[CustomBoard] 信号构建失败:', e);
  }
  signalList.value = list;
}

function getSignal(name) {
  return signalStore[name] || null;
}

function getEnumLabel(sig) {
  if (!sig.options) return sig.value;
  const opt = sig.options.find((o) => o.value === sig.value);
  return opt ? opt.label : String(sig.value);
}

/* ── 串口真实数据接收 + 帧解析 ── */
let unsubSerialData = null;

/* 串口数据 → 帧解析 → signalStore 更新 */
function onSerialData(data) {
  if (!data || !data.hex) return;
  const bytes = data.hex.trim().split(/\s+/).map(b => parseInt(b, 16));
  if (bytes.length < 3 || bytes.some(isNaN)) return;
  parseFrame(bytes);
}

/* 多字节整数解码（大端） */
function decodeNumber(bytes, encoding, signed) {
  if (!bytes || bytes.length === 0) return 0;
  if (encoding === 'float32' && bytes.length >= 4) {
    const buf = new ArrayBuffer(4);
    const view = new DataView(buf);
    for (let i = 0; i < 4; i++) view.setUint8(i, bytes[i]);
    return view.getFloat32(0, true);
  }
  if (encoding === 'float64' && bytes.length >= 8) {
    const buf = new ArrayBuffer(8);
    const view = new DataView(buf);
    for (let i = 0; i < 8; i++) view.setUint8(i, bytes[i]);
    return view.getFloat64(0, true);
  }
  let v = 0;
  for (const b of bytes) v = (v << 8) | b;
  if (signed && bytes.length > 0 && (bytes[0] & 0x80)) {
    v = v - (1 << (bytes.length * 8));
  }
  return v;
}

/* 文本解码 */
function decodeText(bytes, encoding) {
  try {
    if (encoding === 'ascii') {
      return bytes.map(b => String.fromCharCode(b)).join('');
    }
    const dec = new TextDecoder(encoding || 'utf-8');
    return dec.decode(new Uint8Array(bytes));
  } catch {
    return bytes.map(b => String.fromCharCode(b)).join('');
  }
}

/* 按协议帧格式解析一帧数据，更新 signalStore */
function parseFrame(bytes) {
  const { frameHeader, frameTail, checkType, cmdLen, cmds } = protoFrame;
  if (frameHeader.length === 0 && cmds.length === 0) return;

  const hLen = frameHeader.length;
  const tLen = frameTail.length;
  const chkLen = checkType === 'CRC16' ? 2 : 1;

  /* 校验帧头 */
  if (hLen > 0) {
    for (let i = 0; i < hLen; i++) {
      if (bytes[i] !== frameHeader[i]) return;
    }
  }

  /* 定位命令字：帧头 + 地址(1) */
  const cmdIdx = hLen + 1;
  if (bytes.length < cmdIdx + cmdLen + 1) return;

  let cmdVal = 0;
  for (let i = 0; i < cmdLen; i++) {
    cmdVal = (cmdVal << 8) | (bytes[cmdIdx + i] || 0);
  }

  const cmdDef = cmds.find(c => c.cmd === cmdVal);
  if (!cmdDef) return;

  /* 读取 LEN 字段值（变长字段的长度来源） */
  const lenIdx = cmdIdx + cmdLen;
  const lenValue = bytes[lenIdx] || 0;

  /* 载荷范围：跳过长度字节，末尾去掉校验 + 帧尾 */
  const dataStart = lenIdx + 1;
  const dataEnd = bytes.length - chkLen - tLen;
  const dataBytes = bytes.slice(dataStart, Math.max(dataStart, dataEnd));
  const now = Date.now();

  /* 逐字段解析 */
  let off = 0;
  for (const field of (cmdDef.fields || [])) {
    /* 确定本字段字节数 */
    let fieldLen;
    if (field.type === 'text' || field.type === 'binary') {
      if (field.lengthMode === 'varlen-field') {
        fieldLen = lenValue;
      } else if (field.lengthMode === 'varlen-delim') {
        const delim = (field.delimiter || '0D0A').trim().split(/\s+/).map(b => parseInt(b, 16));
        fieldLen = dataBytes.length - off;
        for (let i = off; i <= dataBytes.length - delim.length; i++) {
          let match = true;
          for (let j = 0; j < delim.length; j++) {
            if (dataBytes[i + j] !== delim[j]) { match = false; break; }
          }
          if (match) { fieldLen = i - off; break; }
        }
      } else if (field.lengthMode === 'varlen-rest') {
        fieldLen = dataBytes.length - off;
      } else {
        fieldLen = field.length || 1;
      }
    } else {
      fieldLen = field.length || 1;
    }
    fieldLen = Math.max(0, Math.min(fieldLen, dataBytes.length - off));
    const fb = dataBytes.slice(off, off + fieldLen);

    if (field.type === 'bitmap' && field.bits) {
      const b0 = fb.length ? fb[0] : 0;
      for (const bit of field.bits) {
        const name = `${field.name}·${bit.name}`;
        const sig = signalStore[name];
        if (sig) {
          const val = ((b0 >> bit.bit) & 1) === 1;
          sig.value = val;
          sig.history.push({ t: now, v: val ? 1 : 0 });
          if (sig.history.length > 300) sig.history.shift();
        }
      }
    } else if (field.type === 'enum' && field.options) {
      const v = fb.length ? fb[0] : 0;
      const name = `${cmdDef.name}·${field.name}`;
      const sig = signalStore[name];
      if (sig) {
        sig.value = v;
        sig.history.push({ t: now, v });
        if (sig.history.length > 300) sig.history.shift();
      }
    } else if (field.type === 'number') {
      const v = decodeNumber(fb, field.encoding, field.signed);
      const phys = (field.scale && field.scale !== 1) ? v * field.scale : v;
      const name = `${cmdDef.name}·${field.name}`;
      const sig = signalStore[name];
      if (sig) {
        sig.value = +phys.toFixed(4);
        sig.history.push({ t: now, v: phys });
        if (sig.history.length > 300) sig.history.shift();
      }
    } else if (field.type === 'text') {
      let text = decodeText(fb, field.encoding);
      if (field.format === 'json') {
        try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { /* keep raw */ }
      }
      const name = `${cmdDef.name}·${field.name}`;
      const sig = signalStore[name];
      if (sig) {
        sig.value = text;
        sig.history.push({ t: now, v: text });
        if (sig.history.length > 300) sig.history.shift();
      }
    } else if (field.type === 'binary') {
      let binVal;
      if (field.encoding === 'base64') {
        try { binVal = btoa(String.fromCharCode(...fb)); } catch { binVal = '(decode error)'; }
      } else {
        binVal = fb.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
      }
      const name = `${cmdDef.name}·${field.name}`;
      const sig = signalStore[name];
      if (sig) {
        sig.value = binVal;
        sig.history.push({ t: now, v: binVal });
        if (sig.history.length > 300) sig.history.shift();
      }
    } else {
      /* 兼容旧 uint8 类型 */
      let v = 0;
      fb.forEach(b => { v = (v << 8) | b; });
      if (field.signed && fb.length > 0 && (fb[0] & 0x80)) {
        v = v - (1 << (fb.length * 8));
      }
      const phys = (field.scale && field.scale !== 1) ? v * field.scale : v;
      const name = `${cmdDef.name}·${field.name}`;
      const sig = signalStore[name];
      if (sig) {
        sig.value = +phys.toFixed(2);
        sig.history.push({ t: now, v: phys });
        if (sig.history.length > 300) sig.history.shift();
      }
    }
    off += fieldLen;
  }

  /* 检查连线条件 */
  evaluateAllConnections();
}

/* ── 开关切换：构建 TX 帧 + 串口发送 ── */
async function toggleSwitch(signalName) {
  const sig = signalStore[signalName];
  if (!sig) return;
  const src = signalSourceMap[signalName];
  if (!src) return;

  if (sig.type === 'boolean') {
    const newVal = !sig.value;
    await sendControlFrame(src, newVal ? 1 : 0);
  } else if (sig.type === 'enum' && sig.options && sig.options.length > 0) {
    const curIdx = sig.options.findIndex(o => o.value === sig.value);
    const nextIdx = (curIdx + 1) % sig.options.length;
    await sendControlFrame(src, sig.options[nextIdx].value);
  }
}

/* 构建控制帧并发送到串口 */
async function sendControlFrame(src, bitOrEnumValue) {
  if (!hasElectron || !window.electronAPI.serial) return;
  const { cmdCode, fieldName, bit, fieldDef } = src;
  const cmdDef = protoFrame.cmds.find(c => c.cmd === cmdCode);
  if (!cmdDef) return;

  /* 构建 payload：按命令字段顺序填充，目标 bit/enum 写入新值 */
  const payload = [];
  for (const field of (cmdDef.fields || [])) {
    const len = field.length || 1;
    let val = 0;
    if (field.name === fieldName) {
      if (field.type === 'bitmap' && bit !== undefined) {
        /* 合并所有 bit 状态，目标 bit 写入新值 */
        for (const b of (field.bits || [])) {
          if (b.bit === bit) {
            if (bitOrEnumValue) val |= (1 << bit);
          } else {
            const bName = `${field.name}·${b.name}`;
            const bSig = signalStore[bName];
            if (bSig && bSig.value) val |= (1 << b.bit);
          }
        }
      } else if (field.type === 'enum') {
        val = bitOrEnumValue;
      } else {
        val = bitOrEnumValue;
      }
    } else {
      /* 非目标字段：从 signalStore 读取当前值 */
      if (field.type === 'bitmap' && field.bits) {
        for (const b of (field.bits || [])) {
          const bName = `${field.name}·${b.name}`;
          const bSig = signalStore[bName];
          if (bSig && bSig.value) val |= (1 << b.bit);
        }
      } else {
        const fName = `${cmdDef.name}·${field.name}`;
        const fSig = signalStore[fName];
        if (fSig) val = fSig.value;
      }
    }
    /* 按 length 拆分字节（大端） */
    for (let i = len - 1; i >= 0; i--) {
      payload.push((val >> (i * 8)) & 0xFF);
    }
  }

  /* 组帧：帧头 + 地址 + 命令字 + 长度 + 载荷 + 校验 + 帧尾 */
  const frame = [];
  protoFrame.frameHeader.forEach(b => frame.push(b));
  frame.push(protoFrame.address);
  const cmdLen = protoFrame.cmdLen;
  for (let i = cmdLen - 1; i >= 0; i--) {
    frame.push((cmdCode >> (i * 8)) & 0xFF);
  }
  frame.push(payload.length);
  payload.forEach(b => frame.push(b));

  /* 校验范围：地址 + 命令字 + 长度 + 载荷 */
  const checkBytes = [protoFrame.address];
  for (let i = cmdLen - 1; i >= 0; i--) {
    checkBytes.push((cmdCode >> (i * 8)) & 0xFF);
  }
  checkBytes.push(payload.length);
  payload.forEach(b => checkBytes.push(b));

  const checkResult = protoFrame.checkType === 'CRC16'
    ? crc16(checkBytes)
    : sumCheck(checkBytes);
  checkResult.forEach(b => frame.push(b));
  protoFrame.frameTail.forEach(b => frame.push(b));

  /* 转为 HEX 字符串 */
  const hexStr = frame.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');

  /* 获取活跃串口并发送 */
  try {
    const activeRes = await window.electronAPI.serial.active();
    if (activeRes && activeRes.length > 0) {
      await window.electronAPI.serial.send({
        portPath: activeRes[0],
        data: hexStr,
        format: 'hex',
      });
    }
  } catch (e) {
    console.warn('[CustomBoard] 串口发送失败:', e);
  }
}

/* ── 折线图数据构建 ── */
function buildChartPoints(card) {
  const sig = getSignal(card.config.signalName);
  if (!sig || !sig.history || sig.history.length < 2) return '';
  const tw = (card.config.timeWindow || 30) * 1000;
  const now = Date.now();
  const data = sig.history.filter((p) => p.t >= now - tw);
  if (data.length < 2) return '';
  const w = card.w - 24;
  const h = card.h - 60;
  let min = Infinity, max = -Infinity;
  for (const p of data) { if (p.v < min) min = p.v; if (p.v > max) max = p.v; }
  if (max === min) { max = min + 1; }
  const xStep = w / Math.max(1, data.length - 1);
  return data.map((p, i) => {
    const x = (i * xStep).toFixed(1);
    const y = (h - ((p.v - min) / (max - min)) * h).toFixed(1);
    return `${x},${y}`;
  }).join(' ');
}

function chartRange(card) {
  const sig = getSignal(card.config.signalName);
  if (!sig || !sig.history || sig.history.length === 0) return { min: 0, max: 0 };
  let min = Infinity, max = -Infinity;
  for (const p of sig.history) { if (p.v < min) min = p.v; if (p.v > max) max = p.v; }
  return { min, max };
}

/* ── 画布拖拽逻辑 ── */
let nextId = 1;
let nextConnId = 1;
const placedCards = reactive([]);
const connections = reactive([]); // 连线数据

/* 连线状态 */
const linkDragState = ref(null); // { fromCardId, startX, startY, curX, curY }
const pendingConnection = ref(null); // { fromCardId, toCardId } - 连线动画展示中
const linkConfigVisible = ref(false);
const linkConfigDraft = reactive({
  id: null,
  fromCardId: null,
  toCardId: null,
  conditionType: 'gt',   // gt / lt / eq / on / off
  conditionValue: 0,
  actionType: 'toggle',  // toggle / on / off
});

/* 获取卡片端口圆心在画布中的绝对坐标 */
function getPortPos(card, side) {
  if (!card) return { x: 0, y: 0 };
  // side: 'in' (左侧) / 'out' (右侧)
  // 端口容器 14x14，top:40px，left/right:-7px，圆心在容器中心
  const x = side === 'out' ? card.x + card.w : card.x;
  const y = card.y + 47; // 40(容器top) + 7(容器高度的一半) = 圆心Y
  return { x, y };
}

/* 生成贝塞尔曲线路径 */
function bezierPath(x1, y1, x2, y2) {
  const dx = Math.max(40, Math.abs(x2 - x1) * 0.5);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

/* 根据 ID 获取卡片 */
function getCardById(id) {
  return placedCards.find(c => c.id === id) || null;
}

/* 只渲染两端卡片都存在的连线，避免引用已删除卡片导致渲染崩溃 */
const validConnections = computed(() => {
  return connections.filter(c => getCardById(c.fromCardId) && getCardById(c.toCardId));
});

/* 计算连线中点坐标（用于删除按钮定位） */
function midPoint(conn) {
  const fromCard = getCardById(conn.fromCardId);
  const toCard = getCardById(conn.toCardId);
  if (!fromCard || !toCard) return { x: 0, y: 0 };
  const from = getPortPos(fromCard, 'out');
  const to = getPortPos(toCard, 'in');
  // 贝塞尔曲线中点近似 = 起点和终点的中点（近似即可）
  return { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
}

/* 源卡片信号是否为布尔类型 */
const isSourceBoolean = computed(() => {
  const card = getCardById(linkConfigDraft.fromCardId);
  if (!card || !card.config.signalName) return false;
  const sig = getSignal(card.config.signalName);
  return sig && sig.type === 'boolean';
});

/* 源卡片信号是否为枚举类型 */
const isSourceEnum = computed(() => {
  const card = getCardById(linkConfigDraft.fromCardId);
  if (!card || !card.config.signalName) return false;
  const sig = getSignal(card.config.signalName);
  return sig && sig.type === 'enum';
});

/* 源卡片枚举选项 */
const sourceEnumOptions = computed(() => {
  const card = getCardById(linkConfigDraft.fromCardId);
  if (!card || !card.config.signalName) return [];
  const sig = getSignal(card.config.signalName);
  return sig && sig.options ? sig.options : [];
});

/* 目标卡片信号是否可切换（布尔型） */
const isTargetToggleable = computed(() => {
  const card = getCardById(linkConfigDraft.toCardId);
  if (!card || !card.config.signalName) return false;
  const sig = getSignal(card.config.signalName);
  return sig && sig.type === 'boolean';
});

/* 取消连线配置 */
function cancelLinkConfig() {
  linkConfigVisible.value = false;
  linkDragState.value = null;
  pendingConnection.value = null;
}

/* 检查两个卡片是否可以连接 */
function canConnect(fromCard, toCard) {
  if (!fromCard || !toCard) return false;
  if (fromCard.id === toCard.id) return false;
  // 不能重复连接同一对卡片
  return !connections.some(c => c.fromCardId === fromCard.id && c.toCardId === toCard.id);
}

function onDragStart(e, comp) {
  e.dataTransfer.setData('text/plain', JSON.stringify({
    type: comp.type, iconRef: comp.iconRef, name: comp.name, w: comp.w, h: comp.h,
  }));
  e.dataTransfer.effectAllowed = 'copy';
}

function onDrop(e) {
  e.preventDefault();
  const raw = e.dataTransfer.getData('text/plain');
  if (!raw) return;
  const comp = JSON.parse(raw);
  // 相对于内层画布的坐标 = 鼠标视口坐标 + 滚动偏移 - 视口位置
  const vpRect = viewportRef.value.getBoundingClientRect();
  const x = Math.max(0, e.clientX - vpRect.left + viewportRef.value.scrollLeft - comp.w / 2);
  const y = Math.max(0, e.clientY - vpRect.top + viewportRef.value.scrollTop - 20);
  placedCards.push({
    id: nextId++,
    type: comp.type,
    iconRef: comp.iconRef,
    name: comp.name,
    x: Math.round(x / 10) * 10,
    y: Math.round(y / 10) * 10,
    w: comp.w,
    h: comp.h,
    config: { title: '', signalName: '', timeWindow: 30 },
    _flash: 0,
  });
  persist();
}

let dragState = null;
function startMove(e, card) {
  const el = e.target;
  if (el.closest('.placed-card-btn') || el.closest('.resize-handle') || el.closest('.switch-toggle') || el.closest('.enum-cycle-btn')) return;
  dragState = { mode: 'move', card, startX: e.clientX, startY: e.clientY, origX: card.x, origY: card.y };
  e.preventDefault();
}
function startResize(e, card) {
  dragState = { mode: 'resize', card, startX: e.clientX, startY: e.clientY, origW: card.w, origH: card.h };
  e.preventDefault();
}
function onMouseMove(e) {
  // 连线拖拽
  if (linkDragState.value) {
    const vpRect = viewportRef.value.getBoundingClientRect();
    const mouseX = e.clientX - vpRect.left + viewportRef.value.scrollLeft;
    const mouseY = e.clientY - vpRect.top + viewportRef.value.scrollTop;
    // 吸附检测：靠近输入端口时自动吸附到圆心
    const SNAP_DIST = 30;
    let snapped = false;
    for (const card of placedCards) {
      if (card.id === linkDragState.value.fromCardId) continue;
      const port = getPortPos(card, 'in');
      const dist = Math.hypot(mouseX - port.x, mouseY - port.y);
      if (dist < SNAP_DIST) {
        linkDragState.value.curX = port.x;
        linkDragState.value.curY = port.y;
        linkDragState.value.snapping = true;
        linkDragState.value.snappedCardId = card.id;
        snapped = true;
        break;
      }
    }
    if (!snapped) {
      linkDragState.value.curX = mouseX;
      linkDragState.value.curY = mouseY;
      linkDragState.value.snapping = false;
      linkDragState.value.snappedCardId = null;
    }
    return;
  }
  // 画布平移优先
  if (panState) {
    onPanMove(e);
    return;
  }
  if (!dragState) return;
  const dx = e.clientX - dragState.startX;
  const dy = e.clientY - dragState.startY;
  if (dragState.mode === 'move') {
    dragState.card.x = Math.max(0, Math.round((dragState.origX + dx) / 10) * 10);
    dragState.card.y = Math.max(0, Math.round((dragState.origY + dy) / 10) * 10);
  } else {
    dragState.card.w = Math.max(160, dragState.origW + dx);
    dragState.card.h = Math.max(100, dragState.origH + dy);
  }
}
function onMouseUp(e) {
  // 连线拖拽结束：检查是否落在输入端口上
  if (linkDragState.value) {
    const fromCard = placedCards.find(c => c.id === linkDragState.value.fromCardId);
    // 检查是否落在某个卡片的输入端口附近
    const vpRect = viewportRef.value.getBoundingClientRect();
    const mouseX = e.clientX - vpRect.left + viewportRef.value.scrollLeft;
    const mouseY = e.clientY - vpRect.top + viewportRef.value.scrollTop;

    let targetCard = null;
    for (const card of placedCards) {
      if (card.id === linkDragState.value.fromCardId) continue;
      const port = getPortPos(card, 'in');
      const dist = Math.hypot(mouseX - port.x, mouseY - port.y);
      if (dist < 20) {
        targetCard = card;
        break;
      }
    }

    if (targetCard && fromCard && canConnect(fromCard, targetCard)) {
      // 先展示连线动画，再弹出条件配置弹窗
      pendingConnection.value = { fromCardId: fromCard.id, toCardId: targetCard.id };
      linkDragState.value = null;
      // 根据源卡片信号类型默认条件
      const fromSig = getSignal(fromCard.config.signalName);
      if (fromSig && fromSig.type === 'boolean') {
        linkConfigDraft.conditionType = 'on';
      } else if (fromSig && fromSig.type === 'enum') {
        linkConfigDraft.conditionType = 'enum_eq';
        linkConfigDraft.conditionValue = fromSig.options && fromSig.options.length > 0 ? fromSig.options[0].value : 0;
      } else {
        linkConfigDraft.conditionType = 'gt';
        linkConfigDraft.conditionValue = 0;
      }
      // 根据目标卡片信号类型默认动作
      const toSig = getSignal(targetCard.config.signalName);
      if (toSig && toSig.type === 'boolean') {
        linkConfigDraft.actionType = 'toggle';
      } else {
        linkConfigDraft.actionType = 'highlight';
      }
      // 延迟弹出弹窗，让连线动画完整展示
      setTimeout(() => {
        linkConfigDraft.id = null;
        linkConfigDraft.fromCardId = fromCard.id;
        linkConfigDraft.toCardId = targetCard.id;
        pendingConnection.value = null;
        linkConfigVisible.value = true;
      }, 400);
    } else {
      linkDragState.value = null;
    }
    return;
  }
  onPanEnd();
  if (dragState) { persist(); dragState = null; }
}

/* 检查某卡片的输入端口当前是否被吸附 */
function isPortSnapped(cardId) {
  return linkDragState.value && linkDragState.value.snapping && linkDragState.value.snappedCardId === cardId;
}

/* 从输出端口开始连线 */
function startLinkDrag(e, card) {
  e.stopPropagation();
  e.preventDefault();
  const vpRect = viewportRef.value.getBoundingClientRect();
  const port = getPortPos(card, 'out');
  linkDragState.value = {
    fromCardId: card.id,
    startX: port.x,
    startY: port.y,
    curX: port.x,
    curY: port.y,
  };
}

/* 保存连线配置 */
function saveLinkConfig() {
  const conn = {
    id: nextConnId++,
    fromCardId: linkConfigDraft.fromCardId,
    toCardId: linkConfigDraft.toCardId,
    conditionType: linkConfigDraft.conditionType,
    conditionValue: Number(linkConfigDraft.conditionValue),
    actionType: linkConfigDraft.actionType,
  };
  connections.push(conn);
  linkConfigVisible.value = false;
  persist();
}

/* 删除连线 */
function deleteConnection(id) {
  const idx = connections.findIndex(c => c.id === id);
  if (idx >= 0) {
    connections.splice(idx, 1);
    persist();
  }
}

/* 条件判断 */
function evaluateCondition(conn, fromCard) {
  const sig = getSignal(fromCard.config.signalName);
  if (!sig) return false;
  const val = sig.value;
  switch (conn.conditionType) {
    case 'gt': return val > conn.conditionValue;
    case 'lt': return val < conn.conditionValue;
    case 'eq': return Math.abs(val - conn.conditionValue) < 0.001;
    case 'on': return val === true;
    case 'off': return val === false;
    case 'enum_eq': return val === Number(conn.conditionValue);
    default: return false;
  }
}

/* 执行触发动作 */
function executeAction(conn, toCard) {
  const sig = getSignal(toCard.config.signalName);
  // 连线闪烁提示
  conn._flash = 3;
  if (!sig) {
    // 即使没有信号，也高亮卡片作为反馈
    toCard._flash = 3;
    return;
  }
  switch (conn.actionType) {
    case 'toggle':
      sig.value = !sig.value;
      sig.history.push({ t: Date.now(), v: sig.value ? 1 : 0 });
      if (sig.history.length > 300) sig.history.shift();
      break;
    case 'on':
      if (!sig.value) {
        sig.value = true;
        sig.history.push({ t: Date.now(), v: 1 });
        if (sig.history.length > 300) sig.history.shift();
      }
      break;
    case 'off':
      if (sig.value) {
        sig.value = false;
        sig.history.push({ t: Date.now(), v: 0 });
        if (sig.history.length > 300) sig.history.shift();
      }
      break;
    case 'highlight':
      // 高亮目标卡片（闪烁效果）
      toCard._flash = 3;
      break;
  }
}

/* 检查所有连线的条件（收到串口数据帧后调用） */
function evaluateAllConnections() {
  for (const conn of connections) {
    const fromCard = placedCards.find(c => c.id === conn.fromCardId);
    const toCard = placedCards.find(c => c.id === conn.toCardId);
    if (!fromCard || !toCard) continue;
    if (evaluateCondition(conn, fromCard)) {
      // 防抖：避免每帧都触发
      if (!conn._lastTriggered || Date.now() - conn._lastTriggered > 1000) {
        executeAction(conn, toCard);
        conn._lastTriggered = Date.now();
      }
    }
  }
}

function removeCard(id) {
  const idx = placedCards.findIndex((c) => c.id === id);
  if (idx >= 0) {
    placedCards.splice(idx, 1);
    // 删除与该卡片相关的所有连线
    for (let i = connections.length - 1; i >= 0; i--) {
      if (connections[i].fromCardId === id || connections[i].toCardId === id) {
        connections.splice(i, 1);
      }
    }
    persist();
  }
}
function clearBoard() {
  placedCards.splice(0);
  connections.splice(0);
  persist();
}

/* ── 配置弹窗 ── */
const configVisible = ref(false);
const configCard = ref(null);
const configDraft = reactive({ title: '', signalName: '', timeWindow: 30 });

function openConfig(card) {
  configCard.value = card;
  configDraft.title = card.config.title || '';
  configDraft.signalName = card.config.signalName || '';
  configDraft.timeWindow = card.config.timeWindow || 30;
  configVisible.value = true;
}
function closeConfig() { configVisible.value = false; configCard.value = null; }
function saveConfig() {
  if (configCard.value) {
    configCard.value.config.title = configDraft.title;
    configCard.value.config.signalName = configDraft.signalName;
    configCard.value.config.timeWindow = configDraft.timeWindow;
    persist();
  }
  closeConfig();
}

/* ── localStorage 持久化 ── */
const STORAGE_KEY = 'spm-board-layout';
const CONN_STORAGE_KEY = 'spm-board-connections';
function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(placedCards));
    localStorage.setItem(CONN_STORAGE_KEY, JSON.stringify(connections));
  } catch (_) {}
}
function restore() {
  try {
    // 恢复卡片
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      if (Array.isArray(saved)) {
        placedCards.splice(0);
        for (const c of saved) {
          placedCards.push({ ...c, config: c.config || { title: '', signalName: '', timeWindow: 30 }, iconRef: c.iconRef || componentLibrary.find((lib) => lib.type === c.type)?.iconRef || 'i-board-card', _flash: 0 });
          if (c.id >= nextId) nextId = c.id + 1;
        }
      }
    }
    // 恢复连线（过滤掉引用了不存在卡片的孤儿连线）
    const connRaw = localStorage.getItem(CONN_STORAGE_KEY);
    if (connRaw) {
      const savedConns = JSON.parse(connRaw);
      if (Array.isArray(savedConns)) {
        connections.splice(0);
        for (const c of savedConns) {
          // 只恢复两端卡片都存在的连线
          if (placedCards.find(card => card.id === c.fromCardId) &&
              placedCards.find(card => card.id === c.toCardId)) {
            connections.push({ ...c, _lastTriggered: 0, _flash: 0 });
            if (c.id >= nextConnId) nextConnId = c.id + 1;
          }
        }
      }
    }
  } catch (_) {}
}

/* 卡片闪烁效果递减 */
let flashTimer = null;
function startFlashTicker() {
  flashTimer = setInterval(() => {
    let hasFlash = false;
    for (const card of placedCards) {
      if (card._flash > 0) {
        card._flash--;
        hasFlash = true;
      }
    }
    for (const conn of connections) {
      if (conn._flash > 0) {
        conn._flash--;
        hasFlash = true;
      }
    }
    if (!hasFlash) {
      // 没有闪烁项时可以暂停，但为简单起见保持运行
    }
  }, 200);
}

onMounted(() => {
  loadProtoList();
  restore();
  startFlashTicker();
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
  /* 监听串口真实数据 */
  if (hasElectron && window.electronAPI.serial) {
    unsubSerialData = window.electronAPI.serial.onData(onSerialData);
  }
});
onUnmounted(() => {
  if (unsubSerialData) unsubSerialData();
  if (flashTimer) clearInterval(flashTimer);
  stopDemoAnimation();
  window.removeEventListener('mousemove', onMouseMove);
  window.removeEventListener('mouseup', onMouseUp);
});
</script>

<style scoped>
.board-layout {
  display: flex;
  gap: 16px;
  flex: 1;
  min-height: 0;
  height: calc(100% - 130px);
}

/* 左侧组件库 */
.board-sidebar {
  width: 240px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.sidebar-section {
  padding: 14px 16px 8px;
  border-bottom: 1px solid var(--border-light);
}
.sidebar-section h3 { font-size: 13px; font-weight: 600; color: var(--text-primary); }
.sidebar-hint { font-size: 11px; color: var(--text-tertiary); margin-top: 2px; }

.proto-selector-section {
  padding: 10px 16px;
  border-bottom: 1px solid var(--border-light);
}
.proto-selector-label {
  display: block;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-tertiary);
  margin-bottom: 6px;
}
.proto-selector {
  width: 100%;
  font-size: 12px;
}

.component-list {
  padding: 8px;
  overflow-y: auto;
  flex: 1;
}

.component-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  cursor: grab;
  transition: background 0.15s ease, border-color 0.15s ease;
  border: 1px solid transparent;
  margin-bottom: 4px;
}
.component-item:hover {
  background: var(--bg-tertiary);
  border-color: var(--border-light);
}
.component-item:active { cursor: grabbing; }
.component-icon { flex-shrink: 0; color: var(--accent-color, #f59e0b); }
.component-info { display: flex; flex-direction: column; gap: 2px; }
.component-info b { font-size: 13px; color: var(--text-primary); }
.component-info span { font-size: 11px; color: var(--text-tertiary); }

/* 悬浮预览窗 */
.comp-preview-popover {
  position: fixed;
  left: calc(var(--board-sidebar-width, 220px) + 8px);
  width: 260px;
  background: var(--bg-secondary);
  border: 1px solid var(--accent-color, #f59e0b);
  border-radius: var(--radius-md, 8px);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  z-index: 1000;
  padding: 12px;
  pointer-events: none;
}
.comp-preview-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--accent-color, #f59e0b);
  margin-bottom: 10px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border-color, #2d2d3f);
}
.comp-preview-demo {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.comp-preview-tip {
  font-size: 10px;
  color: var(--text-tertiary, #6b7280);
  text-align: center;
  margin-top: 8px;
  padding-top: 6px;
  border-top: 1px solid var(--border-color, #2d2d3f);
}

/* 数据卡片示例 */
.data-card-demo { flex-direction: row; gap: 8px; }
.demo-card {
  flex: 1;
  background: var(--bg-tertiary, #1a1a2e);
  border: 1px solid var(--border-color, #2d2d3f);
  border-radius: 6px;
  padding: 8px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}
.demo-card-header { font-size: 10px; color: var(--text-tertiary, #6b7280); }
.demo-card-value { font-size: 18px; font-weight: 700; }
.demo-card-value.number { color: #60a5fa; transition: color 0.3s; }
.demo-card-value.boolean { color: #22c55e; transition: color 0.3s; }
.demo-card-value.boolean.flash { color: #22c55e; animation: value-flash 0.3s ease; }
@keyframes value-flash {
  0% { transform: scale(1); }
  50% { transform: scale(1.15); }
  100% { transform: scale(1); }
}
.demo-card-unit { font-size: 9px; color: var(--text-tertiary, #6b7280); }

/* 趋势曲线示例 */
.chart-demo { padding: 4px; }
.demo-chart {
  background: var(--bg-tertiary, #1a1a2e);
  border: 1px solid var(--border-color, #2d2d3f);
  border-radius: 6px;
  padding: 8px;
}
.demo-chart-title { font-size: 10px; color: var(--text-tertiary, #6b7280); margin-bottom: 4px; }
.demo-chart-svg { width: 100%; height: 50px; display: block; }
.demo-chart-svg polyline { transition: all 0.4s ease; }
.demo-chart-axis { display: flex; justify-content: space-between; font-size: 9px; color: var(--text-tertiary, #6b7280); margin-top: 2px; }

/* 信号开关示例 */
.switch-demo { gap: 6px; }
.demo-switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--bg-tertiary, #1a1a2e);
  border: 1px solid var(--border-color, #2d2d3f);
  border-radius: 6px;
  padding: 6px 8px;
}
.demo-switch-label { font-size: 11px; color: var(--text-secondary, #9ca3af); }
.demo-switch-track {
  width: 32px; height: 16px; border-radius: 8px;
  display: flex; align-items: center;
  transition: background 0.2s;
}
.demo-switch-track.on { background: #22c55e; justify-content: flex-end; }
.demo-switch-track.off { background: #4b5563; justify-content: flex-start; }
.demo-switch-knob { width: 12px; height: 12px; border-radius: 50%; background: white; margin: 2px; }
.demo-switch-state { font-size: 10px; font-weight: 600; min-width: 24px; text-align: right; }
.demo-switch-state.on { color: #22c55e; }
.demo-switch-state.off { color: #6b7280; }

/* 预览窗过渡动画 */
.comp-preview-enter-active, .comp-preview-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.comp-preview-enter-from, .comp-preview-leave-to {
  opacity: 0;
  transform: translateX(-8px);
}
.signal-list {
  flex: 1;
  overflow-y: auto;
  padding: 6px 8px;
}
.signal-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border-radius: var(--radius-sm);
}
.signal-item:hover { background: var(--bg-tertiary); }
.signal-dot {
  width: 6px; height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}
.signal-dot.number { background: var(--accent-color); }
.signal-dot.boolean { background: #22c55e; }
.signal-dot.enum { background: #a855f7; }
.signal-name { font-size: 12px; color: var(--text-secondary); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.signal-type-tag { font-size: 10px; color: var(--text-tertiary); }

/* 右侧画布 */
/* 视口（外层容器，可滚动） */
.board-viewport {
  flex: 1;
  position: relative;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  overflow: auto;
  cursor: grab;
}
.board-viewport:active { cursor: grabbing; }

/* 内层画布（大尺寸，可平移） */
.board-canvas-inner {
  position: relative;
  width: 3000px;
  height: 2000px;
  background-image:
    linear-gradient(var(--border-light) 1px, transparent 1px),
    linear-gradient(90deg, var(--border-light) 1px, transparent 1px);
  background-size: 20px 20px;
}
.board-canvas-inner.is-panning {
  cursor: grabbing;
  user-select: none;
}

.canvas-empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  /* 居中显示在视口范围内，不随滚动偏移太远 */
  position: sticky;
  top: 50%;
  transform: translateY(-50%);
  height: 0;
  overflow: visible;
}
.canvas-empty-icon { color: var(--text-secondary); margin-bottom: 12px; opacity: 0.4; line-height: 0; }
.canvas-empty p { font-size: 15px; color: var(--text-secondary); font-weight: 500; margin: 0; }
.canvas-empty span { font-size: 12px; color: var(--text-tertiary); margin-top: 4px; display: block; }
.canvas-empty-tip {
  margin-top: 12px !important;
  padding: 6px 12px;
  background: var(--bg-tertiary);
  border-radius: 999px;
  display: inline-block !important;
  font-size: 11px !important;
}

/* 已放置的卡片 */
.placed-card {
  position: absolute;
  z-index: 2;
  display: flex;
  flex-direction: column;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  cursor: move;
  user-select: none;
  overflow: hidden;
}
.placed-card:hover {
  border-color: var(--accent-color);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
}
.placed-card.unbound { border-style: dashed; }

.placed-card-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border-light);
  background: var(--bg-secondary);
}
.placed-card-icon { flex-shrink: 0; color: var(--accent-color, #f59e0b); }
.placed-card-name { font-size: 12px; font-weight: 600; color: var(--text-primary); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.placed-card-btn {
  width: 20px; height: 20px;
  display: flex; align-items: center; justify-content: center;
  border: none; background: transparent;
  color: var(--text-tertiary);
  font-size: 14px; line-height: 1;
  cursor: pointer; border-radius: var(--radius-sm);
  transition: all 0.15s ease;
}
.placed-card-btn:hover { background: var(--bg-tertiary); color: var(--text-primary); }
.placed-card-btn.close:hover { background: rgba(220, 38, 38, 0.1); color: #dc2626; }

.placed-card-body {
  flex: 1;
  overflow: hidden;
  padding: 12px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

/* 数据卡片 */
.data-card-view { text-align: center; }
.data-value {
  font-size: 28px;
  font-weight: 700;
  line-height: 1.2;
  margin: 0;
}
.data-value.number { color: var(--accent-color); }
.data-value.boolean { color: #22c55e; }
.data-value.enum { color: #a855f7; }
.data-value small { font-size: 14px; font-weight: 400; color: var(--text-tertiary); margin-left: 4px; }
.data-signal-name { font-size: 11px; color: var(--text-tertiary); margin-top: 4px; }

.data-unbound {
  font-size: 13px;
  color: var(--text-tertiary);
  text-align: center;
  line-height: 1.5;
}
.data-unbound span { font-size: 11px; }

/* 折线图 */
.chart-view { width: 100%; height: 100%; display: flex; flex-direction: column; align-self: stretch; }
.chart-svg { display: block; }
.chart-line { fill: none; stroke: var(--accent-color, #f59e0b); stroke-width: 1.5; }
.chart-grid-line { stroke: var(--border-light, rgba(0,0,0,0.06)); stroke-dasharray: 2 3; }
.chart-labels {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: var(--text-tertiary);
  padding-top: 4px;
}

/* 信号开关 */
.switch-view { text-align: center; }
.switch-toggle {
  width: 48px; height: 28px;
  border-radius: 14px;
  border: none;
  background: var(--bg-tertiary);
  position: relative;
  cursor: pointer;
  transition: background 0.2s ease;
  padding: 0;
}
.switch-toggle.on { background: #22c55e; }
.switch-knob {
  position: absolute;
  top: 3px; left: 3px;
  width: 22px; height: 22px;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.2s ease;
  box-shadow: 0 1px 3px rgba(0,0,0,0.2);
}
.switch-toggle.on .switch-knob { transform: translateX(20px); }
.switch-state { font-size: 13px; font-weight: 600; color: var(--text-secondary); margin-top: 6px; }
.switch-state.enum-label { color: var(--accent-color, #f59e0b); font-size: 14px; }
.enum-cycle-btn {
  padding: 4px 14px;
  font-size: 13px;
  font-weight: 600;
  color: var(--accent-color, #f59e0b);
  background: color-mix(in srgb, var(--accent-color, #f59e0b) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent-color, #f59e0b) 40%, transparent);
  border-radius: 14px;
  cursor: pointer;
  transition: all 0.15s ease;
}
.enum-cycle-btn:hover {
  background: color-mix(in srgb, var(--accent-color, #f59e0b) 20%, transparent);
  border-color: var(--accent-color, #f59e0b);
}
.switch-signal-name { font-size: 11px; color: var(--text-tertiary); }

/* 调整大小手柄 */
.resize-handle {
  position: absolute;
  right: 0; bottom: 0;
  width: 16px; height: 16px;
  cursor: nwse-resize;
  background: linear-gradient(135deg, transparent 50%, var(--border-color) 50%, var(--border-color) 60%, transparent 60%, transparent 70%, var(--border-color) 70%, var(--border-color) 80%, transparent 80%);
}
.resize-handle:hover {
  background: linear-gradient(135deg, transparent 50%, var(--accent-color) 50%, var(--accent-color) 60%, transparent 60%, transparent 70%, var(--accent-color) 70%, var(--accent-color) 80%, transparent 80%);
}

/* ── 连线层 ── */
.connections-layer {
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
  z-index: 1;
}
.connection-path {
  fill: none;
  stroke: #f59e0b;
  stroke-width: 2;
  opacity: 0.7;
  transition: stroke 0.2s, stroke-width 0.2s, opacity 0.2s;
  pointer-events: stroke;
  cursor: pointer;
}
.connection-path:hover {
  stroke-width: 3;
  opacity: 1;
}
.connection-path.dragging {
  stroke: #fbbf24;
  stroke-dasharray: 6 4;
  opacity: 0.8;
  animation: dash-flow 0.5s linear infinite;
}
.connection-path.dragging.snapped {
  stroke: #22c55e;
  stroke-dasharray: none;
  stroke-width: 3;
  opacity: 1;
  animation: none;
  filter: drop-shadow(0 0 4px rgba(34, 197, 94, 0.5));
}
.connection-path.pending {
  stroke: #f59e0b;
  stroke-width: 2.5;
  opacity: 0;
  stroke-dasharray: 1000;
  stroke-dashoffset: 1000;
  animation: draw-line 0.4s ease-out forwards;
}
@keyframes draw-line {
  0% { opacity: 0; stroke-dashoffset: 1000; }
  20% { opacity: 1; }
  100% { opacity: 1; stroke-dashoffset: 0; }
}
@keyframes dash-flow {
  to { stroke-dashoffset: -10; }
}
.connection-path.active {
  stroke: #22c55e;
  stroke-width: 3;
  filter: drop-shadow(0 0 4px rgba(34, 197, 94, 0.6));
}

/* 连线删除按钮 */
.conn-delete-btn {
  cursor: pointer;
  pointer-events: auto;
  opacity: 0;
  transition: opacity 0.15s;
}
.connection-group:hover .conn-delete-btn {
  opacity: 1;
}
.conn-delete-btn:hover circle {
  fill: #fef2f2;
}

/* ── 卡片端口 ── */
.card-port {
  position: absolute;
  top: 40px;
  width: 14px;
  height: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2;
}
.card-port.port-in {
  left: -7px;
}
.card-port.port-out {
  right: -7px;
  cursor: crosshair;
}
.port-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #fff;
  border: 2px solid #f59e0b;
  transition: all 0.15s ease;
}
.card-port.port-out:hover .port-dot {
  width: 12px;
  height: 12px;
  background: #f59e0b;
  box-shadow: 0 0 6px rgba(245, 158, 11, 0.6);
}
.card-port.port-in .port-dot {
  border-color: #9ca3af;
}
.placed-card:hover .card-port.port-in .port-dot {
  border-color: #f59e0b;
}
.card-port.port-in.port-hover .port-dot {
  border-color: #22c55e;
  background: #22c55e;
  width: 14px;
  height: 14px;
  box-shadow: 0 0 8px rgba(34, 197, 94, 0.6);
  animation: port-pulse 0.6s ease-in-out infinite;
}
@keyframes port-pulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.2); }
}

/* ── 卡片闪烁效果 ── */
.card-flash {
  animation: card-flash-pulse 0.3s ease-in-out;
  box-shadow: 0 0 0 2px #22c55e, 0 0 16px rgba(34, 197, 94, 0.5);
}
@keyframes card-flash-pulse {
  0%, 100% { box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1); }
  50% { box-shadow: 0 0 0 3px #22c55e, 0 0 20px rgba(34, 197, 94, 0.6); }
}

/* ── 连线配置弹窗 ── */
.link-config-summary {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 12px 16px;
  background: var(--bg-secondary);
  border-radius: var(--radius-sm);
  margin-bottom: 16px;
}
.link-summary-card {
  padding: 6px 12px;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  font-size: 12px;
  font-weight: 500;
  color: var(--text-primary);
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.link-summary-arrow {
  color: var(--accent-color);
  font-size: 16px;
  font-weight: bold;
}
.link-config-hint {
  margin-top: 12px;
  padding: 8px 12px;
  background: rgba(245, 158, 11, 0.08);
  border-radius: var(--radius-sm);
  font-size: 11px;
  color: var(--text-secondary);
  line-height: 1.5;
}
</style>
