/**
 * AFT-1 文件传输发送端引擎
 * ------------------------------------------------
 * 与传输介质无关：构造时注入 send(bytes)，链路字节通过 consumeLinkBytes() 喂回，
 * 因此同一份引擎既可以走真实串口（hex 适配），也可以走内置模拟接收端做无硬件联调。
 *
 * 可靠性策略：
 *  - 握手：FILE_BEGIN 等 READY，超时重发（最多 handshakeRetries 次）
 *  - 数据：滑动窗口 + 块级超时重传；单块重传超上限后触发「同步轮」——
 *    停发新块、发 FILE_END 让接收端用 RESEND 报告权威缺失清单，再定向补传
 *  - 收尾：FILE_END → FINAL(OK) 结束；RESEND 则补传后再次 FILE_END（最多 resendRounds 轮）
 *  - 整包 CRC32 不符：作废对端数据自动全量重传一次
 *  - 断点续传：READY 携带对端已有进度 resumeFrom，发送端直接跳过已确认块
 */
import {
  T, FINAL_STATUS, FRAME_OVERHEAD, MIN_MTU, MAX_MTU, TYPE_NAMES,
  FrameDecoder, encodeFrame, encodeFileBegin, encodeU32, decodeResend, crc32,
} from './fileTransferProtocol.js';

export const SENDER_STATE = {
  IDLE: 'idle',
  HANDSHAKE: 'handshake',
  TRANSFER: 'transfer',
  FINALIZE: 'finalize',
  DONE: 'done',
  ERROR: 'error',
  CANCELLED: 'cancelled',
  PAUSED: 'paused',
};

export const DEFAULT_TRANSFER_OPTIONS = {
  mtu: 256,             // 单帧线上最大字节数
  windowSize: 8,        // 滑动窗口（在途块数上限）
  timeoutMs: 600,       // 块级超时（无 ACK 视为丢失）
  maxRetries: 6,        // 单块超时重传上限，超过后转同步轮
  syncRounds: 5,        // 同步轮上限
  resendRounds: 8,      // FILE_END 后 RESEND 补传轮数上限
  handshakeTimeoutMs: 2000,
  handshakeRetries: 3,
  interFrameDelayMs: 0, // 两帧之间的最小间隔（兼容丢包严重的廉价 USB 串口）
};

export class FileTransferSender {
  /**
   * @param {Object} opts
   * @param {(bytes: Uint8Array) => Promise<void>|void} opts.send 发送原始帧字节
   * @param {Partial<typeof DEFAULT_TRANSFER_OPTIONS>} [opts.options]
   * @param {(state: string) => void} [opts.onState]
   * @param {(stats: Object) => void} [opts.onProgress]
   * @param {(level: 'info'|'ok'|'warn'|'err', msg: string) => void} [opts.onLog]
   * @param {(dir: 'tx'|'rx', typeName: string, len: number) => void} [opts.onFrame]
   */
  constructor({ send, options = {}, onState, onProgress, onLog, onFrame }) {
    this.sendFn = send;
    this.opts = { ...DEFAULT_TRANSFER_OPTIONS, ...options };
    this.opts.mtu = Math.min(MAX_MTU, Math.max(MIN_MTU, this.opts.mtu | 0));
    this.onStateCb = onState || (() => {});
    this.onProgressCb = onProgress || (() => {});
    this.onLogCb = onLog || (() => {});
    this.onFrameCb = onFrame || (() => {});

    this.decoder = new FrameDecoder();
    this.state = SENDER_STATE.IDLE;
    this.file = null;
    this.timer = null;
    this.lastSendAt = 0;
    this.pauseRequested = false;
    this.cancelRequested = false;
    this.errorMessage = '';
    this._resetRun();
  }

