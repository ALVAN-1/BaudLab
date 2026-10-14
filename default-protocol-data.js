/**
 * 默认协议数据：步进电机控制驱动协议 v1.0.0
 * 基于 UART 的步进电机控制驱动通信协议示例
 * 客户端与服务器初始化时自动插入（幂等）
 */

const PROTO_NAME = '步进电机控制驱动协议';
const PROTO_VERSION = 'v1.0.0';

const fieldOrder = ['sof', 'src', 'dst', 'ver', 'cmd', 'ctr', 'seq', 'tid', 'len', 'data', 'chk', 'eof'];

const fieldConfig = {
  sof: { enabled: true, byteCount: 1, customCount: 1, defaults: ['AA'] },
  src: { enabled: true, byteCount: 1, customCount: 1, defaults: ['01'] },
  dst: { enabled: true, byteCount: 1, customCount: 1, defaults: ['02'] },
  ver: { enabled: false, byteCount: 1, customCount: 1, defaults: ['01'] },
  cmd: { enabled: true, byteCount: 2, customCount: 2, defaults: ['01', '00'] },
  ctr: { enabled: false, byteCount: 1, customCount: 1, defaults: ['00'] },
  seq: { enabled: false, byteCount: 1, customCount: 1, defaults: ['00'] },
  tid: { enabled: false, byteCount: 1, customCount: 1, defaults: ['00'] },
  len: { enabled: true, byteCount: 1, customCount: 1, defaults: [] },
  data: { enabled: true, byteCount: 2, customCount: 2, defaults: [] },
  chk: { enabled: true, byteCount: 2, customCount: 2, defaults: [] },
  eof: { enabled: true, byteCount: 1, customCount: 1, defaults: ['0D'] },
};

const configJson = JSON.stringify({
  protoDesc: '步进电机控制驱动协议示例。基于 UART 的通用帧（帧头 / 源地址 / 目标地址 / 命令字 / 长度 / 数据 / CRC16 / 帧尾），' +
    '覆盖电机使能与失能、运动参数设置、绝对与相对位置运动、运动停止以及驱动器状态上报，适用于单轴或多轴步进电机驱动器控制。',
  fieldOrder,
  fieldConfig: Object.fromEntries(
    fieldOrder.map(k => [k, { ...fieldConfig[k], byteCount: fieldConfig[k].byteCount === 'custom' ? fieldConfig[k].customCount : fieldConfig[k].byteCount }])
  ),
  endianness: '大端 (Big-Endian)',
  checkType: 'CRC16-MODBUS',
  checkStartField: 'SOF',
  checkEndField: 'DATA',
});

const modules = [
  { name: '广播地址', address: '00' },
  { name: '上位机', address: '01' },
  { name: 'X轴驱动器', address: '02' },
  { name: 'Y轴驱动器', address: '03' },
  { name: 'Z轴驱动器', address: '04' },
  { name: '旋转轴驱动器', address: '05' },
];

/* 主站（上位机）发送的指令方向为 tx，其余（驱动器上报）为 rx */
const MASTER_SENDER = '上位机';

function hexVal(v) {
  if (!v) return '00';
  return v.replace(/^0x/i, '').toUpperCase().padStart(2, '0');
}

function funcToBytes(funcStr) {
  const val = funcStr.replace(/^0x/i, '');
  const high = val.length >= 4 ? val.substring(0, 2).toUpperCase() : '00';
  const low = val.length >= 4 ? val.substring(2, 4).toUpperCase() : val.padStart(2, '0').toUpperCase();
  return [high, low];
}

