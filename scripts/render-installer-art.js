// ============================================================
//  安装包素材渲染脚本
//  用法: npx electron scripts/render-installer-art.js
//  将 build/*.svg 渲染为 NSIS 需要的标准 BMP:
//    welcome.bmp  164x314  安装/卸载向导侧栏
//    header.bmp   580x60   安装向导顶部横幅
//  版本号从 package.json 读取，SVG 中的 v1.0.0 为占位符。
// ============================================================
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const version = pkg.version;

const jobs = [
  { svg: 'build/welcome.svg', out: 'build/welcome.bmp', w: 164, h: 314 },
  { svg: 'build/header.svg', out: 'build/header.bmp', w: 580, h: 60 },
];

// 写出未压缩 24bpp BMP（NSIS/electron-builder 要求）
function writeBmp24(file, w, h, rgba) {
  const rowSize = Math.ceil((24 * w) / 32) * 4;
  const pixelSize = rowSize * h;
  const buf = Buffer.alloc(14 + 40 + pixelSize);
  buf.write('BM', 0);
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(h, 22); // 正数 = 自底向上存储
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(pixelSize, 34);
  for (let y = 0; y < h; y++) {
    const srcY = h - 1 - y; // canvas 是自顶向下，BMP 自底向上
    for (let x = 0; x < w; x++) {
      const s = (srcY * w + x) * 4;
      const d = 54 + y * rowSize + x * 3;
      buf[d] = rgba[s + 2]; // B
      buf[d + 1] = rgba[s + 1]; // G
      buf[d + 2] = rgba[s]; // R
    }
  }
  fs.writeFileSync(file, buf);
  console.log(`[ok] ${path.relative(root, file)}  ${w}x${h}  ${(buf.length / 1024).toFixed(1)}KB`);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  for (const job of jobs) {
    const svgPath = path.join(root, job.svg);
    let svg = fs.readFileSync(svgPath, 'utf8');
    // SVG 中的占位版本号替换为真实版本
    svg = svg.replace(/v\d+\.\d+\.\d+/, 'v' + version);
    const svgUrl = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');

    const win = new BrowserWindow({
      width: job.w + 20,
      height: job.h + 20,
      show: false,
      frame: false,
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });

    const html = `<!doctype html><html><body style="margin:0;overflow:hidden">
      <canvas id="c" width="${job.w}" height="${job.h}"></canvas>
      <script>
        const img = new Image();
        img.onload = () => {
          const ctx = document.getElementById('c').getContext('2d');
          ctx.drawImage(img, 0, 0, ${job.w}, ${job.h});
          const d = ctx.getImageData(0, 0, ${job.w}, ${job.h}).data;
          require('electron').ipcRenderer.send('bmp-done', {
            out: ${JSON.stringify(job.out)},
            w: ${job.w}, h: ${job.h},
            rgba: Array.from(d),
          });
        };
        img.onerror = () => require('electron').ipcRenderer.send('bmp-error', ${JSON.stringify(job.svg)});
        img.src = ${JSON.stringify(svgUrl)};
      </script></body></html>`;

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${job.svg} 渲染超时`)), 15000);
      const onData = (_e, payload) => {
        clearTimeout(timer);
        if (payload.rgba) {
          writeBmp24(path.join(root, payload.out), payload.w, payload.h, Buffer.from(payload.rgba));
        } else {
          reject(new Error(`${payload} 加载失败`));
        }
        resolve();
      };
      ipcMain.once('bmp-done', onData);
      ipcMain.once('bmp-error', onData);
      win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    });
  }
  app.quit();
});
