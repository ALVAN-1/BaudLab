<template>
  <div class="view">
    <div class="view-header">
      <div>
        <h1 class="view-title">协议预览</h1>
        <p class="view-subtitle">浏览协议完整文档，支持 Markdown / PDF 样式切换</p>
      </div>
      <div class="view-actions">
        <button v-if="selectedProtocol" class="btn btn-secondary btn-small" @click="copyMarkdown">复制 Markdown</button>
        <button v-if="selectedProtocol && viewMode === 'pdf'" class="btn btn-primary btn-small" @click="printDoc">打印</button>
      </div>
    </div>

    <div class="preview-layout">
      <!-- 左侧协议列表 -->
      <aside class="proto-sidebar">
        <div class="sidebar-search">
          <input type="text" class="input" v-model="searchText" placeholder="搜索协议…" />
        </div>
        <div class="proto-list">
          <div
            v-for="p in filteredProtocols"
            :key="p.id"
            class="proto-item"
            :class="{ active: selectedId === p.id }"
            @click="selectProtocol(p)"
          >
            <div class="proto-item-name">{{ p.name }}</div>
            <div class="proto-item-meta">
              <span class="proto-ver">{{ p.version }}</span>
              <span class="proto-cmd-count">{{ p.cmdCount }} 条命令</span>
            </div>
          </div>
          <div v-if="filteredProtocols.length === 0" class="proto-empty">
            {{ loading ? '加载中…' : '暂无协议' }}
          </div>
        </div>
      </aside>

      <!-- 右侧文档区 -->
      <div class="doc-container">
        <!-- 格式切换 -->
        <div v-if="selectedProtocol" class="doc-toolbar">
          <div class="tab-bar" style="margin-bottom: 0;">
            <button :class="['tab-btn', { active: viewMode === 'md' }]" @click="viewMode = 'md'">Markdown</button>
            <button :class="['tab-btn', { active: viewMode === 'pdf' }]" @click="viewMode = 'pdf'">PDF 样式</button>
          </div>
        </div>

        <!-- 未选择协议 -->
        <div v-if="!selectedProtocol" class="doc-empty">
          <p>从左侧选择一个协议查看文档</p>
        </div>

        <!-- Markdown 视图 -->
        <div v-else-if="viewMode === 'md'" class="doc-scroll md-view">
          <h1 class="doc-title">{{ selectedProtocol.name }}</h1>
          <p class="doc-version">版本 {{ selectedProtocol.version }} · 更新于 {{ selectedProtocol.updated_at }}</p>
          <p v-if="selectedProtocol.protoDesc" class="doc-desc">{{ selectedProtocol.protoDesc }}</p>

          <h2>帧结构</h2>
          <div class="md-frame-info">
            <div><b>字节序：</b>{{ selectedProtocol.endianness || '小端 (Little-Endian)' }}</div>
            <div><b>校验方式：</b>{{ selectedProtocol.checkType || 'CRC16-MODBUS' }}</div>
            <div><b>校验范围：</b>{{ selectedProtocol.checkStart || 'SOF' }} → {{ selectedProtocol.checkEnd || 'DATA' }}</div>
            <div><b>帧模式：</b>{{ selectedProtocol.frameMode || 'fixed' }}</div>
          </div>
          <table v-if="selectedProtocol.fieldOrder?.length" class="md-table">
            <thead><tr><th>#</th><th>字段</th><th>说明</th></tr></thead>
            <tbody>
              <tr v-for="(f, i) in selectedProtocol.fieldOrder" :key="f">
                <td>{{ i + 1 }}</td>
                <td><code>{{ f }}</code></td>
                <td>{{ fieldDesc(f) }}</td>
              </tr>
            </tbody>
          </table>

          <h2>模块地址</h2>
          <table v-if="selectedProtocol.modules?.length" class="md-table">
            <thead><tr><th>模块名称</th><th>地址</th></tr></thead>
            <tbody>
              <tr v-for="m in selectedProtocol.modules" :key="m.name">
                <td>{{ m.name }}</td>
                <td><code>{{ m.addressBytes?.join(' ') || m.address || '—' }}</code></td>
              </tr>
            </tbody>
          </table>
          <p v-else class="md-muted">无模块地址定义</p>

          <h2>命令列表</h2>
          <div v-for="cmd in selectedProtocol.commands" :key="cmd.cmd + cmd.name" class="md-cmd-block">
            <h3>{{ cmd.name }} <code class="md-cmd-code">{{ cmd.cmd }}</code></h3>
            <div class="md-cmd-meta">
              <span>方向：{{ cmd.dir === 'tx' ? '发送 →' : '← 接收' }}</span>
              <span>发送方：{{ cmd.sender || '—' }}</span>
              <span>接收方：{{ cmd.receiver || '—' }}</span>
              <span v-if="cmd.cycle && cmd.cycle !== '0'">周期：{{ cmd.cycle }}ms</span>
            </div>
            <table v-if="cmd.fields?.length" class="md-table">
              <thead><tr><th>字段名</th><th>偏移</th><th>长度</th><th>类型</th><th>缩放</th><th>单位</th></tr></thead>
              <tbody>
                <tr v-for="field in cmd.fields" :key="field.name">
                  <td>{{ field.name }}</td>
                  <td>{{ field.offset }}</td>
                  <td>{{ field.length }}</td>
                  <td>{{ field.type }}</td>
                  <td>{{ field.scale ?? 1 }}</td>
                  <td>{{ field.unit || '—' }}</td>
                </tr>
              </tbody>
            </table>
            <p v-else class="md-muted">无字段定义</p>
            <!-- 位域展示 -->
            <template v-if="cmd.fields?.some(f => f.bits)">
              <h4>位域定义</h4>
              <div v-for="field in cmd.fields.filter(f => f.bits)" :key="field.name" class="md-bits">
                <table class="md-table">
                  <thead><tr><th>位</th><th>名称</th></tr></thead>
                  <tbody>
                    <tr v-for="bit in field.bits" :key="bit.bit">
                      <td>bit{{ bit.bit }}</td>
                      <td>{{ bit.name }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </template>
            <!-- 枚举展示 -->
            <template v-if="cmd.fields?.some(f => f.options)">
              <h4>枚举定义</h4>
              <div v-for="field in cmd.fields.filter(f => f.options)" :key="field.name" class="md-enum">
                <p><code>{{ field.name }}</code></p>
                <table class="md-table">
                  <thead><tr><th>值</th><th>含义</th></tr></thead>
                  <tbody>
                    <tr v-for="opt in field.options" :key="opt.value">
                      <td><code>0x{{ opt.value.toString(16).toUpperCase().padStart(2, '0') }}</code></td>
                      <td>{{ opt.label }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </template>
          </div>
        </div>

        <!-- PDF 样式视图 -->
        <div v-else class="doc-scroll pdf-view">
          <div class="pdf-page" id="pdf-print-area">
            <!-- 顶部封面横幅 -->
            <div class="pdf-cover">
              <h1>{{ selectedProtocol.name }}</h1>
              <p class="pdf-cover-sub">串口协议文档</p>
              <div class="pdf-cover-meta">
                <span>版本<strong>v{{ selectedProtocol.version }}</strong></span>
                <span>{{ selectedProtocol.commands?.length || 0 }} 条命令</span>
                <span>{{ selectedProtocol.modules?.length || 0 }} 个模块</span>
              </div>
            </div>

            <div class="pdf-body">
              <p v-if="selectedProtocol.protoDesc" class="pdf-desc">{{ selectedProtocol.protoDesc }}</p>

              <h2 class="pdf-h2">一、帧结构</h2>
              <table class="pdf-table">
                <tbody>
                  <tr><td style="width:120px;font-weight:600;color:#92400e;">字节序</td><td>{{ selectedProtocol.endianness || '小端 (Little-Endian)' }}</td></tr>
                  <tr><td style="font-weight:600;color:#92400e;">校验方式</td><td>{{ selectedProtocol.checkType || 'CRC16-MODBUS' }}</td></tr>
                  <tr><td style="font-weight:600;color:#92400e;">校验范围</td><td>{{ selectedProtocol.checkStart || 'SOF' }} → {{ selectedProtocol.checkEnd || 'DATA' }}</td></tr>
                  <tr><td style="font-weight:600;color:#92400e;">帧模式</td><td>{{ selectedProtocol.frameMode || 'fixed' }}</td></tr>
                </tbody>
              </table>

              <table v-if="selectedProtocol.fieldOrder?.length" class="pdf-table pdf-field-table">
                <thead><tr><th style="width:60px;">序号</th><th>字段</th><th>说明</th></tr></thead>
                <tbody>
                  <tr v-for="(f, i) in selectedProtocol.fieldOrder" :key="f">
                    <td style="text-align:center">{{ i + 1 }}</td>
                    <td>{{ f }}</td>
                    <td>{{ fieldDesc(f) }}</td>
                  </tr>
                </tbody>
              </table>

              <h2 class="pdf-h2">二、模块地址</h2>
              <table v-if="selectedProtocol.modules?.length" class="pdf-table">
                <thead><tr><th>模块名称</th><th style="width:180px;">地址</th></tr></thead>
                <tbody>
                  <tr v-for="m in selectedProtocol.modules" :key="m.name">
                    <td>{{ m.name }}</td>
                    <td style="font-family:'Consolas',monospace;">{{ m.addressBytes?.join(' ') || m.address || '—' }}</td>
                  </tr>
                </tbody>
              </table>
              <p v-else class="pdf-muted">无模块地址定义</p>

              <h2 class="pdf-h2">三、命令定义</h2>
              <div v-for="(cmd, idx) in selectedProtocol.commands" :key="cmd.cmd + cmd.name" class="pdf-cmd-section">
                <h3 class="pdf-h3">{{ idx + 1 }}. {{ cmd.name }} ({{ cmd.cmd }})</h3>
                <table class="pdf-table pdf-cmd-info">
                  <tbody>
                    <tr><td style="width:100px;font-weight:600;color:#92400e;">方向</td><td>{{ cmd.dir === 'tx' ? '发送 (TX)' : '接收 (RX)' }}</td></tr>
                    <tr><td style="font-weight:600;color:#92400e;">发送方</td><td>{{ cmd.sender || '—' }}</td></tr>
                    <tr><td style="font-weight:600;color:#92400e;">接收方</td><td>{{ cmd.receiver || '—' }}</td></tr>
                    <tr v-if="cmd.cycle && cmd.cycle !== '0'"><td style="font-weight:600;color:#92400e;">周期</td><td>{{ cmd.cycle }} ms</td></tr>
                  </tbody>
                </table>

                <table v-if="cmd.fields?.length" class="pdf-table pdf-field-table">
                  <thead><tr><th>字段名</th><th style="width:60px;">偏移</th><th style="width:60px;">长度</th><th style="width:100px;">类型</th><th style="width:60px;">缩放</th><th style="width:80px;">单位</th></tr></thead>
                  <tbody>
                    <tr v-for="field in cmd.fields" :key="field.name">
                      <td>{{ field.name }}</td>
                      <td style="text-align:center">{{ field.offset }}</td>
                      <td style="text-align:center">{{ field.length }}</td>
                      <td>{{ field.type }}</td>
                      <td style="text-align:center">{{ field.scale ?? 1 }}</td>
                      <td>{{ field.unit || '—' }}</td>
                    </tr>
                  </tbody>
                </table>

                <template v-if="cmd.fields?.some(f => f.bits)">
                  <h4 class="pdf-h4">位域定义</h4>
                  <div v-for="field in cmd.fields.filter(f => f.bits)" :key="field.name">
                    <p class="pdf-field-name">{{ field.name }}</p>
                    <table class="pdf-table">
                      <thead><tr><th style="width:80px;">位</th><th>名称</th></tr></thead>
                      <tbody>
                        <tr v-for="bit in field.bits" :key="bit.bit">
                          <td style="text-align:center;font-family:'Consolas',monospace;">bit{{ bit.bit }}</td>
                          <td>{{ bit.name }}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </template>

                <template v-if="cmd.fields?.some(f => f.options)">
                  <h4 class="pdf-h4">枚举定义</h4>
                  <div v-for="field in cmd.fields.filter(f => f.options)" :key="field.name">
                    <p class="pdf-field-name">{{ field.name }}</p>
                    <table class="pdf-table">
                      <thead><tr><th style="width:100px;">值</th><th>含义</th></tr></thead>
                      <tbody>
                        <tr v-for="opt in field.options" :key="opt.value">
                          <td style="font-family:'Consolas',monospace;">0x{{ opt.value.toString(16).toUpperCase().padStart(2, '0') }}</td>
                          <td>{{ opt.label }}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </template>
              </div>

              <div class="pdf-footer">
                <p>BaudLab · 文档生成于 {{ new Date().toLocaleString('zh-CN') }}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';

const hasElectron = typeof window !== 'undefined' && typeof window.electronAPI !== 'undefined';

const loading = ref(false);
const protocols = ref([]);
const selectedId = ref(null);
const selectedProtocol = ref(null);
const viewMode = ref('md');
const searchText = ref('');

const filteredProtocols = computed(() => {
  if (!searchText.value) return protocols.value;
  const q = searchText.value.toLowerCase();
  return protocols.value.filter((p) => p.name.toLowerCase().includes(q));
});

const FIELD_DESCRIPTIONS = {
  sof: '帧头标识',
  src: '源地址',
  dst: '目标地址',
  ver: '协议版本',
  cmd: '命令字',
  ctr: '控制字',
  seq: '序列号',
  tid: '事务ID',
  len: '数据长度',
  data: '数据负载',
  chk: '校验码',
  eof: '帧尾标识',
};

function fieldDesc(f) {
  return FIELD_DESCRIPTIONS[String(f).toLowerCase()] || '—';
}

async function loadProtocols() {
  if (!hasElectron) return;
  loading.value = true;
  try {
    const res = await window.electronAPI.db.query('SELECT id, name, version, config_json, byte_order, check_method, check_start, check_end, frame_mode, updated_at FROM protocols ORDER BY id');
    if (!res.success || !res.rows) return;
    const list = [];
    for (const p of res.rows) {
      let config = {};
      try { config = JSON.parse(p.config_json || '{}'); } catch (_) {}
      const cmdRes = await window.electronAPI.db.query('SELECT COUNT(*) as cnt FROM commands WHERE protocol_id = ?', [p.id]);
      list.push({
        id: p.id,
        name: p.name,
        version: p.version,
        protoDesc: config.protoDesc || '',
        endianness: config.endianness || (p.byte_order === 'little' ? '小端 (Little-Endian)' : '大端 (Big-Endian)'),
        checkType: config.checkType || p.check_method || 'CRC16-MODBUS',
        checkStart: config.checkStartField || p.check_start || 'SOF',
        checkEnd: config.checkEndField || p.check_end || 'DATA',
        frameMode: p.frame_mode || 'fixed',
        fieldOrder: config.fieldOrder || ['sof', 'src', 'dst', 'ver', 'cmd', 'ctr', 'seq', 'tid', 'len', 'data', 'chk', 'eof'],
        fieldConfig: config.fieldConfig || {},
        config_json: p.config_json,
        updated_at: p.updated_at,
        cmdCount: cmdRes.success ? cmdRes.rows[0].cnt : 0,
      });
    }
    protocols.value = list;
    if (list.length > 0) await selectProtocol(list[0]);
  } finally {
    loading.value = false;
  }
}

async function selectProtocol(p) {
  selectedId.value = p.id;
  if (!hasElectron) return;

  const [cmdRes, modRes] = await Promise.all([
    window.electronAPI.db.query('SELECT * FROM commands WHERE protocol_id = ? ORDER BY id', [p.id]),
    window.electronAPI.db.query('SELECT * FROM modules WHERE protocol_id = ? ORDER BY id', [p.id]),
  ]);

  const commands = [];
  if (cmdRes.success && cmdRes.rows) {
    for (const c of cmdRes.rows) {
      let cmdData = {};
      try { cmdData = JSON.parse(c.config_json || '{}'); } catch (_) {}
      commands.push({
        cmd: c.code,
        cmdBytes: cmdData.cmdBytes || [c.code.replace('0x', '')],
        name: c.name,
        sender: c.sender || '',
        receiver: c.receiver || '',
        dir: c.direction === 'send' ? 'tx' : 'rx',
        cycle: String(c.period_ms || 0),
        fields: cmdData.fields || [],
      });
    }
  }

  const modules = [];
  if (modRes.success && modRes.rows) {
    for (const m of modRes.rows) {
      modules.push({
        name: m.name,
        address: m.address,
        addressBytes: m.address ? m.address.split(' ') : ['00'],
      });
    }
  }

  selectedProtocol.value = {
    ...p,
    commands,
    modules: modules.length > 0 ? modules : [{ name: '主控制器', addressBytes: ['01'] }],
  };
}

function buildMarkdown() {
  const p = selectedProtocol.value;
  if (!p) return '';
  let md = `# ${p.name}\n\n`;
  md += `> 版本 ${p.version} · 更新于 ${p.updated_at}\n\n`;
  if (p.protoDesc) md += `${p.protoDesc}\n\n`;

  md += `## 帧结构\n\n`;
  md += `| 属性 | 值 |\n|---|---|\n`;
  md += `| 字节序 | ${p.endianness} |\n`;
  md += `| 校验方式 | ${p.checkType} |\n`;
  md += `| 校验范围 | ${p.checkStart} → ${p.checkEnd} |\n`;
  md += `| 帧模式 | ${p.frameMode} |\n\n`;

  if (p.fieldOrder?.length) {
    md += `| # | 字段 | 说明 |\n|---|---|---|\n`;
    p.fieldOrder.forEach((f, i) => {
      md += `| ${i + 1} | \`${f}\` | ${fieldDesc(f)} |\n`;
    });
    md += '\n';
  }

  md += `## 模块地址\n\n`;
  if (p.modules?.length) {
    md += `| 模块名称 | 地址 |\n|---|---|\n`;
    p.modules.forEach((m) => {
      md += `| ${m.name} | \`${m.addressBytes?.join(' ') || m.address || '—'}\` |\n`;
    });
    md += '\n';
  } else {
    md += `无模块地址定义\n\n`;
  }

  md += `## 命令列表\n\n`;
  for (const cmd of p.commands) {
    md += `### ${cmd.name} \`${cmd.cmd}\`\n\n`;
    md += `- 方向：${cmd.dir === 'tx' ? '发送 →' : '← 接收'}\n`;
    md += `- 发送方：${cmd.sender || '—'}\n`;
    md += `- 接收方：${cmd.receiver || '—'}\n`;
    if (cmd.cycle && cmd.cycle !== '0') md += `- 周期：${cmd.cycle}ms\n`;
    md += '\n';

    if (cmd.fields?.length) {
      md += `| 字段名 | 偏移 | 长度 | 类型 | 缩放 | 单位 |\n|---|---|---|---|---|---|\n`;
      for (const f of cmd.fields) {
        md += `| ${f.name} | ${f.offset} | ${f.length} | ${f.type} | ${f.scale ?? 1} | ${f.unit || '—'} |\n`;
      }
      md += '\n';
    }

    const bitsFields = cmd.fields?.filter((f) => f.bits) || [];
    if (bitsFields.length) {
      md += `**位域定义**\n\n`;
      for (const f of bitsFields) {
        md += `| 位 | 名称 |\n|---|---|\n`;
        for (const b of f.bits) md += `| bit${b.bit} | ${b.name} |\n`;
        md += '\n';
      }
    }

    const enumFields = cmd.fields?.filter((f) => f.options) || [];
    if (enumFields.length) {
      md += `**枚举定义**\n\n`;
      for (const f of enumFields) {
        md += `*${f.name}*\n\n`;
        md += `| 值 | 含义 |\n|---|---|\n`;
        for (const o of f.options) {
          md += `| 0x${o.value.toString(16).toUpperCase().padStart(2, '0')} | ${o.label} |\n`;
        }
        md += '\n';
      }
    }
  }

  return md;
}

async function copyMarkdown() {
  const md = buildMarkdown();
  try {
    await navigator.clipboard.writeText(md);
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = md;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
}

function printDoc() {
  window.print();
}

onMounted(() => { loadProtocols(); });
</script>

<style scoped>
.preview-layout {
  display: flex;
  gap: 16px;
  flex: 1;
  min-height: 0;
  height: calc(100% - 130px);
}

/* 左侧协议列表 */
.proto-sidebar {
  width: 220px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.sidebar-search {
  padding: 10px;
  border-bottom: 1px solid var(--border-light);
}
.sidebar-search .input { font-size: 12px; }

.proto-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px;
}

.proto-item {
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background 0.15s ease;
  margin-bottom: 2px;
}
.proto-item:hover { background: var(--bg-tertiary); }
.proto-item.active {
  background: var(--bg-tertiary);
  border-left: 3px solid var(--accent-color, #f59e0b);
  padding-left: 9px;
}

.proto-item-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.proto-item-meta {
  display: flex;
  gap: 8px;
  margin-top: 3px;
}
.proto-ver { font-size: 11px; color: var(--accent-color, #f59e0b); }
.proto-cmd-count { font-size: 11px; color: var(--text-tertiary); }

.proto-empty {
  padding: 20px;
  text-align: center;
  color: var(--text-tertiary);
  font-size: 13px;
}

/* 右侧文档区 */
.doc-container {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.doc-toolbar {
  margin-bottom: 12px;
}

.doc-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-tertiary);
  font-size: 15px;
}

.doc-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 4px;
}

/* Markdown 视图 */
.md-view { max-width: 820px; }

.doc-title {
  font-size: 24px;
  font-weight: 700;
  color: var(--text-primary);
  margin-bottom: 4px;
}

.doc-version {
  font-size: 13px;
  color: var(--text-tertiary);
  margin-bottom: 16px;
}

.doc-desc {
  font-size: 14px;
  color: var(--text-secondary);
  margin-bottom: 24px;
  line-height: 1.6;
}

.md-view h2 {
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
  margin-top: 28px;
  margin-bottom: 12px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border-light);
}

.md-frame-info {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-bottom: 16px;
}
.md-frame-info > div {
  font-size: 13px;
  color: var(--text-secondary);
  padding: 6px 10px;
  background: var(--bg-secondary);
  border-radius: var(--radius-sm);
}

.md-table {
  width: 100%;
  border-collapse: collapse;
  margin-bottom: 16px;
  font-size: 13px;
}
.md-table th {
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-weight: 600;
  padding: 8px 10px;
  text-align: left;
  border-bottom: 2px solid var(--border-color);
}
.md-table td {
  padding: 8px 10px;
  border-bottom: 1px solid var(--border-light);
  color: var(--text-primary);
}
.md-table code {
  background: var(--bg-tertiary);
  padding: 2px 6px;
  border-radius: 3px;
  font-size: 12px;
  color: var(--accent-color, #f59e0b);
}

.md-cmd-block {
  margin-bottom: 24px;
  padding: 16px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-md);
}
.md-cmd-block h3 {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 8px;
}
.md-cmd-code {
  background: var(--bg-tertiary) !important;
  color: var(--accent-color, #f59e0b) !important;
}
.md-cmd-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  font-size: 12px;
  color: var(--text-tertiary);
  margin-bottom: 12px;
}
.md-cmd-block h4 {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  margin-top: 12px;
  margin-bottom: 6px;
}
.md-muted { font-size: 13px; color: var(--text-tertiary); }

/* PDF 样式视图 */
.pdf-view {
  background: var(--bg-tertiary);
  padding: 20px;
}

.pdf-page {
  background: white;
  color: #1a1a1a;
  max-width: 750px;
  margin: 0 auto;
  padding: 0;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.15);
  font-family: 'Georgia', 'Times New Roman', serif;
  font-size: 14px;
  line-height: 1.7;
  overflow: hidden;
}

/* 顶部品牌色横幅 */
.pdf-cover {
  background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
  color: white;
  padding: 40px 56px 36px;
  position: relative;
}
.pdf-cover::after {
  content: '';
  position: absolute;
  bottom: -1px;
  left: 0;
  right: 0;
  height: 4px;
  background: linear-gradient(90deg, #fbbf24, #f59e0b, #d97706);
}
.pdf-cover h1 {
  font-size: 26px;
  font-weight: 700;
  margin: 0 0 8px;
  letter-spacing: 1px;
}
.pdf-cover .pdf-cover-sub {
  font-size: 13px;
  opacity: 0.9;
  margin: 0;
}
.pdf-cover .pdf-cover-meta {
  display: flex;
  gap: 20px;
  margin-top: 16px;
  font-size: 12px;
  opacity: 0.85;
}
.pdf-cover .pdf-cover-meta span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.pdf-cover .pdf-cover-meta strong {
  font-weight: 600;
  background: rgba(255,255,255,0.2);
  padding: 2px 8px;
  border-radius: 4px;
  font-family: 'Consolas', monospace;
}

.pdf-body {
  padding: 32px 56px 48px;
}

.pdf-desc {
  font-size: 14px;
  color: #444;
  background: #fffbeb;
  border-left: 4px solid #f59e0b;
  padding: 12px 16px;
  border-radius: 0 6px 6px 0;
  margin-bottom: 24px;
  line-height: 1.6;
}

.pdf-h2 {
  font-size: 17px;
  font-weight: 700;
  margin-top: 28px;
  margin-bottom: 14px;
  display: flex;
  align-items: center;
  gap: 10px;
  color: #1a1a1a;
}
.pdf-h2::before {
  content: '';
  display: inline-block;
  width: 4px;
  height: 18px;
  background: linear-gradient(180deg, #f59e0b, #d97706);
  border-radius: 2px;
}
.pdf-h2 .pdf-h2-num {
  background: #f59e0b;
  color: white;
  font-size: 12px;
  font-weight: 600;
  padding: 2px 10px;
  border-radius: 20px;
  font-family: 'Arial', sans-serif;
  margin-left: 4px;
}

.pdf-h3 {
  font-size: 15px;
  font-weight: 700;
  margin-top: 18px;
  margin-bottom: 10px;
  color: #92400e;
  padding-bottom: 4px;
  border-bottom: 2px solid #fde68a;
}

.pdf-h4 {
  font-size: 13px;
  font-weight: 600;
  margin-top: 12px;
  margin-bottom: 6px;
  color: #b45309;
  display: flex;
  align-items: center;
  gap: 6px;
}
.pdf-h4::before {
  content: '';
  width: 6px;
  height: 6px;
  background: #f59e0b;
  border-radius: 50%;
}

.pdf-table {
  width: 100%;
  border-collapse: collapse;
  margin-bottom: 12px;
  font-size: 12px;
  font-family: 'Arial', sans-serif;
  border-radius: 6px;
  overflow: hidden;
  box-shadow: 0 1px 3px rgba(0,0,0,0.06);
}
.pdf-table th {
  background: linear-gradient(180deg, #fef3c7 0%, #fde68a 100%);
  color: #92400e;
  padding: 8px 10px;
  text-align: left;
  border: 1px solid #fcd34d;
  font-weight: 600;
  font-size: 12px;
}
.pdf-table td {
  padding: 7px 10px;
  border: 1px solid #fde68a;
  background: #fffbeb;
}
.pdf-table tr:nth-child(even) td {
  background: #fffef8;
}

.pdf-cmd-section {
  margin-bottom: 22px;
  padding: 14px 16px;
  background: #fffef8;
  border: 1px solid #fde68a;
  border-radius: 8px;
}
.pdf-cmd-section .pdf-h3 {
  margin-top: 0;
  border-bottom: none;
  padding-bottom: 0;
}

.pdf-field-name {
  font-size: 12px;
  font-weight: 600;
  margin-top: 8px;
  margin-bottom: 4px;
  color: #92400e;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: #fef3c7;
  padding: 3px 10px;
  border-radius: 4px;
}

.pdf-muted { font-size: 13px; color: #999; }

.pdf-footer {
  margin-top: 32px;
  padding-top: 12px;
  border-top: 2px solid #fde68a;
  text-align: center;
  font-size: 11px;
  color: #d97706;
  font-family: 'Arial', sans-serif;
}

@media print {
  .view-header, .doc-toolbar, .proto-sidebar { display: none !important; }
  .preview-layout { display: block !important; }
  .doc-container { display: block !important; }
  .pdf-view { background: white; padding: 0; }
  .pdf-page { box-shadow: none; max-width: none; }
}
</style>
