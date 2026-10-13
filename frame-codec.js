/* =========================================================================
 * 共享帧编解码模块（零依赖，Node / 渲染层均可使用）
 * 帧结构: 帧头 + 地址 + 命令字 + 长度 + 载荷 + 校验 + 帧尾
 * 校验范围: 地址 + 命令字 + 长度 + 载荷（不含帧头帧尾）
 * 语义与调试页 DebuggerView.vue 的 buildFrame / buildFrameParse 保持一致，
 * 供 MCP 工具（build_frame / parse_frame）与服务端复用。
 * ========================================================================= */
'use strict';

/* CRC16-MODBUS：多项式 0xA001，初值 0xFFFF，返回 [低字节, 高字节] */
function crc16(bytes) {
  let crc = 0xFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] & 0xFF;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x0001) ? ((crc >> 1) ^ 0xA001) : (crc >> 1);
    }
  }
  return [crc & 0xFF, (crc >> 8) & 0xFF];
}

/* 累加和校验：返回 [单字节] */
function sumCheck(bytes) {
  let sum = 0;
  for (let i = 0; i < bytes.length; i++) sum = (sum + bytes[i]) & 0xFF;
  return [sum];
}

const toHex = (n) => Number(n & 0xFF).toString(16).padStart(2, '0').toUpperCase();
const bytesToHex = (arr) => (arr || []).map(toHex).join(' ');

/* "AA 0D 0x1F" 等宽松解析为字节数组；非法字符报错 */
function hexToBytes(str) {
  const tokens = String(str || '').trim().split(/[\s,,-]+/).filter(Boolean);
  const bytes = [];
  for (const t of tokens) {
    const m = t.replace(/^0x/i, '');
    if (!/^[0-9A-Fa-f]{1,2}$/.test(m)) throw new Error(`非法十六进制片段: "${t}"`);
    bytes.push(parseInt(m, 16));
  }
  return bytes;
}

/* 数值入参宽容解析：支持 12 / "12" / "0x1F"；其余返回 NaN */
function parseNum(v) {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return NaN;
  const s = v.trim();
  if (/^-?0x[0-9A-Fa-f]+$/i.test(s)) return parseInt(s, 16);
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return NaN;
}

/* =========================================================================
 * DB 字段结构 → 内部字段结构（与 DebuggerView.mapDbFieldToProtoField 一致）
 * DB: { type: 'bitfield'|'enum'|'number'|'text'|'binary'|'raw', ... }
 * ========================================================================= */
const NUM_ENCODING_LEN = { uint8: 1, int8: 1, uint16: 2, int16: 2, uint32: 4, int32: 4, float32: 4, float64: 8 };

function mapDbField(field) {
  if (!field || typeof field !== 'object') return { name: '?', type: 'number', encoding: 'uint8', length: 1, scale: 1, signed: false, unit: '' };
  if (field.type === 'bitfield') {
    return {
      name: field.name, type: 'bitmap', length: field.length || 1,
      bits: (field.bits || []).map((b) => ({ bit: b.bit, name: b.one || b.zero || `bit${b.bit}` })),
    };
  }
  if (field.type === 'enum') {
    return {
      name: field.name, type: 'enum', length: field.length || 1,
      options: (field.enumItems || []).map((item) => ({ value: parseInt(item.value, 16) || 0, label: item.meaning || item.value })),
    };
  }
  if (field.type === 'number') {
    const len = NUM_ENCODING_LEN[field.encoding] || field.length || 2;
    const isSigned = (field.encoding || '').startsWith('int') || (field.encoding || '').startsWith('float');
    return {
      name: field.name, type: 'number', encoding: field.encoding || 'uint16',
      length: len, scale: field.scale != null ? field.scale : 1,
      signed: isSigned, unit: field.unit || '',
    };
  }
  if (field.type === 'text') {
    return {
      name: field.name, type: 'text',
      lengthMode: field.lengthMode || 'varlen-field', lengthField: field.lengthField || 'len',
      length: field.length || 0, delimiter: field.delimiter || '',
      encoding: field.encoding || 'utf8', format: field.format || 'raw',
    };
  }
  if (field.type === 'binary') {
    return {
      name: field.name, type: 'binary',
      lengthMode: field.lengthMode || 'varlen-rest', lengthField: field.lengthField || 'len',
      length: field.length || 0, delimiter: field.delimiter || '',
      encoding: field.encoding || 'hex',
    };
  }
  /* 兼容旧 raw 类型 */
  const rawParts = String(field.rawValue || '00').trim().split(/\s+/).filter(Boolean);
  return { name: field.name, type: 'number', encoding: 'uint8', length: rawParts.length || 1, scale: 1, signed: false, unit: '' };
}