function convertFields(byteConfigs) {
  if (!byteConfigs || byteConfigs.length === 0) return [];
  return byteConfigs.map(bc => {
    if (bc.parseMode === 'enum') {
      return {
        name: bc.name,
        type: 'enum',
        enumItems: (bc.enumValues || []).map(ev => ({ value: hexVal(ev.value), meaning: ev.label || '' })),
      };
    } else if (bc.parseMode === 'bits' || bc.bitMode === true) {
      const bits = (bc.bits || []).map((label, i) => {
        if (label.startsWith('Reserve_')) return { bit: i, zero: '', one: '' };
        return { bit: i, zero: '正常', one: label };
      });
      while (bits.length < 8) bits.push({ bit: bits.length, zero: '', one: '' });
      return { name: bc.name, type: 'bitfield', bits };
    }
    return { name: bc.name, type: 'raw', rawValue: '00' };
  });
}

function getDirection(sender) {
  return sender === MASTER_SENDER ? 'tx' : 'rx';
}

const funcDefs = [
  {
    func: '0x0100', name: '电机使能', sender: '上位机', receiver: 'X轴驱动器', dataLen: 1, byteConfigs: [
      { name: '使能状态', parseMode: 'enum', enumValues: [
        { value: '0x00', label: '失能' }, { value: '0x01', label: '使能' },
      ]},
    ], desc: '控制驱动器功率级使能，0x00 失能、0x01 使能；使能后电机绕组保持抱死。', cycle: 0,
  },
  {
    func: '0x0200', name: '设定运动参数', sender: '上位机', receiver: 'X轴驱动器', dataLen: 6, byteConfigs: [
      { name: '运行速度H', parseMode: 'raw' },
      { name: '运行速度M', parseMode: 'raw' },
      { name: '运行速度L', parseMode: 'raw' },
      { name: '加速度H', parseMode: 'raw' },
      { name: '加速度L', parseMode: 'raw' },
      { name: '细分档位', parseMode: 'enum', enumValues: [
        { value: '0x00', label: '1 细分' }, { value: '0x01', label: '2 细分' },
        { value: '0x02', label: '4 细分' }, { value: '0x03', label: '8 细分' },
        { value: '0x04', label: '16 细分' }, { value: '0x05', label: '32 细分' },
      ]},
    ], desc: '设置运行速度（脉冲/秒，大端三字节）、加速度（大端两字节）与细分档位。', cycle: 0,
  },
  {
    func: '0x0300', name: '位置运动', sender: '上位机', receiver: 'X轴驱动器', dataLen: 4, byteConfigs: [
      { name: '运动模式', parseMode: 'enum', enumValues: [
        { value: '0x00', label: '绝对位置' }, { value: '0x01', label: '相对位置' },
      ]},
      { name: '目标位置H', parseMode: 'raw' },
      { name: '目标位置M', parseMode: 'raw' },
      { name: '目标位置L', parseMode: 'raw' },
    ], desc: '按绝对或相对位置运动，目标位置为 24 位有符号脉冲数（大端）。', cycle: 0,
  },
  {
    func: '0x0400', name: '停止运动', sender: '上位机', receiver: 'X轴驱动器', dataLen: 1, byteConfigs: [
      { name: '停止方式', parseMode: 'enum', enumValues: [
        { value: '0x00', label: '减速停止' }, { value: '0x01', label: '紧急停止' },
      ]},
    ], desc: '停止当前运动，减速停止按设定减速度平稳停车，紧急停止立即切断使能。', cycle: 0,
  },
  {
    func: '0x0500', name: '驱动器状态上报', sender: 'X轴驱动器', receiver: '上位机', dataLen: 8, byteConfigs: [
      { name: '运行状态', parseMode: 'enum', enumValues: [
        { value: '0x00', label: '空闲' }, { value: '0x01', label: '加速中' },
        { value: '0x02', label: '匀速运行' }, { value: '0x03', label: '减速中' },
        { value: '0x04', label: '已停止' },
      ]},
      { name: '当前位置H', parseMode: 'raw' },
      { name: '当前位置M', parseMode: 'raw' },
      { name: '当前位置L', parseMode: 'raw' },
      { name: '错误码', parseMode: 'enum', enumValues: [
        { value: '0x00', label: '无错误' }, { value: '0x01', label: '过流' },
        { value: '0x02', label: '过压' }, { value: '0x03', label: '欠压' },
        { value: '0x04', label: '堵转' }, { value: '0x05', label: '过温' },
      ]},
      { name: '使能状态', parseMode: 'enum', enumValues: [
        { value: '0x00', label: '失能' }, { value: '0x01', label: '使能' },
      ]},
      { name: '母线电压H', parseMode: 'raw' },
      { name: '母线电压L', parseMode: 'raw' },
    ], desc: '驱动器主动上报运行状态、当前位置、错误码、使能状态与母线电压。', cycle: 0,
  },
];

