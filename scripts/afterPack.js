const fs = require('fs');
const path = require('path');

// 打包后处理：
// 1) 裁剪非必需文件，减小安装体积
//    - LICENSES.chromium.html / LICENSE.electron.txt: 许可文本（内部工具分发，约 9MB）
//    - 非 zh-CN 语言包：界面仅中文
//    注意（已实测验证，勿删运行时 DLL）:
//      - ffmpeg.dll: Electron 子进程（renderer/gpu/utility）启动时加载，删除→子进程无法创建→应用卡死
//      - vk_swiftshader.dll / vulkan-1.dll: 删除后 renderer 进程消失（沙箱测试中未再出现），
//        风险不对称，保留。Electron 体积地板 ≈ 70MB 安装包 / 225MB 安装后，无法再小
// 2) 拷贝 MCP 独立服务运行时文件到 resources/mcp/
//    打包后 main.js 通过 process.resourcesPath/mcp/mcp-server.js 以 node 启动 MCP 服务，
//    其 require 闭包为 mcp-server.js → ai-tools.js / mcp-bridge.js → frame-codec.js，
//    外加 package.json，共 5 个文件，必须与 mcp-server.js 同级。
//    历史说明：原先用 electron-builder 的 extraResources（from: "." + filter）完成此拷贝，
//    但 app-builder-lib 会把 extraResources 的 filter 模式同时当作 asar 的排除模式
//    （platformPackager.js 中 computeParsedPatterns(excludePatterns) → matcher.excludePatterns），
//    导致 package.json / ai-tools.js / mcp-bridge.js / frame-codec.js 无法进入 app.asar：
//    一方面 sanityCheckPackage 校验 asar 内 package.json 失败，
//    另一方面 main.js 的 require('./mcp-bridge') 运行时崩溃。
//    因此 extraResources 块已从 package.json 移除，改在此处手动拷贝。
module.exports = async function (context) {
  const appDir = context.appOutDir;
  const projectDir = path.resolve(__dirname, '..');
  const removed = [];
  for (const f of ['LICENSES.chromium.html', 'LICENSE.electron.txt']) {
    const p = path.join(appDir, f);
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      removed.push(f);
    }
  }
  const localesDir = path.join(appDir, 'locales');
  if (fs.existsSync(localesDir)) {
    for (const f of fs.readdirSync(localesDir)) {
      if (f !== 'zh-CN.pak') {
        fs.unlinkSync(path.join(localesDir, f));
        removed.push('locales/' + f);
      }
    }
  }
  const mcpFiles = ['mcp-server.js', 'ai-tools.js', 'mcp-bridge.js', 'frame-codec.js', 'package.json'];
  const mcpDir = path.join(appDir, 'resources', 'mcp');
  fs.mkdirSync(mcpDir, { recursive: true });
  const copied = [];
  for (const f of mcpFiles) {
    const src = path.join(projectDir, f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(mcpDir, f));
      copied.push('mcp/' + f);
    }
  }
  console.log('[afterPack] 裁剪完成:', removed.join(', '));
  console.log('[afterPack] MCP 文件拷贝完成:', copied.join(', '));
};