/* =========================================================================
 * 协议行 + config_json + 命令行 → 协议定义（与 DebuggerView.buildProtoDefFromDB 一致）
 * ========================================================================= */
function buildProtoDef(protoRow, protoConfig, cmdRows) {
  const cfg = protoConfig || {};
  const fieldConfig = cfg.fieldConfig || {};

  const sofCfg = fieldConfig.sof;
  const frameHeader = (sofCfg && sofCfg.enabled && sofCfg.defaults)
    ? sofCfg.defaults.map((h) => parseInt(h, 16) || 0) : [];

  const eofCfg = fieldConfig.eof;
  const frameTail = (eofCfg && eofCfg.enabled && eofCfg.defaults)
    ? eofCfg.defaults.map((h) => parseInt(h, 16) || 0) : [];

  const checkMethod = cfg.checkType || protoRow.check_method || 'CRC16-MODBUS';
  const checkType = checkMethod.includes('CRC') ? 'CRC16' : 'SUM';

  let address = 0x01;
  const srcCfg = fieldConfig.src;
  if (srcCfg && srcCfg.enabled && srcCfg.defaults && srcCfg.defaults.length > 0) {
    address = parseInt(srcCfg.defaults[0], 16) || 0x01;
  }

  let cmdLen = 1;
  const cmdCfg = fieldConfig.cmd;
  if (cmdCfg && cmdCfg.enabled) {
    cmdLen = cmdCfg.byteCount === 'custom' ? (parseInt(cmdCfg.customCount, 10) || 1) : (parseInt(cmdCfg.byteCount, 10) || 1);
  }

  const cmds = (cmdRows || []).map((c) => {
    let cmdData = {};
    try { cmdData = JSON.parse(c.config_json || '{}'); } catch { /* 旧数据无 config */ }
    return {
      code: c.code,
      cmd: parseInt(c.code, 16) || 0,
      name: c.name,
      fields: (cmdData.fields || []).map(mapDbField),
    };
  });

  return {
    name: protoRow.name, version: protoRow.version || '',
    frameHeader, frameTail, checkType, checkMethod, address, cmdLen,
    byteOrder: protoRow.byte_order || '',
    cmds,
  };
}

function findCmd(proto, key) {
  if (key === undefined || key === null || key === '') return null;
  const s = String(key).trim().replace(/^0x/i, '').toUpperCase();
  return proto.cmds.find((c) => String(c.code).trim().replace(/^0x/i, '').toUpperCase() === s)
    || proto.cmds.find((c) => c.name === String(key).trim())
    || null;
}

/* =========================================================================
 * 构帧：按字段名填值生成完整帧
 * fieldValues: { 字段名: 数值 | 枚举含义文本 | 文本内容 | 十六进制串 }
 * 返回 { ok, error?, hex, segments: [{hex, meaning}], checkMethod, cmdName }
 * ========================================================================= */