  _resetRun() {
    this.chunkSize = this.opts.mtu - FRAME_OVERHEAD;
    this.totalBlocks = 0;
    this.sendCursor = 0;           // 单调递增的「下一个待发送块」游标
    this.inFlight = new Map();     // blockIdx → { sentAt, retries }
    this.acked = new Set();
    this.handshakeRetries = 0;
    this.lastHandshakeAt = 0;
    this.lastEndAt = 0;
    this.retransmitCount = 0;
    this.syncRounds = 0;
    this.resendRounds = 0;
    this.fullRetried = false;
    this.resumeFrom = 0;
    this.activeMs = 0;
    this.lastTickAt = 0;
    this.speed = 0;                // EWMA 平滑速率 B/s
    this.lastAckAt = 0;
    this.lastAckBlock = null;
  }

  // ------------------------------------------------------------------ 生命周期

  /** @param {{ name: string, data: Uint8Array }} file */
  async start(file) {
    const resumable = [SENDER_STATE.IDLE, SENDER_STATE.DONE, SENDER_STATE.ERROR, SENDER_STATE.CANCELLED];
    if (!resumable.includes(this.state)) return;
    this._resetRun();
    this.cancelRequested = false;
    this.pauseRequested = false;
    this.errorMessage = '';
    this.file = {
      name: file.name || 'file.bin',
      size: file.data.length,
      data: file.data,
      crc32: crc32(file.data),
    };
    this.totalBlocks = this.file.size > 0 ? Math.ceil(this.file.size / this.chunkSize) : 0;
    this._log('info', `准备传输「${this.file.name}」${this.file.size} B，CRC32=0x${this.file.crc32.toString(16).toUpperCase().padStart(8, '0')}，chunk=${this.chunkSize}B，共 ${this.totalBlocks} 块`);
    this.lastTickAt = Date.now();
    this._setState(SENDER_STATE.HANDSHAKE);
    await this._sendFileBegin();
    this._startTimer();
  }

  pause() {
    if (this.state !== SENDER_STATE.TRANSFER) return;
    this.pauseRequested = true;
    this._log('info', '已暂停（在途块将重新发送）');
    this._setState(SENDER_STATE.PAUSED);
  }

  resume() {
    if (this.state !== SENDER_STATE.PAUSED) return;
    this.pauseRequested = false;
    for (const [, entry] of this.inFlight) entry.sentAt = 0;   // 立即重传在途块
    this._log('info', '继续传输');
    this._setState(SENDER_STATE.TRANSFER);
  }

  /** @param {boolean} discard true=请求接收端丢弃已收数据，false=保留断点进度 */
  async cancel(discard = false) {
    const active = [SENDER_STATE.HANDSHAKE, SENDER_STATE.TRANSFER, SENDER_STATE.FINALIZE, SENDER_STATE.PAUSED];
    if (!active.includes(this.state)) return;
    this.cancelRequested = true;
    this._stopTimer();
    try {
      await this._write(encodeFrame(T.CANCEL, Uint8Array.of(discard ? 1 : 0)), 'CANCEL');
      this._log('info', discard ? '已取消，请求接收端丢弃数据' : '已取消，接收端保留断点进度（可续传）');
    } catch { /* 链路已断则忽略 */ }
    this._setState(SENDER_STATE.CANCELLED);
  }

  dispose() {
    this._stopTimer();
    this.state = SENDER_STATE.IDLE;
  }

  /** 外部致命错误（如串口被拔出）时立即中止 */
  failExternal(msg) {
    if ([SENDER_STATE.HANDSHAKE, SENDER_STATE.TRANSFER, SENDER_STATE.FINALIZE, SENDER_STATE.PAUSED].includes(this.state)) {
      this._fail(msg);
    }
  }

  // ------------------------------------------------------------------ 链路字节入口

  /** 把链路上收到的原始字节喂给引擎（串口 RX / 模拟端回环都走这里） */
  consumeLinkBytes(bytes) {
    for (const frame of this.decoder.feed(bytes)) {
      this.onFrameCb('rx', TYPE_NAMES[frame.type] || '0x' + frame.type.toString(16).padStart(2, '0'), frame.payload.length);
      try {
        this._handleFrame(frame);
      } catch (e) {
        this._log('err', `处理帧出错: ${e.message}`);
      }
    }
  }

