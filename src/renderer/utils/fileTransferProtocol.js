/**
 * AFT-1 串口文件传输协议（ALVAN File Transfer v1）
 * ------------------------------------------------
 * 自定义二进制帧协议：按 MTU 切分 + 帧封装 + CRC 校验 + 选择性重传 + 断点续传。
 * 本模块为纯函数/纯类（零依赖），既被渲染进程 UI 使用，也被 tests/verify-file-transfer.js 复用。
 *
 * 帧格式（小端）：
 *   OFFSET  SIZE  字段
 *   0       2     帧头魔数 0xA5 0x5A
 *   2       1     TYPE（帧类型）
 *   3       1     SEQ（发送序号，滚动的帧计数，接收端仅用于调试去重）
 *   4       2     LEN（payload 字节数）
 *   6       LEN   PAYLOAD
 *   6+LEN   2     CRC16-CCITT-FALSE（对 TYPE..PAYLOAD 即偏移 2 起至 payload 末尾计算）
 *
 * 单帧线上总长 = 6 + LEN + 2 ≤ MTU，因此数据块 chunkSize = MTU - 8。
 */

// ---------------------------------------------------------------------------
// 常量与帧类型
// ---------------------------------------------------------------------------

export const FRAME_MAGIC = [0xA5, 0x5A];
export const FRAME_HEADER_SIZE = 6;   // 魔数 2 + TYPE 1 + SEQ 1 + LEN 2
export const FRAME_OVERHEAD = 8;      // 头 6 + CRC 2
export const PROTOCOL_VERSION = 1;

/** 最小 MTU：要能装下 FILE_BEGIN（payload 46B） */
export const MIN_MTU = 64;
export const MAX_MTU = 1024;
/** 文件名在 FILE_BEGIN 中最多占的字节数（UTF-8，超长截断） */
export const MAX_NAME_BYTES = 32;

/** 发送端 → 接收端 */
export const T = {
  FILE_BEGIN: 0x01,
  DATA: 0x02,
  FILE_END: 0x03,
  CANCEL: 0x04,
  /** 接收端 → 发送端 */
  READY: 0x10,
  ACK: 0x11,
  RESEND: 0x12,
  FINAL: 0x13,
  CANCEL_ACK: 0x14,
};

/** FINAL.status 语义 */
export const FINAL_STATUS = {
  OK: 0,               // 文件完整且 CRC32 校验通过
  CRC_MISMATCH: 1,     // 收齐但整包 CRC32 不符
  UNSUPPORTED: 2,      // 协议版本不支持
  NO_SESSION: 3,       // 无进行中的会话（收到 FILE_END 但没有 FILE_BEGIN）
};

export const TYPE_NAMES = {
  [T.FILE_BEGIN]: 'FILE_BEGIN',
  [T.DATA]: 'DATA',
  [T.FILE_END]: 'FILE_END',
  [T.CANCEL]: 'CANCEL',
  [T.READY]: 'READY',
  [T.ACK]: 'ACK',
  [T.RESEND]: 'RESEND',
  [T.FINAL]: 'FINAL',
  [T.CANCEL_ACK]: 'CANCEL_ACK',
};

// ---------------------------------------------------------------------------
// 校验算法：CRC16-CCITT-FALSE / CRC32-IEEE
// ---------------------------------------------------------------------------

const CRC16_TABLE = (() => {
  const table = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i << 8;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
    table[i] = crc;
  }
  return table;
})();

/** CRC-16/CCITT-FALSE：init 0xFFFF，多项式 0x1021，无反射。经典校验值 "123456789" → 0x29B1 */
export function crc16(bytes) {
  let crc = 0xFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc = ((crc << 8) & 0xFFFF) ^ CRC16_TABLE[((crc >> 8) ^ bytes[i]) & 0xFF];
  }
  return crc;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