function encodeFieldValue(field, input) {
  if (field.type === 'text') {
    let s = String(input ?? '');
    let bytes;
    try { bytes = Array.from(Buffer.from(s, field.encoding === 'ascii' ? 'ascii' : 'utf8')); }
    catch { bytes = Array.from(s).map((ch) => ch.charCodeAt(0) & 0xFF); }
    if (field.lengthMode === 'fixed' && field.length > 0) {
      if (bytes.length > field.length) throw new Error(`字段「${field.name}」内容 ${bytes.length} 字节超出定长 ${field.length}`);
      while (bytes.length < field.length) bytes.push(0);
    }
    if (field.lengthMode === 'varlen-delim' && field.delimiter) bytes = bytes.concat(hexToBytes(field.delimiter));
    return bytes;
  }
  if (field.type === 'binary') {
    const bytes = hexToBytes(String(input ?? ''));
    if (field.lengthMode === 'fixed' && field.length > 0) {
      if (bytes.length > field.length) throw new Error(`字段「${field.name}」${bytes.length} 字节超出定长 ${field.length}`);
      while (bytes.length < field.length) bytes.push(0);
    }
    if (field.lengthMode === 'varlen-delim' && field.delimiter) bytes = bytes.concat(hexToBytes(field.delimiter));
    return bytes;
  }

  let v = parseNum(input);
  if (Number.isNaN(v) && field.type === 'enum' && typeof input === 'string') {
    const opt = (field.options || []).find((o) => o.label === input.trim());
    if (opt) v = opt.value;
  }
  if (Number.isNaN(v)) {
    if (field.type === 'enum') {
      const labels = (field.options || []).map((o) => `${o.value}=0x${toHex(o.value)} ${o.label}`).join('，');
      throw new Error(`字段「${field.name}」枚举值无效: ${JSON.stringify(input)}。可选: ${labels || '（无）'}，也可直接填数值`);
    }
    throw new Error(`字段「${field.name}」需要数值，收到: ${JSON.stringify(input)}`);
  }
  const len = field.length || 1;

  if (field.type === 'enum') {
    const known = (field.options || []).some((o) => o.value === v);
    if (!known) {
      const labels = (field.options || []).map((o) => `${o.value}=0x${toHex(o.value)} ${o.label}`).join('，');
      throw new Error(`字段「${field.name}」枚举值 ${v} 不存在。可选: ${labels || '（无）'}`);
    }
  }

  const max = Math.pow(2, len * 8);
  if (v < 0) {
    if (!field.signed && field.type !== 'number') v = v + max; /* 位域允许按补码书写 */
    else if (!field.signed) throw new Error(`字段「${field.name}」为无符号数，不能为负值`);
    else if (v < -max / 2) throw new Error(`字段「${field.name}」超出有符号 ${len * 8} 位范围`);
    else v = v + max;
  }
  const intVal = Math.round(v);
  if (intVal >= max) throw new Error(`字段「${field.name}」值 ${intVal} 超出 ${len} 字节范围（0~${max - 1}）`);

  const bytes = [];
  for (let i = 0; i < len; i++) bytes.push((intVal >> ((len - 1 - i) * 8)) & 0xFF);
  return bytes;
}

/* opts.payloadHex: 直接给定载荷字节（跳过字段编码），仍自动计算长度与校验 */
function buildFrame(proto, cmdKey, fieldValues, opts) {
  const cmd = findCmd(proto, cmdKey);
  if (!cmd) {
    const names = proto.cmds.map((c) => `0x${String(c.code).toUpperCase()} ${c.name}`).join('，');
    throw new Error(`协议「${proto.name}」中不存在命令 ${JSON.stringify(cmdKey)}。可用命令: ${names || '（无）'}`);
  }

  const values = fieldValues || {};
  const segments = [];
  const push = (byteArr, meaning) => byteArr.forEach((b) => segments.push({ hex: toHex(b), meaning }));

  push(proto.frameHeader, '帧头');
  push([proto.address], '地址');

  const cmdBytesArr = [];
  for (let i = (proto.cmdLen || 1) - 1; i >= 0; i--) cmdBytesArr.push((cmd.cmd >> (i * 8)) & 0xFF);
  push(cmdBytesArr, 'CMD');

  const payload = opts && opts.payloadHex
    ? hexToBytes(opts.payloadHex)
    : [];
  if (!(opts && opts.payloadHex)) {
    (cmd.fields || []).forEach((field) => {
      const has = Object.prototype.hasOwnProperty.call(values, field.name);
      const fb = encodeFieldValue(field, has ? values[field.name] : 0);
      fb.forEach((b) => payload.push(b & 0xFF));
    });
  }
  if (payload.length > 255) throw new Error(`载荷 ${payload.length} 字节超出长度字节上限（255）`);

  push([payload.length], '长度');
  push(payload, '数据');

  const checkBytes = [proto.address, ...cmdBytesArr, payload.length, ...payload];
  const checkResult = proto.checkType === 'CRC16' ? crc16(checkBytes) : sumCheck(checkBytes);
  push(checkResult, '校验');

  push(proto.frameTail, '帧尾');

  return {
    ok: true,
    cmd: String(cmd.code).toUpperCase(),
    cmdName: cmd.name,
    checkMethod: proto.checkMethod,
    length: segments.length,
    hex: bytesToHex(segments.map((s) => parseInt(s.hex, 16))),
    segments,
  };
}

/* =========================================================================
 * 解帧：返回 { ok, error?, warning?, cmd, cmdName, hex, groups, checkOk }
 * groups: [{ name, raw, parsed, children? }]，与调试页悬浮卡片结构一致
 * ========================================================================= */
