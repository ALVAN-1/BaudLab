/**
 * 协议定义与工具函数
 * 注：实际协议数据优先从数据库加载，此处为内置默认协议（无 Electron 环境时使用）
 */

/* ==================== 工具函数 ==================== */

/**
 * CRC16-MODBUS 校验
 * @param {number[]} bytes - 字节数组
 * @returns {number[]} [低字节, 高字节]
 */
export function crc16(bytes) {
  let crc = 0xFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] & 0xFF;
    for (let j = 0; j < 8; j++) {
      if (crc & 0x0001) {
        crc = (crc >> 1) ^ 0xA001;
      } else {
        crc >>= 1;
      }
    }
  }
  const low = crc & 0xFF;
  const high = (crc >> 8) & 0xFF;
  return [low, high];
}

/**
 * 累加和校验
 * @param {number[]} bytes - 字节数组
 * @returns {number[]} [单字节校验值]
 */
export function sumCheck(bytes) {
  let sum = 0;
  for (let i = 0; i < bytes.length; i++) {
    sum = (sum + bytes[i]) & 0xFF;
  }
  return [sum];
}

/**
 * 格式化时间为 HH:MM:SS.mmm
 * @param {Date} date
 * @returns {string}
 */
export function formatTime(date) {
  const h = date.getHours().toString().padStart(2, '0');
  const m = date.getMinutes().toString().padStart(2, '0');
  const s = date.getSeconds().toString().padStart(2, '0');
  const ms = date.getMilliseconds().toString().padStart(3, '0');
  return `${h}:${m}:${s}.${ms}`;
}

/**
 * 获取字节标签（大端序：高字节在前）
 * @param {number} fieldLength - 字段总字节数
 * @param {number} byteIndex - 当前字节索引
 * @returns {string}
 */
export function getByteLabel(fieldLength, byteIndex) {
  if (fieldLength <= 1) return 'Byte';
  const highBit = (fieldLength - byteIndex - 1) * 8 + 7;
  const lowBit = (fieldLength - byteIndex - 1) * 8;
  return `bit${highBit}~${lowBit}`;
}

/* ==================== 内置默认协议 ==================== */

export const protocolDefinitions = {
  'Modbus-RTU': {
    frameHeader: [],
    frameTail: [],
    checkType: 'CRC16',
    address: 0x01,
    cmdLen: 1,
    cmds: [
      {
        cmd: 0x03,
        name: '读保持寄存器',
        fields: [
          { name: '起始地址', length: 2, type: 'number' },
          { name: '寄存器数量', length: 2, type: 'number' },
        ],
      },
      {
        cmd: 0x06,
        name: '写单个寄存器',
        fields: [
          { name: '寄存器地址', length: 2, type: 'number' },
          { name: '写入值', length: 2, type: 'number' },
        ],
      },
      {
        cmd: 0x10,
        name: '写多个寄存器',
        fields: [
          { name: '起始地址', length: 2, type: 'number' },
          { name: '寄存器数量', length: 2, type: 'number' },
          { name: '字节数', length: 1, type: 'number' },
        ],
      },
    ],
  },
  '自定义协议': {
    frameHeader: [0xAA, 0x55],
    frameTail: [0x0D, 0x0A],
    checkType: 'SUM',
    address: 0x01,
    cmdLen: 1,
    cmds: [
      {
        cmd: 0x01,
        name: '查询状态',
        fields: [
          { name: '数据长度', length: 1, type: 'number' },
        ],
      },
      {
        cmd: 0x02,
        name: '控制命令',
        fields: [
          { name: '控制字', length: 1, type: 'enum', options: [
            { label: '启动', value: 0x01 },
            { label: '停止', value: 0x02 },
            { label: '复位', value: 0x03 },
          ]},
          { name: '参数', length: 2, type: 'number' },
        ],
      },
    ],
  },
};