/** CRC-32/ISO-HDLC（zlib）：经典校验值 "123456789" → 0xCBF43926。可分块续算（传入上次结果）。 */
export function crc32(bytes, prev = 0) {
  let c = (prev ^ 0xFFFFFFFF) >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    c = (CRC32_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ---------------------------------------------------------------------------
// 帧编码
// ---------------------------------------------------------------------------

let seqCounter = 0;

/**
 * 编码一帧
 * @param {number} type T 中的帧类型
 * @param {Uint8Array|number[]} [payload]
 * @returns {Uint8Array} 完整帧字节
 */
export function encodeFrame(type, payload = []) {
  const p = payload instanceof Uint8Array ? payload : Uint8Array.from(payload);
  const frame = new Uint8Array(FRAME_HEADER_SIZE + p.length + 2);
  const dv = new DataView(frame.buffer);
  frame[0] = FRAME_MAGIC[0];
  frame[1] = FRAME_MAGIC[1];
  frame[2] = type & 0xFF;
  frame[3] = (++seqCounter) & 0xFF;
  dv.setUint16(4, p.length, true);
  frame.set(p, FRAME_HEADER_SIZE);
  const crc = crc16(frame.subarray(2, FRAME_HEADER_SIZE + p.length));
  dv.setUint16(FRAME_HEADER_SIZE + p.length, crc, true);
  return frame;
}

/** CRC 是否有效（传入完整帧字节） */
export function verifyFrame(frame) {
  if (frame.length < FRAME_OVERHEAD) return false;
  if (frame[0] !== FRAME_MAGIC[0] || frame[1] !== FRAME_MAGIC[1]) return false;
  const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const len = dv.getUint16(4, true);
  if (frame.length !== FRAME_HEADER_SIZE + len + 2) return false;
  return dv.getUint16(FRAME_HEADER_SIZE + len, true) === crc16(frame.subarray(2, FRAME_HEADER_SIZE + len));
}

// ---------------------------------------------------------------------------
// FILE_BEGIN / FILE_END payload 编解码
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8');

/** 文件名按字节截断（不拆开多字节字符） */
export function truncateNameBytes(name, maxBytes = MAX_NAME_BYTES) {
  const bytes = textEncoder.encode(String(name || 'file'));
  if (bytes.length <= maxBytes) return bytes;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xC0) === 0x80) end--;   // 回退到 UTF-8 首字节
  return bytes.subarray(0, end);
}

/**
 * @param {Object} meta { chunkSize, fileSize, totalBlocks, fileCrc32, name }
 */
export function encodeFileBegin(meta) {
  const nameBytes = truncateNameBytes(meta.name);
  // ver 1 + chunk 2 + fileSize 4 + totalBlocks 4 + fileCrc32 4 = 15，再加 nameLen 1 + name
  const payload = new Uint8Array(16 + nameBytes.length);
  const dv = new DataView(payload.buffer);
  dv.setUint8(0, PROTOCOL_VERSION);
  dv.setUint16(1, meta.chunkSize, true);
  dv.setUint32(3, meta.fileSize >>> 0, true);
  dv.setUint32(7, meta.totalBlocks >>> 0, true);
  dv.setUint32(11, meta.fileCrc32 >>> 0, true);
  payload[15] = nameBytes.length;
  payload.set(nameBytes, 16);
  return payload;
}

export function decodeFileBegin(payload) {
  if (!payload || payload.length < 16) return null;
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const nameLen = payload[15];
  if (payload.length < 16 + nameLen) return null;
  return {
    version: dv.getUint8(0),
    chunkSize: dv.getUint16(1, true),
    fileSize: dv.getUint32(3, true),
    totalBlocks: dv.getUint32(7, true),
    fileCrc32: dv.getUint32(11, true),
    name: textDecoder.decode(payload.subarray(16, 16 + nameLen)),
  };
}

// ---------------------------------------------------------------------------
// 帧解码器（字节流 → 帧，含 CRC 失败重同步）
// ---------------------------------------------------------------------------

export class FrameDecoder {
  /** 协议规定单帧 payload 上限：MTU 1024 - 帧开销 8；超过视为伪魔数直接重同步 */
  static MAX_PAYLOAD = MAX_MTU - FRAME_OVERHEAD;

  constructor() {
    this.reset();
  }

  reset() {
    this.buf = new Uint8Array(0);
  }

  /**
   * 喂入一段字节流，返回解出的完整帧数组 [{type, seq, payload}]
   * 帧可能跨块到达；CRC 错误时从魔数后一字节重新扫描实现字节流重同步。
   */
  feed(bytes) {
    const merged = new Uint8Array(this.buf.length + bytes.length);
    merged.set(this.buf, 0);
    merged.set(bytes, this.buf.length);
    this.buf = merged;

    const frames = [];
    let pos = 0;
    while (true) {
      // 找魔数
      if (this.buf.length - pos < 2) break;
      if (this.buf[pos] !== FRAME_MAGIC[0] || this.buf[pos + 1] !== FRAME_MAGIC[1]) {
        pos++;
        continue;
      }
      if (this.buf.length - pos < FRAME_HEADER_SIZE) break;
      const dv = new DataView(this.buf.buffer, this.buf.byteOffset + pos, this.buf.byteLength - pos);
      const len = dv.getUint16(4, true);
      const total = FRAME_HEADER_SIZE + len + 2;
      if (len > FrameDecoder.MAX_PAYLOAD) { pos += 2; continue; }   // 非法长度：伪魔数，向前重同步
      if (this.buf.length - pos < total) break;
      const frame = this.buf.subarray(pos, pos + total);
      if (verifyFrame(frame)) {
        frames.push({
          type: frame[2],
          seq: frame[3],
          payload: frame.slice(FRAME_HEADER_SIZE, FRAME_HEADER_SIZE + len),
        });
        pos += total;
      } else {
        pos += 2;   // CRC 错误：跳过魔数重新扫描
      }
    }
    if (pos > 0) this.buf = this.buf.subarray(pos);
    return frames;
  }
}