  _handleFrame(frame) {
    switch (frame.type) {
      case T.READY: {
        if (this.state !== SENDER_STATE.HANDSHAKE) return;
        const mode = frame.payload.length >= 1 ? frame.payload[0] : 0;
        const resumeFrom = frame.payload.length >= 5
          ? new DataView(frame.payload.buffer, frame.payload.byteOffset).getUint32(1, true)
          : 0;
        this.resumeFrom = Math.min(resumeFrom, this.totalBlocks);
        this.sendCursor = this.resumeFrom;
        if (this.resumeFrom >= this.totalBlocks) {
          // 对端已拥有完整文件（如上次取消前已收满）：跳过数据阶段直接收尾校验
          this._log('info', '接收端已存在完整文件，直接进入收尾校验');
          this._setState(SENDER_STATE.FINALIZE);
          this._sendFileEnd();
          break;
        }
        this._log(mode === 1
          ? 'info'
          : 'info',
          mode === 1
            ? `接收端命中断点续传：前 ${this.resumeFrom}/${this.totalBlocks} 块已存在，自动跳过`
            : `接收端就绪（新会话），从块 0 开始发送`);
        this._setState(SENDER_STATE.TRANSFER);
        break;
      }
      case T.ACK: {
        if (frame.payload.length < 4) return;
        const blockIdx = new DataView(frame.payload.buffer, frame.payload.byteOffset).getUint32(0, true);
        this._onAck(blockIdx);
        break;
      }
      case T.RESEND: {
        if (this.state !== SENDER_STATE.FINALIZE) return;
        const missing = decodeResend(frame.payload);
        this._log('warn', `接收端报告缺失 ${missing.length} 块，定向补传`);
        for (const idx of missing) {
          if (!this.acked.has(idx)) {
            this.retransmitCount++;
            this._sendDataBlock(idx);
          }
        }
        break;
      }
      case T.FINAL:
        this._onFinal(frame.payload.length >= 1 ? frame.payload[0] : FINAL_STATUS.NO_SESSION);
        break;
      case T.CANCEL_ACK:
        this._log('info', '接收端已确认取消');
        break;
      default:
        break;
    }
  }

  _onAck(blockIdx) {
    if (this.acked.has(blockIdx)) return;
    const wasInFlight = this.inFlight.delete(blockIdx);
    if (!wasInFlight) return;   // 重复/迟到 ACK，忽略
    this.acked.add(blockIdx);

    const now = Date.now();
    if (this.lastAckAt && this.lastAckBlock !== null && blockIdx > this.lastAckBlock) {
      const bytes = (blockIdx - this.lastAckBlock) * this.chunkSize;
      const dt = Math.max(1, now - this.lastAckAt);
      const inst = Math.min(bytes / (dt / 1000), 10 * 1024 * 1024);
      this.speed = this.speed ? this.speed * 0.7 + inst * 0.3 : inst;
    }
    this.lastAckAt = now;
    this.lastAckBlock = blockIdx;

    // 同步轮补传完最后一块：立即再次 FILE_END，省去等超时
    if (this.state === SENDER_STATE.FINALIZE && this.inFlight.size === 0 && this._receiverDone()) {
      this._sendFileEnd();
    }
  }

  /** 接收端视角是否已收齐（断点续传时含上一会话的 resumeFrom 部分） */
  _receiverDone() {
    return this.acked.size >= this.totalBlocks - this.resumeFrom;
  }

  _onFinal(status) {
    if (this.state !== SENDER_STATE.FINALIZE && this.state !== SENDER_STATE.TRANSFER) return;
    if (status === FINAL_STATUS.OK) {
      this._stopTimer();
      this._log('ok', `传输完成！${this.file.size} B / ${this.totalBlocks} 块，累计重传 ${this.retransmitCount} 次，用时 ${formatSeconds(this.activeMs)}`);
      this._setState(SENDER_STATE.DONE);
      return;
    }
    if (status === FINAL_STATUS.CRC_MISMATCH) {
      if (!this.fullRetried) {
        this.fullRetried = true;
        this._log('warn', '整包 CRC32 不符，作废对端数据，自动全量重传一次');
        return this._restartHandshake();
      }
      this._fail('整包 CRC32 校验失败（已自动全量重传过一次），请检查链路质量');
      return;
    }
    if (status === FINAL_STATUS.UNSUPPORTED) {
      this._fail('接收端不支持当前协议版本');
      return;
    }
    if (status === FINAL_STATUS.NO_SESSION) {
      if (!this.fullRetried) {
        this.fullRetried = true;
        this._log('warn', '接收端无会话记录（可能重启过），重新握手');
        return this._restartHandshake();
      }
      this._fail('接收端无会话记录且重试无效');
      return;
    }
    this._fail(`接收端返回未知状态 ${status}`);
  }