const snapshotJson = JSON.stringify({
  protoName: PROTO_NAME,
  protoDesc: '基于 UART 的步进电机控制驱动通信协议示例',
  versionMajor: 1, versionMinor: 0, versionPatch: 0,
  fieldOrder, fieldConfig, endianness: '大端 (Big-Endian)',
  checkType: 'CRC16-MODBUS', checkStartField: 'SOF', checkEndField: 'DATA',
  moduleAddresses: modules.map(m => ({ name: m.name, addressBytes: [m.address] })),
  commands: funcDefs.map(fd => ({
    cmd: fd.func, cmdBytes: funcToBytes(fd.func), name: fd.name,
    sender: fd.sender, receiver: fd.receiver,
    dir: getDirection(fd.sender), cycle: String(fd.cycle || 0),
    payloadLen: fd.dataLen, fields: convertFields(fd.byteConfigs),
  })),
});

/**
 * 将默认协议插入数据库（幂等：已存在则跳过）
 * @param {import('better-sqlite3').Database | import('node:sqlite').DatabaseSync} db
 */
function insertDefaultProtocol(db) {
  const existing = db.prepare('SELECT id FROM protocols WHERE name = ?').get(PROTO_NAME);
  if (existing) return false;

  const insertProto = db.prepare(
    'INSERT INTO protocols (name, version, byte_order, check_method, check_start, check_end, config_json) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const result = insertProto.run(PROTO_NAME, PROTO_VERSION, 'big', 'CRC16-MODBUS', 'SOF', 'DATA', configJson);
  const protoId = result.lastInsertRowid;

  const insertModule = db.prepare('INSERT INTO modules (protocol_id, name, address) VALUES (?, ?, ?)');
  for (const mod of modules) {
    insertModule.run(protoId, mod.name, mod.address);
  }

  const insertCmd = db.prepare(
    'INSERT INTO commands (protocol_id, code, name, sender, receiver, period_ms, direction, config_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  for (const fd of funcDefs) {
    const cmdBytes = funcToBytes(fd.func);
    const fields = convertFields(fd.byteConfigs);
    const direction = getDirection(fd.sender);
    const cmdConfig = JSON.stringify({
      cmd: fd.func, cmdBytes, name: fd.name,
      sender: fd.sender, receiver: fd.receiver,
      dir: direction, cycle: String(fd.cycle || 0),
      payloadLen: fd.dataLen, fields,
    });
    insertCmd.run(protoId, fd.func, fd.name, fd.sender, fd.receiver, fd.cycle || 0, direction === 'tx' ? 'send' : 'recv', cmdConfig);
  }

  try {
    const pv = db.prepare(
      'INSERT INTO protocol_versions (protocol_id, protocol_name, version, config_json, status, created_by) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(protoId, PROTO_NAME, PROTO_VERSION, snapshotJson, 'published', 'system');
    /* 初始版本即当前版本，避免 current_version_id 为 NULL 导致版本历史面板为空 */
    db.prepare('UPDATE protocols SET current_version_id = ? WHERE id = ?').run(pv.lastInsertRowid, protoId);
  } catch { /* ignore */ }

  return true;
}

module.exports = { insertDefaultProtocol, PROTO_NAME, PROTO_VERSION };
