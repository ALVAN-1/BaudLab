/**
 * AI 工具上下文构建：把本工具的协议库 / 最近串口数据整理为注入 AI 的文本。
 * 上下文按请求临时组装（不进会话历史），每次提问都读取当前最新数据。
 * 任何一项查询失败都不阻塞提问——该部分静默留空。
 */
const MAX_PROTOCOLS = 15;   // 最多携带协议数
const MAX_COMMANDS = 20;    // 每协议最多指令数
const MAX_MODULES = 15;     // 每协议最多模块数
const MAX_FIELDS = 10;      // 每指令最多字段数
const MAX_SERIAL_ROWS = 30; // 最近串口数据条数
const MAX_ROW_HEX = 96;     // 每条 hex 截断长度

const dbApi = () => window.electronAPI?.db || null;

async function q(sql) {
  const r = await dbApi().query(sql, []);
  if (!r || !r.success) throw new Error((r && r.error) || '查询失败');
  return r.rows || [];
}

function clip(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function pick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return '';
}

/* 协议库摘要：协议基础参数 + 模块 + 指令表（含字段名） */
export async function buildProtocolContextText() {
  if (!dbApi()) return '';
  try {
    const protos = await q('SELECT id, name, version, frame_mode, frame_length, byte_order, check_method, check_start, check_end FROM protocols ORDER BY name COLLATE NOCASE');
    if (!protos.length) return '## 协议库\n（当前为空）';
    const lines = [`## 协议库（共 ${protos.length} 个协议${protos.length > MAX_PROTOCOLS ? `，仅显示前 ${MAX_PROTOCOLS} 个` : ''}）`];
    for (const p of protos.slice(0, MAX_PROTOCOLS)) {
      const frame = p.frame_mode === 'fixed'
        ? `定长 ${p.frame_length || '?'} 字节`
        : (p.frame_mode === 'variable' ? '变长' : (p.frame_mode || '?'));
      lines.push(`### 协议：${p.name} ${p.version || ''}`.trimEnd());
      lines.push(`- 帧：${frame} · 字节序 ${p.byte_order || '?'} · 校验 ${p.check_method || '无'}（范围 ${p.check_start || '?'} → ${p.check_end || '?'}）`);
      try {
        const mods = await q(`SELECT name, address FROM modules WHERE protocol_id = ${Number(p.id)} ORDER BY id LIMIT ${MAX_MODULES}`);
        if (mods.length) lines.push(`- 模块：${mods.map((m) => `${m.name}(${m.address})`).join('、')}`);
      } catch { /* 模块查询失败不影响整体 */ }
      try {
        const cmds = await q(`SELECT code, name, sender, receiver, direction, period_ms, config_json FROM commands WHERE protocol_id = ${Number(p.id)} ORDER BY id LIMIT ${MAX_COMMANDS}`);
        if (cmds.length) {
          lines.push(`- 指令（${cmds.length} 条）：`);
          for (const c of cmds) {
            let fieldsNote = '';
            try {
              const cfg = JSON.parse(c.config_json || '{}');
              const fields = Array.isArray(cfg.fields) ? cfg.fields : [];
              if (fields.length) {
                const names = fields.slice(0, MAX_FIELDS)
                  .map((f) => clip(String(pick(f, ['name', 'label', 'title']) || '?'), 24) + (pick(f, ['type', 'dataType']) ? `:${pick(f, ['type', 'dataType'])}` : ''));
                fieldsNote = ` · 字段[${names.join(', ')}${fields.length > MAX_FIELDS ? ', …' : ''}]`;
              }
            } catch { /* config_json 非法则跳过字段 */ }
            const dir = c.direction === 'recv' ? '接收' : '发送';
            const route = [c.sender, c.receiver].filter(Boolean).join('→');
            lines.push(`  - ${c.code} ${c.name} [${dir}${route ? ' ' + route : ''}] 周期${c.period_ms ?? '?'}ms${fieldsNote}`);
          }
          if (cmds.length >= MAX_COMMANDS) lines.push('  - （更多指令已省略）');
        }
      } catch { /* 指令查询失败不影响整体 */ }
    }
    return lines.join('\n');
  } catch (e) {
    console.warn('[AI] 协议库上下文构建失败:', e.message);
    return '';
  }
}

/* 最近串口收发数据 */
export async function buildSerialContextText() {
  if (!dbApi()) return '';
  try {
    const rows = await q(`SELECT direction, data_hex, data_text, timestamp FROM serial_logs ORDER BY id DESC LIMIT ${MAX_SERIAL_ROWS}`);
    if (!rows.length) return '';
    const lines = [`## 最近串口数据（最后 ${rows.length} 条，新→旧）`];
    for (const r of rows) {
      const hex = clip(String(r.data_hex || '').trim(), MAX_ROW_HEX);
      const txt = r.data_text ? ` ${clip(JSON.stringify(String(r.data_text)), 60)}` : '';
      lines.push(`[${String(r.direction || '?').toUpperCase()}] ${r.timestamp || ''} ${hex}${txt}`);
    }
    return lines.join('\n');
  } catch (e) {
    console.warn('[AI] 串口上下文构建失败:', e.message);
    return '';
  }
}

/* JSON Mode：协议定义生成的结构约束（系统提示词，配合 response_format: json_object） */
export const PROTOCOL_JSON_PROMPT = '你是串口协议定义生成器。根据用户描述生成协议定义，只输出一个 JSON 对象，不要任何解释文字、不要 markdown 代码块。字段结构：'
  + JSON.stringify({
    name: '协议名称',
    version: 'v1.0.0',
    frame_mode: 'fixed 或 variable',
    frame_length: 0,
    byte_order: 'big 或 little',
    check_method: 'CRC16-MODBUS、SUM8、XOR 或 无',
    check_start: '校验起始位置，如 SOF',
    check_end: '校验结束位置，如 DATA',
    modules: [{ name: '模块名', address: '0x01' }],
    commands: [{
      code: '0x0100', name: '指令名', sender: '发送方模块名', receiver: '接收方模块名',
      direction: 'send 或 recv', period_ms: 1000,
      fields: [{ name: '字段名', type: 'u8 或 u16 或 u32 或 bytes', length: 1, offset: 0 }],
    }],
  }, null, 1)
  + '\n用户未明确的字段用合理默认值补全；字段 offset 从帧头之后按前一字段长度累加。';