  _restartHandshake() {
    this.acked.clear();
    this.inFlight.clear();
    this.sendCursor = 0;
    this._setState(SENDER_STATE.HANDSHAKE);
    this._sendFileBegin().catch(() => {});
  }

  // ------------------------------------------------------------------ 调度

  _startTimer() {
    this._stopTimer();
    this.timer = setInterval(() => this._tick(), 25);
  }

  _stopTimer() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  _tick() {
    if (!this.timer) return;
    const now = Date.now();
    this.activeMs += now - this.lastTickAt;
    this.lastTickAt = now;

    switch (this.state) {
      case SENDER_STATE.HANDSHAKE:
        if (now - this.lastHandshakeAt >= this.opts.handshakeTimeoutMs) {
          this.handshakeRetries++;
          if (this.handshakeRetries > this.opts.handshakeRetries) {
            this._fail('握手超时：接收端无响应（请确认对端已实现 AFT-1 协议并处于接收等待状态）');
            return;
          }
          this._log('warn', `握手超时，重发 FILE_BEGIN（第 ${this.handshakeRetries} 次）`);
          this._sendFileBegin().catch(() => {});
        }
        break;

      case SENDER_STATE.TRANSFER: {
        if (this.pauseRequested) break;
        // 1) 在途块超时重传
        for (const [idx, entry] of this.inFlight) {
          if (now - entry.sentAt >= this.opts.timeoutMs) {
            if (entry.retries >= this.opts.maxRetries) {
              this._startSyncRound();
              return;
            }
            entry.retries++;
            entry.sentAt = now;
            this.retransmitCount++;
            this._sendDataBlock(idx, true);
          }
        }
        // 2) 填充滑动窗口（游标单调前进，不回头扫全量）
        while (this.inFlight.size < this.opts.windowSize && this.sendCursor < this.totalBlocks) {
          if (this.acked.has(this.sendCursor) || this.inFlight.has(this.sendCursor)) {
            this.sendCursor++;
            continue;
          }
          this._sendDataBlock(this.sendCursor);
          this.sendCursor++;
        }
        // 3) 全部确认 → 收尾（acked 只含本次会话发送的块，需按 resumeFrom 折算）
        if (this.inFlight.size === 0 && this._receiverDone()) {
          this._setState(SENDER_STATE.FINALIZE);
          this._sendFileEnd();
        } else if (this.totalBlocks === 0 && this.acked.size === 0) {
          // 空文件：无数据块，直接收尾
          this._setState(SENDER_STATE.FINALIZE);
          this._sendFileEnd();
        }
        break;
      }

      case SENDER_STATE.FINALIZE:
        if (now - this.lastEndAt >= this.opts.handshakeTimeoutMs) {
          this.resendRounds++;
          if (this.resendRounds > this.opts.resendRounds) {
            this._fail('收尾超时：接收端始终未给出最终确认');
            return;
          }
          this._log('warn', `FILE_END 应答超时，重发（第 ${this.resendRounds} 轮）`);
          this._sendFileEnd();
        }
        break;

      default:
        break;
    }
    // 活跃态持续上报进度（由视图节流刷新 UI）
    if ([SENDER_STATE.HANDSHAKE, SENDER_STATE.TRANSFER, SENDER_STATE.FINALIZE].includes(this.state)) {
      this._emitProgress();
    }
  }

