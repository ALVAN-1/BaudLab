/**
 * 手动打包脚本：复制 Electron 运行时 + 项目文件 + 生产依赖到 dist\win-unpacked
 * 跳过 electron-builder 的网络下载步骤
 */
const fs = require('fs');
const path = require('path');

const projectRoot = __dirname;
const electronDist = path.join(projectRoot, 'node_modules', 'electron', 'dist');
const outDir = path.join(projectRoot, 'dist', 'win-unpacked');

/* 需要复制的生产依赖（含 native 模块） */
const prodDeps = [
  'serialport',
  '@serialport',
  'better-sqlite3',
  'bindings',
  'file-uri-to-path',
  'prebuild-install',
  'node-addon-api',
  'node-gyp-build',
];

/* 递归复制目录 */
function copyDir(src, dest) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/* 主流程 */
function pack() {
  console.log('[1/4] 清理旧的打包目录...');
  if (fs.existsSync(outDir)) {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  fs.mkdirSync(outDir, { recursive: true });

  console.log('[2/4] 复制 Electron 运行时...');
  copyDir(electronDist, outDir);
  /* 重命名 electron.exe 为应用名 */
  const oldExe = path.join(outDir, 'electron.exe');
  const newExe = path.join(outDir, 'SerialProtocolManager.exe');
  if (fs.existsSync(oldExe)) {
    fs.renameSync(oldExe, newExe);
  }

  console.log('[3/4] 复制项目文件...');
  fs.copyFileSync(path.join(projectRoot, 'main.js'), path.join(outDir, 'main.js'));
  fs.copyFileSync(path.join(projectRoot, 'preload.js'), path.join(outDir, 'preload.js'));
  copyDir(path.join(projectRoot, 'dist', 'renderer'), path.join(outDir, 'dist', 'renderer'));
  copyDir(path.join(projectRoot, 'assets'), path.join(outDir, 'assets'));

  console.log('[4/4] 复制生产依赖 (node_modules)...');
  const nmOut = path.join(outDir, 'node_modules');
  fs.mkdirSync(nmOut, { recursive: true });
  for (const dep of prodDeps) {
    const src = path.join(projectRoot, 'node_modules', dep);
    const dest = path.join(nmOut, dep);
    if (fs.existsSync(src)) {
      copyDir(src, dest);
      console.log('  + ' + dep);
    } else {
      console.log('  - ' + dep + ' (未找到，跳过)');
    }
  }

  console.log('\n打包完成！输出目录: ' + outDir);
  console.log('可执行文件: ' + newExe);
}

pack();
