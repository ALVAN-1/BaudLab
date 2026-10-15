// 临时预览脚本: 直接用 Chromium 打开 BMP 并截图为 PNG 供人工检查
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const files = process.argv.slice(2).length ? process.argv.slice(2) : ['build/welcome.bmp', 'build/header.bmp'];

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  for (const f of files) {
    const win = new BrowserWindow({ width: 700, height: 400, show: false, frame: false });
    await win.loadFile(path.join(root, f));
    await new Promise(r => setTimeout(r, 200));
    const img = await win.webContents.capturePage();
    const out = f.replace('.bmp', '-preview.png');
    fs.writeFileSync(path.join(root, out), img.toPNG());
    console.log('[ok]', out);
    win.destroy();
  }
  app.quit();
});