function decodeTextField(field, fb) {
  let text;
  const enc = (field.encoding || 'utf8').toLowerCase();
  try { text = Buffer.from(fb).toString(enc === 'ascii' ? 'ascii' : 'utf8'); }
  catch { text = fb.map((b) => String.fromCharCode(b)).join(''); }
  if (field.format === 'json') {
    try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { /* 保留原文 */ }
  }
  return text;
}

function decodeNumberValue(field, fb) {
  if (field.encoding === 'float32' && fb.length >= 4) return Buffer.from(fb).readFloatLE(0);
  if (field.encoding === 'float64' && fb.length >= 8) return Buffer.from(fb).readFloatLE(0);
  let v = 0;
  fb.forEach((b) => { v = (v << 8) | b; });
  if (field.signed && fb.length > 0 && (fb[0] & 0x80)) v -= Math.pow(2, fb.length * 8);
  return v;
}

function parseFrame(proto, bytes) {
  if (!Array.isArray(bytes) || bytes.length === 0 || bytes.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) {
    return { ok: false, error: '输入不是合法的字节序列' };
  }
  const hex = (n) => toHex(n);
  const hLen = (proto.frameHeader || []).length;
  const tLen = (proto.frameTail || []).length;
  const chkLen = proto.checkType === 'CRC16' ? 2 : 1;
  const cmdLen = proto.cmdLen || 1;

  if (bytes.length < hLen + 1 + cmdLen + 1) {
    return { ok: false, error: `数据太短（${bytes.length} 字节），帧头${hLen}+地址1+CMD${cmdLen}+长度1 至少需要 ${hLen + 2 + cmdLen} 字节` };
  }

  const warnings = [];
  if (hLen > 0) {
    const headOk = proto.frameHeader.every((b, i) => bytes[i] === b);
    if (!headOk) warnings.push(`帧头不匹配（期望 ${bytesToHex(proto.frameHeader)}，实际 ${bytesToHex(bytes.slice(0, hLen))}）`);
  }
  if (tLen > 0) {
    const tailOk = proto.frameTail.every((b, i) => bytes[bytes.length - tLen + i] === b);
    if (!tailOk) warnings.push(`帧尾不匹配（期望 ${bytesToHex(proto.frameTail)}）`);
  }

  const cmdIdx = hLen + 1;
  let cmdVal = 0;
  for (let i = 0; i < cmdLen; i++) cmdVal = (cmdVal << 8) | (bytes[cmdIdx + i] || 0);
  const cmdDef = (proto.cmds || []).find((c) => c.cmd === cmdVal);
  if (!cmdDef) {
    return { ok: false, error: `命令字 0x${cmdVal.toString(16).toUpperCase().padStart(cmdLen * 2, '0')} 不在协议「${proto.name}」的命令表中` };
  }

  const lenIdx = cmdIdx + cmdLen;
  const lenValue = bytes[lenIdx] || 0;
  const dataStart = lenIdx + 1;
  const dataEnd = bytes.length - chkLen - tLen;
  const dataBytes = bytes.slice(dataStart, Math.max(dataStart, dataEnd));
  if (dataBytes.length !== lenValue) warnings.push(`长度字节为 ${lenValue}，实际载荷 ${dataBytes.length} 字节`);

  /* 校验范围: 地址 + 命令字 + 长度 + 载荷（地址位于帧头之后、CMD 之前） */
  const checkBytes = bytes.slice(hLen, Math.max(hLen, dataEnd));
  const expect = proto.checkType === 'CRC16' ? crc16(checkBytes) : sumCheck(checkBytes);
  const stored = bytes.slice(dataEnd, dataEnd + chkLen);
  const checkOk = expect.length === stored.length && expect.every((b, i) => b === stored[i]);
  if (!checkOk) warnings.push(`校验不匹配（计算 ${bytesToHex(expect)}，帧内 ${bytesToHex(stored)}）`);

  const groups = [];
  groups.push({ name: 'CMD', raw: `0x${cmdVal.toString(16).toUpperCase().padStart(cmdLen * 2, '0')}`, parsed: cmdDef.name });
  groups.push({ name: '地址', raw: `0x${hex(bytes[hLen])}`, parsed: String(bytes[hLen]) });
  groups.push({ name: '长度', raw: `0x${hex(lenValue)}`, parsed: `${lenValue} 字节` });
  groups.push({ name: '校验', raw: bytesToHex(stored), parsed: `${proto.checkMethod} ${checkOk ? '通过' : '不匹配'}` });

  if (cmdDef.fields && cmdDef.fields.length > 0) {
    let off = 0;
    cmdDef.fields.forEach((f) => {
      let fieldLen;
      if (f.type === 'text' || f.type === 'binary') {
        if (f.lengthMode === 'varlen-field') fieldLen = lenValue;
        else if (f.lengthMode === 'varlen-delim') {
          const delim = hexToBytes(f.delimiter || '0D0A');
          fieldLen = dataBytes.length - off;
          for (let i = off; i <= dataBytes.length - delim.length; i++) {
            if (delim.every((d, j) => dataBytes[i + j] === d)) { fieldLen = i - off; break; }
          }
        } else if (f.lengthMode === 'varlen-rest') fieldLen = dataBytes.length - off;
        else fieldLen = f.length || 1;
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
        const setBits = (f.bits || []).filter((b) => (b0 >> b.bit) & 1).map((b) => b.name);
        group = { name, raw: rawHex, parsed: setBits.length > 0 ? setBits.join(' / ') : '全部清零', children: [] };
        (f.bits || []).forEach((b) => group.children.push({ label: `bit${b.bit} ${b.name}`, raw: '', parsed: String((b0 >> b.bit) & 1) }));
      } else if (f.type === 'enum') {
        const v = fb.length ? fb[0] : 0;
        const opt = (f.options || []).find((o) => o.value === v);
        group = { name, raw: rawHex, parsed: opt ? opt.label : '未知值' };
      } else if (f.type === 'number') {
        const v = decodeNumberValue(f, fb);
        const phys = f.scale && f.scale !== 1 ? `${(v * f.scale).toFixed(4)}${f.unit || ''}` : `${v}${f.unit || ''}`;
        group = { name, raw: rawHex, parsed: phys };
      } else if (f.type === 'text') {
        group = { name, raw: `${fieldLen}B`, parsed: decodeTextField(f, fb) };
      } else if (f.type === 'binary') {
        const binVal = f.encoding === 'base64' ? Buffer.from(fb).toString('base64') : fb.map(hex).join(' ');
        group = { name, raw: `${fieldLen}B`, parsed: binVal };
      } else {
        const v = decodeNumberValue(f, fb);
        const phys = f.scale && f.scale !== 1 ? `${(v * f.scale).toFixed(2)}${f.unit || ''}` : `${v}${f.unit || ''}`;
        group = { name, raw: rawHex, parsed: phys };
      }
      groups.push(group);
      off += fieldLen;
    });

    if (off < dataBytes.length) {
      const rest = dataBytes.slice(off);
      const range = rest.length === 1 ? `Payload${off}` : `Payload${off}-${dataBytes.length - 1}`;
      groups.push({ name: range, raw: `0x${rest.map(hex).join(' ')}`, parsed: '未定义字段' });
    }
  } else if (dataBytes.length > 0) {
    dataBytes.forEach((b, i) => groups.push({ name: `Payload${i}`, raw: `0x${hex(b)}`, parsed: '' }));
  }

  return {
    ok: true,
    cmd: String(cmdDef.code).toUpperCase(),
    cmdName: cmdDef.name,
    length: bytes.length,
    hex: bytesToHex(bytes),
    groups,
    checkOk,
    warnings,
  };
}

