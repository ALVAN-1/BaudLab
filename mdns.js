'use strict';

/**
 * 局域网零配置发现（mDNS / DNS-SD）
 *
 * 作用：成员不再手抄「http://192.168.1.100:3010」，而是自动在局域网里
 * 发现已开启的团队服务器并一键填入地址。
 *
 *   - 广播：内嵌服务器启动后以 `_baudlab._tcp.local` 发布自身（名称/端口/版本）；
 *   - 浏览：客户端在「数据库连接」页浏览同一服务类型，实时列出发现的服务器。
 *
 * 依赖 bonjour-service（纯 JS，无原生模块）。Windows 首次使用可能在防火墙
 * 提示中放行；广播失败不影响服务器本身，只是发现不出来（仍可手填地址）。
 */
const os = require('os');
const { Bonjour } = require('bonjour-service');

const SERVICE_TYPE = 'baudlab';

/**
 * @param {object} [deps]
 * @param {(list:Array)=>void} [deps.onUpdate] 发现列表变化回调
 * @param {(msg:string)=>void} [deps.onLog]
 */
function createDiscovery(deps = {}) {
  const onUpdate = deps.onUpdate || (() => {});
  const onLog = deps.onLog || (() => {});

  let bonjour = null;
  let published = null;
  let browser = null;
  const found = new Map(); // key -> bonjour service

  function ensureBonjour() {
    if (!bonjour) {
      bonjour = new Bonjour();
      bonjour.on?.('error', (e) => onLog(`[mdns] ${e.message}`));
    }
    return bonjour;
  }

  function keyOf(s) { return s.fqdn || `${s.name}:${s.port}`; }

  function snapshot() {
    return [...found.values()]
      .map((s) => {
        const addresses = Array.isArray(s.addresses) ? s.addresses : [];
        const ipv4 = addresses.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
        return {
          name: s.name,
          host: s.host,
          port: s.port,
          addresses,
          txt: s.txt || {},
          url: `http://${ipv4 || s.host}:${s.port}`,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** 发布本机团队服务器 */
  function advertise(info = {}) {
    const b = ensureBonjour();
    stopAdvertise();
    const hostname = os.hostname();
    try {
      published = b.publish({
        name: info.name || `BaudLab · ${hostname}`,
        type: SERVICE_TYPE,
        port: info.port,
        txt: {
          v: String(info.version || ''),
          host: hostname,
          needToken: info.needToken ? '1' : '0',
        },
      });
      published.on?.('error', (e) => onLog(`[mdns] 广播失败: ${e.message}`));
      onLog(`[mdns] 已在局域网广播服务 ${published.name || info.name} :${info.port}`);
    } catch (e) {
      onLog(`[mdns] 广播异常: ${e.message}`);
    }
  }

  function stopAdvertise() {
    if (published) {
      try { published.stop(); } catch { /* 忽略 */ }
      published = null;
    }
  }

  /** 开始浏览局域网内的团队服务器 */
  function startBrowse() {
    if (browser) return;
    const b = ensureBonjour();
    browser = b.find({ type: SERVICE_TYPE });
    browser.on('up', (s) => { found.set(keyOf(s), s); onUpdate(snapshot()); });
    browser.on('down', (s) => { found.delete(keyOf(s)); onUpdate(snapshot()); });
    browser.on('error', (e) => onLog(`[mdns] 浏览失败: ${e.message}`));
  }

  function stopBrowse() {
    if (browser) {
      try { browser.stop(); } catch { /* 忽略 */ }
      browser = null;
    }
    found.clear();
    onUpdate(snapshot());
  }

  function destroy() {
    stopAdvertise();
    stopBrowse();
    if (bonjour) {
      try { bonjour.destroy(); } catch { /* 忽略 */ }
      bonjour = null;
    }
  }

  return {
    advertise,
    stopAdvertise,
    startBrowse,
    stopBrowse,
    list: snapshot,
    destroy,
  };
}

module.exports = { createDiscovery, SERVICE_TYPE };
