import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'path';
import { renameSync, existsSync } from 'fs';

// 入口产物重命名插件：
// 本仓库根目录的 index.html 是官网 Pages 页面（GitHub Pages 直接 serve 根 index.html），
// 应用的 Vite 入口因此单独命名为 dev.index.html；但 main.js 加载的是 dist/renderer/index.html，
// 故构建完成后把产出的 dev.index.html 重命名回 index.html，
// 保持运行（loadFile）、electron-builder 打包、启动脚本检查逻辑与原项目完全一致。
function renameEntryHtml() {
  return {
    name: 'rename-entry-html',
    writeBundle() {
      const out = resolve(__dirname, 'dist/renderer/dev.index.html');
      const target = resolve(__dirname, 'dist/renderer/index.html');
      if (existsSync(out)) renameSync(out, target);
    },
  };
}

// Vite 配置：Electron 渲染进程构建
// dev 模式提供 HMR，build 模式产出到 dist/renderer
export default defineConfig({
  plugins: [vue(), renameEntryHtml()],
  root: '.',
  base: './',
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    rollupOptions: {
      // 入口为 dev.index.html：根目录的 index.html 是官网 Pages 页面，与应用 Vite 入口同名不同内容，
      // 故应用入口单独命名，避免覆盖官网页面（产物由 renameEntryHtml 插件重命名回 index.html）
      input: resolve(__dirname, 'dev.index.html'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
