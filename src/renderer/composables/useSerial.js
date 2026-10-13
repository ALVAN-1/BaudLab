/**
 * 串口通信 composable
 * 封装 Electron IPC 串口操作
 * 串口列表通过主进程 USB 设备事件驱动更新，非轮询
 */
import { ref, onMounted, onUnmounted } from 'vue';

const hasElectron = typeof window !== 'undefined' && typeof window.electronAPI !== 'undefined';

// 全局共享状态
const availablePorts = ref([]);
const dataCallbacks = [];
const errorCallbacks = [];
const portsChangedCallbacks = [];
const mcpOpenedCallbacks = [];
const mcpClosedCallbacks = [];
const mcpTxCallbacks = [];
let unsubPortsChanged = null;

// 初始化 IPC 监听（只执行一次）
let ipcInitialized = false;

function initIpc() {
  if (ipcInitialized || !hasElectron) return;
  ipcInitialized = true;

  window.electronAPI.serial.onData((data) => {
    dataCallbacks.forEach(cb => cb(data));
  });

  window.electronAPI.serial.onError((data) => {
    errorCallbacks.forEach(cb => cb(data));
  });

  /* MCP 串口活动镜像：外部 AI 客户端的打开/关闭/发送实时广播 */
  window.electronAPI.serial.onMcpOpened((data) => {
    mcpOpenedCallbacks.forEach(cb => cb(data));
  });
  window.electronAPI.serial.onMcpClosed((data) => {
    mcpClosedCallbacks.forEach(cb => cb(data));
  });
  window.electronAPI.serial.onMcpTx((data) => {
    mcpTxCallbacks.forEach(cb => cb(data));
  });

  /* 监听主进程推送的串口列表变化事件（USB 插拔触发） */
  unsubPortsChanged = window.electronAPI.serial.onPortsChanged((ports) => {
    availablePorts.value = (ports || []).map(p => p.path);
    portsChangedCallbacks.forEach(cb => cb(availablePorts.value));
  });
}

export function useSerial() {
  onMounted(() => {
    initIpc();
    refreshPorts();
  });

  onUnmounted(() => {
    /* 不取消订阅，因为全局共享 */
  });

  /**
   * 主动查询一次串口列表
   */
  async function refreshPorts() {
    if (!hasElectron) return;
    try {
      const ports = await window.electronAPI.serial.list();
      availablePorts.value = (ports || []).map(p => p.path);
    } catch (e) {
      console.warn('[Serial] 获取串口列表失败:', e);
      availablePorts.value = [];
    }
  }

  /**
   * 打开串口
   * @param {Object} options - { path, baudRate, dataBits, stopBits, parity }
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async function openPort(options) {
    if (!hasElectron) return { success: true };
    return await window.electronAPI.serial.open(options);
  }

  /**
   * 关闭串口
   * @param {string} portPath - 串口路径
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async function closePort(portPath) {
    if (!hasElectron) return { success: true };
    return await window.electronAPI.serial.close(portPath);
  }

  /**
   * 发送数据
   * @param {Object} options - { portPath, data, format }
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async function sendPort(options) {
    if (!hasElectron) return { success: true };
    return await window.electronAPI.serial.send(options);
  }

  /**
   * 注册数据接收回调
   * @param {Function} callback - (data) => void
   * @returns {Function} 取消注册函数
   */
  function onData(callback) {
    dataCallbacks.push(callback);
    return () => {
      const idx = dataCallbacks.indexOf(callback);
      if (idx >= 0) dataCallbacks.splice(idx, 1);
    };
  }

  /**
   * 注册错误回调
   * @param {Function} callback - (data) => void
   * @returns {Function} 取消注册函数
   */
  function onError(callback) {
    errorCallbacks.push(callback);
    return () => {
      const idx = errorCallbacks.indexOf(callback);
      if (idx >= 0) errorCallbacks.splice(idx, 1);
    };
  }

  /**
   * 注册端口变化回调
   * @param {Function} callback - (portPaths: string[]) => void
   * @returns {Function} 取消注册函数
   */
  function onPortsChanged(callback) {
    portsChangedCallbacks.push(callback);
    return () => {
      const idx = portsChangedCallbacks.indexOf(callback);
      if (idx >= 0) portsChangedCallbacks.splice(idx, 1);
    };
  }

  /**
   * 查询当前由 MCP（外部 AI 客户端）打开的串口列表
   * @returns {Promise<Array<{port, baudRate, dataBits, stopBits, parity}>>}
   */
  async function getMcpPorts() {
    if (!hasElectron) return [];
    try { return await window.electronAPI.serial.getMcpPorts() || []; }
    catch { return []; }
  }

  /** 注册 MCP 打开串口回调 */
  function onMcpOpened(callback) {
    mcpOpenedCallbacks.push(callback);
    return () => {
      const idx = mcpOpenedCallbacks.indexOf(callback);
      if (idx >= 0) mcpOpenedCallbacks.splice(idx, 1);
    };
  }

  /** 注册 MCP 关闭串口回调 */
  function onMcpClosed(callback) {
    mcpClosedCallbacks.push(callback);
    return () => {
      const idx = mcpClosedCallbacks.indexOf(callback);
      if (idx >= 0) mcpClosedCallbacks.splice(idx, 1);
    };
  }

  /** 注册 MCP 发送数据回调 */
  function onMcpTx(callback) {
    mcpTxCallbacks.push(callback);
    return () => {
      const idx = mcpTxCallbacks.indexOf(callback);
      if (idx >= 0) mcpTxCallbacks.splice(idx, 1);
    };
  }

  return {
    availablePorts,
    hasElectron,
    refreshPorts,
    openPort,
    closePort,
    sendPort,
    onData,
    onError,
    onPortsChanged,
    getMcpPorts,
    onMcpOpened,
    onMcpClosed,
    onMcpTx,
  };
}