// ---------------------------------------------------------------------------
// 模拟接收端（无需硬件即可联调/演示断点续传与重传）
// ---------------------------------------------------------------------------

/**
 * 模拟一台实现了 AFT-1 协议的设备接收端。
 * - dropRate：模拟链路误码丢帧概率（0~0.5），收发两个方向都生效
 * - latencyMs：模拟响应延迟
 * - 会话按「文件名|大小|文件CRC」保存在内存，传输取消后再次 FILE_BEGIN 会命中断点续传
 */
export class MockReceiver {
  constructor(opts = {}) {
    this.dropRate = Math.min(0.5, Math.max(0, opts.dropRate || 0));
    this.latencyMs = opts.latencyMs ?? 4;
    this.decoder = new FrameDecoder();
    this.sessions = new Map();   // key → 会话
    this.stats = { rx: 0, dropped: 0, acked: 0, resendReplies: 0 };
    this.onEvent = opts.onEvent || (() => {});
  }

  reset() {
    this.sessions.clear();
    this.stats = { rx: 0, dropped: 0, acked: 0, resendReplies: 0 };
    this.onEvent('info', '模拟接收端已重置（清空断点数据）');
  }

  static sessionKey(meta) {
    return `${meta.name}|${meta.fileSize}|${meta.fileCrc32.toString(16)}`;
  }

  /** 接收端连续收到的最大块数（断点续传位置） */
  static maxContiguous(blocks, totalBlocks) {
    let n = 0;
    while (n < totalBlocks && blocks[n]) n++;
    return n;
  }

  /**
   * 喂入发送端发来的原始帧字节，同步返回应答帧数组（调用方负责延迟投递给发送端）
   * @param {Uint8Array} bytes
   * @returns {Uint8Array[]}
   */
  feed(bytes) {
    const replies = [];
    for (const frame of this.decoder.feed(bytes)) {
      this.stats.rx++;
      // 模拟发送端 → 接收端方向丢帧
      if (this.dropRate > 0 && Math.random() < this.dropRate) {
        this.stats.dropped++;
        continue;
      }
      replies.push(...this.handleFrame(frame));
    }
    // 模拟接收端 → 发送端方向丢帧
    if (this.dropRate > 0) {
      const kept = [];
      for (const r of replies) {
        if (Math.random() < this.dropRate) { this.stats.dropped++; continue; }
        kept.push(r);
      }
      return kept;
    }
    return replies;
  }

  handleFrame(frame) {
    switch (frame.type) {
      case T.FILE_BEGIN: return this.onFileBegin(decodeFileBegin(frame.payload));
      case T.DATA: return this.onData(frame.payload);
      case T.FILE_END: return this.onFileEnd(frame.payload);
      case T.CANCEL: return this.onCancel(frame.payload);
      default: return [];
    }
  }

  onFileBegin(meta) {
    if (!meta) return [];
    if (meta.version !== PROTOCOL_VERSION) {
      this.onEvent('err', `模拟端：协议版本 ${meta.version} 不支持`);
      return [encodeFrame(T.FINAL, Uint8Array.of(FINAL_STATUS.UNSUPPORTED))];
    }
    const key = MockReceiver.sessionKey(meta);
    const existing = this.sessions.get(key);
    if (existing && existing.chunkSize === meta.chunkSize && existing.totalBlocks === meta.totalBlocks) {
      const resume = MockReceiver.maxContiguous(existing.blocks, meta.totalBlocks);
      this.onEvent('info', `模拟端：命中断点续传，前 ${resume}/${meta.totalBlocks} 块已存在`);
      return [encodeFrame(T.READY, encodeReady(1, resume))];
    }
    const session = {
      name: meta.name,
      fileSize: meta.fileSize,
      chunkSize: meta.chunkSize,
      totalBlocks: meta.totalBlocks,
      fileCrc32: meta.fileCrc32,
      data: new Uint8Array(meta.fileSize),
      blocks: new Uint8Array(meta.totalBlocks),   // 0/1 已收位图
    };
    this.sessions.set(key, session);
    this.onEvent('info', `模拟端：新会话「${meta.name}」${meta.fileSize}B / ${meta.totalBlocks} 块 (chunk=${meta.chunkSize})`);
    return [encodeFrame(T.READY, encodeReady(0, 0))];
  }