  /**
   * 同步轮：单块反复重传仍无 ACK 时，停发新数据，
   * 主动 FILE_END 让接收端给出权威缺失清单后定向补传，重新收敛。
   */
  _startSyncRound() {
    this.syncRounds++;
    if (this.syncRounds > this.opts.syncRounds) {
      this._fail(`连续 ${this.opts.syncRounds} 轮同步后仍无法推进，链路质量过差或对端离线`);
      return;
    }
    this._log('warn', `多块持续无确认，启动第 ${this.syncRounds} 轮同步（请求接收端缺失清单）`);
    this.inFlight.clear();
    this._setState(SENDER_STATE.FINALIZE);
    this._sendFileEnd();
  }

  // ------------------------------------------------------------------ 帧发送

  async _write(bytes, typeName) {
    const gap = this.opts.interFrameDelayMs;
    if (gap > 0) {
      const wait = this.lastSendAt + gap - Date.now();
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
    }
    this.lastSendAt = Date.now();
    this.onFrameCb('tx', typeName, bytes.length - FRAME_OVERHEAD);
    await this.sendFn(bytes);
  }

  async _sendFileBegin() {
    this.lastHandshakeAt = Date.now();
    const payload = encodeFileBegin({
      chunkSize: this.chunkSize,
      fileSize: this.file.size,
      totalBlocks: this.totalBlocks,
      fileCrc32: this.file.crc32,
      name: this.file.name,
    });
    await this._write(encodeFrame(T.FILE_BEGIN, payload), 'FILE_BEGIN');
  }

  /** @param {number} idx @param {boolean} [isRetransmit] 重传不推进游标（游标已越过） */
  _sendDataBlock(idx, isRetransmit = false) {
    const start = idx * this.chunkSize;
    const chunk = this.file.data.subarray(start, Math.min(start + this.chunkSize, this.file.size));
    const payload = new Uint8Array(4 + chunk.length);
    new DataView(payload.buffer).setUint32(0, idx >>> 0, true);
    payload.set(chunk, 4);
    const entry = this.inFlight.get(idx);
    if (!entry || !isRetransmit) {
      this.inFlight.set(idx, { sentAt: Date.now(), retries: entry ? entry.retries : 0 });
    }
    this._write(encodeFrame(T.DATA, payload), 'DATA').catch(e => this._log('err', `发送失败: ${e.message}`));
  }

  _sendFileEnd() {
    this.lastEndAt = Date.now();
    this._write(encodeFrame(T.FILE_END, encodeU32(this.file.crc32)), 'FILE_END')
      .catch(e => this._log('err', `发送失败: ${e.message}`));
  }

  // ------------------------------------------------------------------ 状态与进度

  _setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.onStateCb(s);
    this._emitProgress();
  }

  _fail(msg) {
    this._stopTimer();
    this.errorMessage = msg;
    this._log('err', msg);
    this._setState(SENDER_STATE.ERROR);
  }

  _emitProgress() {
    const done = this.state === SENDER_STATE.DONE;
    // 接收端视角的已收块数 = 断点续传基数 + 本次会话确认数
    const ackedBlocks = done ? this.totalBlocks : Math.min(this.totalBlocks, this.resumeFrom + this.acked.size);
    const ackedBytes = this.file ? Math.min(ackedBlocks * this.chunkSize, this.file.size) : 0;
    const remainingBytes = this.file ? Math.max(0, this.file.size - ackedBytes) : 0;
    const percent = this.totalBlocks > 0
      ? Math.min(100, Math.floor((ackedBlocks / this.totalBlocks) * 100))
      : (done ? 100 : 0);
    this.onProgressCb({
      state: this.state,
      percent,
      totalBlocks: this.totalBlocks,
      ackedBlocks,
      inFlight: this.inFlight.size,
      ackedBytes,
      fileSize: this.file ? this.file.size : 0,
      resumeFrom: this.resumeFrom,
      retransmitCount: this.retransmitCount,
      syncRounds: this.syncRounds,
      resendRounds: this.resendRounds,
      speed: this.speed,
      activeMs: this.activeMs,
      etaMs: this.speed > 0 ? (remainingBytes / this.speed) * 1000 : Infinity,
      errorMessage: this.errorMessage,
    });
  }

  _log(level, msg) {
    this.onLogCb(level, `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`);
  }
}

function formatSeconds(ms) {
  return (Math.round(ms / 100) / 10) + 's';
}