/* 自动识别：遍历候选协议，优先「帧头匹配 + 校验通过」，其次帧头匹配 */
function autoDetectFrame(protos, bytes) {
  const headerMatched = [];
  for (const proto of protos) {
    const hLen = (proto.frameHeader || []).length;
    if (hLen > 0 && !proto.frameHeader.every((b, i) => bytes[i] === b)) continue;
    headerMatched.push(proto);
    const r = parseFrame(proto, bytes);
    if (r.ok && r.checkOk && (r.warnings || []).length === 0) return { proto, result: r };
  }
  if (headerMatched.length > 0) {
    const proto = headerMatched[0];
    return { proto, result: parseFrame(proto, bytes) };
  }
  return null;
}

/* =========================================================================
 * 协议差异对比：两个 buildProtoDef 输出 → 结构化差异（只列变化项）
 * 版本快照（protocol_versions）不含命令表，帧参数级对比同样适用
 * ========================================================================= */
function fieldSignature(f) {
  if (!f) return '(无)';
  if (f.type === 'bitmap') return `bitfield[${(f.bits || []).map((b) => `bit${b.bit}:${b.name}`).join('|')}]`;
  if (f.type === 'enum') return `enum[${(f.options || []).map((o) => `${o.value}=${o.label}`).join('|')}]`;
  if (f.type === 'text') return `text(${f.lengthMode}${f.length ? ',' + f.length : ''}${f.delimiter ? ',delim=' + f.delimiter : ''})`;
  if (f.type === 'binary') return `binary(${f.lengthMode}${f.length ? ',' + f.length : ''})`;
  const scale = f.scale && f.scale !== 1 ? `×${f.scale}` : '';
  return `${f.encoding || 'uint8'}(${f.length})${f.signed ? '有符号' : ''}${scale}${f.unit || ''}`;
}

