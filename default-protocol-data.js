/**
 * 默认协议数据：PUMP协议 V0.0.1
 * 智能炒菜机板间UART全双工通信协议
 * 客户端与服务器初始化时自动插入（幂等）
 */

const PROTO_NAME = 'PUMP协议';
const PROTO_VERSION = 'v0.0.1';

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
  protoDesc: '智能炒菜机板间UART全双工通信协议。含通用帧（紧急停机/心跳/应答）、控制指令、故障上报、状态上报、查询指令、配置标定等。',
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
  { name: '主控板', address: '01' },
  { name: '液料泵送板', address: '02' },
  { name: 'IH控制板', address: '03' },
  { name: '旋钮屏模块', address: '04' },
  { name: '投菜板', address: '05' },
];

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
  if (sender && (sender.includes('液料泵送板') || sender.includes('投菜板'))) return 'rx';
  return 'tx';
}

const funcDefs = [
  { func: '0x0100', name: '紧急停机', sender: '主控板', receiver: '液料泵送板', dataLen: 0, byteConfigs: [], desc: '所有模块立即停止所有动作', cycle: 0 },
  { func: '0x0105', name: '心跳帧', sender: '主控板', receiver: '液料泵送板', dataLen: 0, byteConfigs: [], desc: '每1s发送，3s无心跳判定离线', cycle: 1000 },
  { func: '0xE001', name: '模块应答', sender: '液料泵送板', receiver: '主控板', dataLen: 8, byteConfigs: [
    { name: '应答状态', parseMode: 'enum', enumValues: [{ value: '0x00', label: 'NACK' }, { value: '0x01', label: 'ACK' }] },
    { name: '模块地址', parseMode: 'raw' },
    { name: '接收到的命令字H', parseMode: 'raw' },
    { name: '接收到的命令字L', parseMode: 'raw' },
    { name: '模块当前状态', parseMode: 'enum', enumValues: [
      { value: '0x00', label: '初始化中' }, { value: '0x01', label: '空闲中' },
      { value: '0x02', label: '执行中' }, { value: '0x03', label: '执行完成' },
    ]},
    { name: '错误码', parseMode: 'enum', enumValues: [
      { value: '0x00', label: '无错误' }, { value: '0x01', label: '不支持的CMD' },
      { value: '0x02', label: '参数错误' }, { value: '0x03', label: '设备忙' },
      { value: '0x04', label: '设备故障' }, { value: '0x05', label: '执行失败' },
    ]},
    { name: '故障命令字H', parseMode: 'raw' },
    { name: '故障命令字L', parseMode: 'raw' },
  ], desc: '模块应答，ACK与NACK，无故障时故障命令字为0x0000', cycle: 0 },
  { func: '0x0200', name: '泵料', sender: '主控板', receiver: '液料泵送板', dataLen: 5, byteConfigs: [
    { name: '调料编号', parseMode: 'enum', enumValues: [
      { value: '0x00', label: '油' }, { value: '0x01', label: '醋' }, { value: '0x02', label: '盐水' },
      { value: '0x03', label: '水' }, { value: '0x04', label: '苏打/糖水' }, { value: '0x05', label: '料酒' },
      { value: '0x06', label: '生抽' }, { value: '0x07', label: '老抽' },
    ]},
    { name: '泵料重量_H', parseMode: 'raw' },
    { name: '泵料重量_M', parseMode: 'raw' },
    { name: '泵料重量_L', parseMode: 'raw' },
    { name: '泵料超时时间（秒）', parseMode: 'raw' },
  ], desc: '指定调料泵送，泵料重量（如1000.01g扩大100倍10001），泵料超过超时时间视为失败', cycle: 0 },
  { func: '0x0201', name: '停止泵料', sender: '主控板', receiver: '液料泵送板', dataLen: 1, byteConfigs: [
    { name: '调料编号', parseMode: 'enum', enumValues: [
      { value: '0x00', label: '油' }, { value: '0x01', label: '醋' }, { value: '0x02', label: '盐水' },
      { value: '0x03', label: '水' }, { value: '0x04', label: '苏打/糖水' }, { value: '0x05', label: '料酒' },
      { value: '0x06', label: '生抽' }, { value: '0x07', label: '老抽' }, { value: '0x0A', label: '全部停止泵送' },
    ]},
  ], desc: '指定调料停止泵送，0x0A表示全部停止', cycle: 0 },
  { func: '0x0300', name: '投菜', sender: '主控板', receiver: '投菜板', dataLen: 3, byteConfigs: [
    { name: '菜盒编号', parseMode: 'enum', enumValues: [
      { value: '0x00', label: '1号菜盒' }, { value: '0x01', label: '2号菜盒' }, { value: '0x02', label: '3号菜盒' },
    ]},
    { name: '抖动次数', parseMode: 'raw' },
    { name: '振动时间（秒）', parseMode: 'raw' },
  ], desc: '菜盒编号（1~3），抖动次数（1~10），振动时间（1~10）', cycle: 0 },
  { func: '0x0301', name: '取消投菜', sender: '主控板', receiver: '投菜板', dataLen: 1, byteConfigs: [
    { name: '菜盒编号', parseMode: 'enum', enumValues: [
      { value: '0x00', label: '1号菜盒' }, { value: '0x01', label: '2号菜盒' },
      { value: '0x02', label: '3号菜盒' }, { value: '0x0A', label: '取消全部尚未投放菜盒' },
    ]},
  ], desc: '菜盒编号为0x0A表示取消全部尚未投放菜盒', cycle: 0 },
  { func: '0x0E00', name: '查询液位', sender: '主控板', receiver: '液料泵送板', dataLen: 1, byteConfigs: [
    { name: '调料编号', parseMode: 'enum', enumValues: [
      { value: '0x00', label: '油' }, { value: '0x01', label: '醋' }, { value: '0x02', label: '盐水' },
      { value: '0x03', label: '水' }, { value: '0x04', label: '苏打/糖水' }, { value: '0x05', label: '料酒' },
      { value: '0x06', label: '生抽' }, { value: '0x07', label: '老抽' }, { value: '0x0A', label: '全部' },
    ]},
  ], desc: '查询调料的液位状态，0x0A代表全部调料液位', cycle: 0 },
  { func: '0x0E01', name: '查询调料总重', sender: '主控板', receiver: '液料泵送板', dataLen: 0, byteConfigs: [], desc: '查询调料总重', cycle: 0 },
  { func: '0x0E02', name: '查询调料泵状态', sender: '主控板', receiver: '液料泵送板', dataLen: 0, byteConfigs: [], desc: '查询当前调料泵状态，运行中/停止', cycle: 0 },
  { func: '0x0F00', name: '查询投菜摇臂状态', sender: '主控板', receiver: '投菜板', dataLen: 0, byteConfigs: [], desc: '查询投菜摇臂状态', cycle: 0 },
  { func: '0x0F01', name: '查询菜盒是否放置', sender: '主控板', receiver: '投菜板', dataLen: 1, byteConfigs: [
    { name: '菜盒编号', parseMode: 'enum', enumValues: [
      { value: '0x00', label: '1号菜盒' }, { value: '0x01', label: '2号菜盒' }, { value: '0x03', label: '3号菜盒' },
    ]},
  ], desc: '查询具体菜盒是否放置到位', cycle: 0 },
  { func: '0x0F02', name: '查询冰箱门状态', sender: '主控板', receiver: '投菜板', dataLen: 0, byteConfigs: [], desc: '查询冰箱门状态', cycle: 0 },
  { func: '0x0600', name: '调料最低液位故障', sender: '液料泵送板', receiver: '主控板', dataLen: 1, byteConfigs: [
    { name: '所有调料最低液位状态', parseMode: 'bits', bitMode: true, bits: ['油', '醋', '盐水', '水', '苏打/糖水', '料酒', '生抽', '老抽'] },
  ], desc: '为1表示该调料液位低于最低液位故障', cycle: 0 },
  { func: '0x0602', name: '调料板称重故障', sender: '液料泵送板', receiver: '主控板', dataLen: 0, byteConfigs: [], desc: '泵送板称重故障', cycle: 0 },
  { func: '0x0601', name: '调料泵故障上报', sender: '液料泵送板', receiver: '主控板', dataLen: 2, byteConfigs: [
    { name: '调料编号', parseMode: 'enum', enumValues: [
      { value: '0x00', label: '油' }, { value: '0x01', label: '醋' }, { value: '0x02', label: '盐水' },
      { value: '0x03', label: '水' }, { value: '0x04', label: '苏打/糖水' }, { value: '0x05', label: '料酒' },
      { value: '0x06', label: '生抽' }, { value: '0x07', label: '老抽' },
    ]},
    { name: '故障状态', parseMode: 'raw' },
  ], desc: '上报某一路调料泵故障', cycle: 0 },
  { func: '0x0700', name: '投菜失败故障', sender: '投菜板', receiver: '主控板', dataLen: 1, byteConfigs: [
    { name: '故障类型', parseMode: 'enum', enumValues: [
      { value: '0x01', label: '步进电机故障' }, { value: '0x02', label: '振动电机故障' },
      { value: '0x03', label: '冰箱开关故障' }, { value: '0x04', label: '投菜超时' },
    ]},
  ], desc: '投菜失败故障上报', cycle: 0 },
  { func: '0x0A00', name: '调料泵料泵送结果状态上报', sender: '液料泵送板', receiver: '主控板', dataLen: 4, byteConfigs: [
    { name: '调料编号', parseMode: 'enum', enumValues: [
      { value: '0x00', label: '油泵送完成' }, { value: '0x01', label: '醋泵送完成' },
      { value: '0x02', label: '盐水泵送完成' }, { value: '0x03', label: '水泵送完成' },
      { value: '0x04', label: '苏打/糖水泵送完成' }, { value: '0x05', label: '料酒泵送完成' },
      { value: '0x06', label: '生抽泵送完成' }, { value: '0x07', label: '老抽泵送完成' },
      { value: '0x10', label: '油泵送失败' }, { value: '0x11', label: '醋泵送失败' },
      { value: '0x12', label: '盐水泵送失败' }, { value: '0x13', label: '水泵送失败' },
      { value: '0x14', label: '苏打/糖水泵送失败' }, { value: '0x15', label: '料酒泵送失败' },
      { value: '0x16', label: '生抽泵送失败' }, { value: '0x17', label: '老抽泵送失败' },
    ]},
    { name: '已泵送重量高', parseMode: 'raw' },
    { name: '已泵送重量中', parseMode: 'raw' },
    { name: '已泵送重量低', parseMode: 'raw' },
  ], desc: '泵料状态上报，执行完成泵料请求指令后主动上报', cycle: 0 },
  { func: '0x0A01', name: '调料总重', sender: '液料泵送板', receiver: '主控板', dataLen: 3, byteConfigs: [
    { name: '调料总重H', parseMode: 'raw' },
    { name: '调料总重M', parseMode: 'raw' },
    { name: '调料总重L', parseMode: 'raw' },
  ], desc: '调料盒总重数值上报', cycle: 0 },
  { func: '0x0A02', name: '调理泵运行状态', sender: '液料泵送板', receiver: '主控板', dataLen: 2, byteConfigs: [
    { name: '几号泵', parseMode: 'enum', enumValues: [
      { value: '0x00', label: '油' }, { value: '0x01', label: '醋' }, { value: '0x02', label: '盐水' },
      { value: '0x03', label: '水' }, { value: '0x04', label: '苏打/糖水' }, { value: '0x05', label: '料酒' },
      { value: '0x06', label: '生抽' }, { value: '0x07', label: '老抽' }, { value: '0x08', label: '全部' },
    ]},
    { name: '运行状态', parseMode: 'bits', bitMode: true, bits: ['油泵状态', '醋泵状态', '盐水泵状态', '水泵状态', '苏打/糖水泵状态', '料酒泵状态', '生抽泵状态', '老抽泵状态'] },
  ], desc: '1为运行状态、0为停止状态', cycle: 0 },
  { func: '0x0B00', name: '冰箱门状态', sender: '投菜板', receiver: '主控板', dataLen: 1, byteConfigs: [
    { name: '门开关状态', parseMode: 'enum', enumValues: [
      { value: '0x00', label: '关' }, { value: '0x01', label: '开' },
    ]},
  ], desc: '冰箱门开关状态上报', cycle: 0 },
  { func: '0x0B01', name: '投菜摇臂位置状态上报', sender: '投菜板', receiver: '主控板', dataLen: 1, byteConfigs: [
    { name: '投菜摇臂位置', parseMode: 'enum', enumValues: [
      { value: '0x00', label: '收回位置' }, { value: '0x01', label: '投出位置' },
    ]},
  ], desc: '上报投菜摇臂位置', cycle: 0 },
  { func: '0x0B02', name: '投菜结果上报', sender: '投菜板', receiver: '主控板', dataLen: 1, byteConfigs: [
    { name: '投菜结果', parseMode: 'enum', enumValues: [
      { value: '0x01', label: '1#菜盒投菜成功' }, { value: '0x02', label: '2#菜盒投菜成功' },
      { value: '0x03', label: '3#菜盒投菜成功' }, { value: '0x04', label: '4#菜盒投菜成功' },
      { value: '0x11', label: '1#菜盒投菜失败' }, { value: '0x12', label: '2#菜盒投菜失败' },
      { value: '0x13', label: '3#菜盒投菜失败' }, { value: '0x14', label: '4#菜盒投菜失败' },
    ]},
  ], desc: '投菜结果上报', cycle: 0 },
  { func: '0x1200', name: '调料泵送液位标定', sender: '主控板', receiver: '液料泵送板', dataLen: 1, byteConfigs: [
    { name: '高低液位', parseMode: 'enum', enumValues: [
      { value: '0x01', label: '低液位' }, { value: '0x02', label: '高液位' },
    ]},
  ], desc: '标定所有调料高低液位', cycle: 0 },
  { func: '0x1201', name: '配置波特率', sender: '主控板', receiver: '液料泵送板', dataLen: 2, byteConfigs: [
    { name: '波特率H', parseMode: 'raw' },
    { name: '波特率L', parseMode: 'raw' },
  ], desc: '调试阶段通过串口配置泵送板的波特率', cycle: 0 },
  { func: '0x1202', name: '调料称重系数校准', sender: '主控板', receiver: '液料泵送板', dataLen: 2, byteConfigs: [
    { name: '系数H', parseMode: 'raw' },
    { name: '系数L', parseMode: 'raw' },
  ], desc: '用于校准调料称重传感器系数', cycle: 0 },
  { func: '0x1203', name: '泵送板生产测试', sender: '主控板', receiver: '液料泵送板', dataLen: 0, byteConfigs: [], desc: '泵送板生产部件测试程序', cycle: 0 },
  { func: '0x1301', name: '投菜板生产测试', sender: '主控板', receiver: '投菜板', dataLen: 0, byteConfigs: [], desc: '投菜板生产测试', cycle: 0 },
];

const snapshotJson = JSON.stringify({
  protoName: PROTO_NAME,
  protoDesc: '智能炒菜机板间UART全双工通信协议',
  versionMajor: 0, versionMinor: 0, versionPatch: 1,
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
    db.prepare('INSERT INTO protocol_versions (protocol_name, version, config_json, created_by) VALUES (?, ?, ?, ?)')
      .run(PROTO_NAME, PROTO_VERSION, snapshotJson, 'system');
  } catch { /* ignore */ }

  return true;
}

module.exports = { insertDefaultProtocol, PROTO_NAME, PROTO_VERSION };