  onData(payload) {
    if (!payload || payload.length < 4) return [];
    const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const blockIdx = dv.getUint32(0, true);
    const replies = [];
    // DATA 只可能属于当前活跃会话：取最近创建的一个
    const session = this.lastSession();
    if (!session || blockIdx >= session.totalBlocks) return [];
    const offset = blockIdx * session.chunkSize;
    const chunk = payload.subarray(4);
    if (offset + chunk.length > session.fileSize) return [];
    session.data.set(chunk, offset);
    if (!session.blocks[blockIdx]) {
      session.blocks[blockIdx] = 1;
      this.stats.acked++;
    }
    replies.push(encodeFrame(T.ACK, encodeU32(blockIdx)));
    return replies;
  }

  onFileEnd(payload) {
    const session = this.lastSession();
    if (!session) {
      return [encodeFrame(T.FINAL, Uint8Array.of(FINAL_STATUS.NO_SESSION))];
    }
    const missing = [];
    for (let i = 0; i < session.totalBlocks; i++) {
      if (!session.blocks[i]) missing.push(i);
    }
    if (missing.length > 0) {
      this.stats.resendReplies++;
      this.onEvent('info', `模拟端：缺少 ${missing.length} 块，请求重传`);
      return encodeResendFrames(missing, session.chunkSize);
    }
    const actual = crc32(session.data);
    if (actual !== session.fileCrc32) {
      this.onEvent('err', '模拟端：收齐但整包 CRC32 不符');
      return [encodeFrame(T.FINAL, Uint8Array.of(FINAL_STATUS.CRC_MISMATCH))];
    }
    this.onEvent('ok', `模拟端：「${session.name}」接收完成，CRC32 校验通过`);
    return [encodeFrame(T.FINAL, Uint8Array.of(FINAL_STATUS.OK))];
  }

  onCancel(payload) {
    const discard = payload && payload.length >= 1 ? payload[0] : 1;
    const session = this.lastSession();
    if (session) {
      if (discard) {
        this.sessions.delete(MockReceiver.sessionKey(session));
        this.onEvent('info', `模拟端：取消传输并丢弃「${session.name}」的部分数据`);
      } else {
        this.onEvent('info', `模拟端：取消传输，保留「${session.name}」断点进度`);
      }
    }
    return [encodeFrame(T.CANCEL_ACK, new Uint8Array(0))];
  }

  /** 最近一次 FILE_BEGIN 建立的会话 */
  lastSession() {
    let last = null;
    for (const s of this.sessions.values()) last = s;
    return last;
  }
}

// ---------------------------------------------------------------------------
// payload 小工具
// ---------------------------------------------------------------------------

export function encodeU32(value) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, value >>> 0, true);
  return b;
}

export function encodeReady(mode, resumeFrom) {
  const b = new Uint8Array(5);
  b[0] = mode;
  new DataView(b.buffer).setUint32(1, resumeFrom >>> 0, true);
  return b;
}

/**
 * RESEND 帧：u16 count + u32[count]。
 * 受 MTU 约束单帧装不下的缺失块会拆成多个 RESEND 帧。
 * @param {number[]} missing
 * @param {number} mtu 本链路 MTU（接收端从 FILE_BEGIN 的 chunkSize+8 得知）
 */
export function encodeResendFrames(missing, mtu) {
  const frames = [];
  const cap = Math.max(1, Math.floor((mtu - FRAME_OVERHEAD - 2) / 4));
  for (let i = 0; i < missing.length; i += cap) {
    const part = missing.slice(i, i + cap);
    const payload = new Uint8Array(2 + part.length * 4);
    const dv = new DataView(payload.buffer);
    dv.setUint16(0, part.length, true);
    part.forEach((idx, j) => dv.setUint32(2 + j * 4, idx >>> 0, true));
    frames.push(encodeFrame(T.RESEND, payload));
  }
  return frames;
}

export function decodeResend(payload) {
  if (!payload || payload.length < 2) return [];
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const count = dv.getUint16(0, true);
  const out = [];
  for (let i = 0; i < count && 2 + (i + 1) * 4 <= payload.length; i++) {
    out.push(dv.getUint32(2 + i * 4, true));
  }
  return out;
}

/** 人类可读的速率 */
export function formatSpeed(bytesPerSec) {
  if (!isFinite(bytesPerSec) || bytesPerSec <= 0) return '—';
  if (bytesPerSec >= 1024 * 1024) return (bytesPerSec / 1024 / 1024).toFixed(2) + ' MB/s';
  if (bytesPerSec >= 1024) return (bytesPerSec / 1024).toFixed(2) + ' KB/s';
  return Math.round(bytesPerSec) + ' B/s';
}

/** 人类可读的时长 */
export function formatDuration(ms) {
  if (!isFinite(ms) || ms < 0) return '—';
  const s = Math.ceil(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

/** 人类可读的字节数 */
export function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(2) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}