function diffList(aArr, bArr, keyOf, describe) {
  const aMap = new Map(aArr.map((x) => [keyOf(x), x]));
  const bMap = new Map(bArr.map((x) => [keyOf(x), x]));
  const added = bArr.filter((x) => !aMap.has(keyOf(x))).map(describe);
  const removed = aArr.filter((x) => !bMap.has(keyOf(x))).map(describe);
  const changed = [];
  for (const [k, a] of aMap) {
    const b = bMap.get(k);
    if (b && describe(a) !== describe(b)) changed.push({ key: k, a: describe(a), b: describe(b) });
  }
  return { added, removed, changed };
}

function diffProtoDefs(a, b) {
  const frame = [];
  const cmp = (label, va, vb, fmt = (v) => String(v)) => {
    if (JSON.stringify(va) !== JSON.stringify(vb)) {
      frame.push({ field: label, a: Array.isArray(va) ? bytesToHex(va) : fmt(va), b: Array.isArray(vb) ? bytesToHex(vb) : fmt(vb) });
    }
  };
  cmp('帧头', a.frameHeader, b.frameHeader);
  cmp('帧尾', a.frameTail, b.frameTail);
  cmp('校验方式', a.checkMethod, b.checkMethod);
  cmp('地址默认值', a.address, b.address, (v) => `0x${toHex(v)}`);
  cmp('CMD 字节数', a.cmdLen, b.cmdLen);

  const modules = diffList(a.modules || [], b.modules || [], (m) => m.name, (m) => `${m.name}=${m.address}`);

  /* 命令按指令码对齐；字段变化细分为增/删/改 */
  const cmdChanges = diffList(a.cmds || [], b.cmds || [], (c) => String(c.code).toUpperCase(),
    (c) => `${String(c.code).toUpperCase()} ${c.name}(${(c.fields || []).map(fieldSignature).join(', ')})`);
  const commands = {
    added: cmdChanges.added,
    removed: cmdChanges.removed,
    renamed: [],
    field_changes: [],
  };
  const aMap = new Map((a.cmds || []).map((c) => [String(c.code).toUpperCase(), c]));
  for (const c of b.cmds || []) {
    const k = String(c.code).toUpperCase();
    const pa = aMap.get(k);
    if (!pa) continue;
    if (pa.name !== c.name) commands.renamed.push({ code: k, a: pa.name, b: c.name });
    const fd = diffList(pa.fields || [], c.fields || [], (f) => f.name, fieldSignature);
    if (fd.added.length || fd.removed.length || fd.changed.length) {
      commands.field_changes.push({ code: k, name: c.name, added: fd.added, removed: fd.removed, changed: fd.changed });
    }
  }

  return {
    frame_changed: frame,
    modules,
    commands,
    summary: [
      frame.length ? `帧参数 ${frame.length} 处变化` : '帧参数一致',
      (modules.added.length || modules.removed.length || modules.changed.length) ? `模块 ${modules.added.length + modules.removed.length + modules.changed.length} 处变化` : '模块一致',
      `${cmdChanges.added.length} 条新增 / ${cmdChanges.removed.length} 条删除 / ${commands.field_changes.length} 条字段变化`,
    ].join('；'),
  };
}

/* 在缓冲区里找出帧头可能出现的偏移（无帧头协议返回 [0]） */
function headerOffsets(buf, proto) {
  const header = (proto && proto.frameHeader) || [];
  if (!header.length) return [0];
  const out = [];
  for (let i = 0; i + header.length <= buf.length; i++) {
    if (header.every((b, j) => buf[i + j] === b)) out.push(i);
  }
  return out.length ? out : (buf.length >= header.length ? [] : [0]);
}

module.exports = {
  crc16, sumCheck, hexToBytes, bytesToHex, parseNum,
  mapDbField, buildProtoDef, buildFrame, parseFrame, autoDetectFrame, findCmd,
  diffProtoDefs, headerOffsets,
};
