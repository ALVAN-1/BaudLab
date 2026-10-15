#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  orange: '\x1b[38;5;208m',
  amber: '\x1b[38;5;214m',
  gold: '\x1b[38;5;220m',
  white: '\x1b[38;5;255m',
  gray: '\x1b[38;5;248m',
  darkGray: '\x1b[38;5;240m',
  green: '\x1b[38;5;34m',
  red: '\x1b[38;5;196m',
  cyan: '\x1b[38;5;39m',
  bgDark: '\x1b[48;5;236m',
};

const BANNER = `
${C.orange}${C.bold}  ███████╗███████╗██████╗ ██╗██████╗     ██████╗ ██╗  ██╗██████╗  ██████╗ ██╗    ██╗ ██████╗ ${C.reset}
${C.orange}${C.bold}  ██╔════╝██╔════╝██╔══██╗██║██╔══██╗    ██╔══██╗██║  ██║██╔══██╗██╔═══██╗██║    ██║██╔═══██╗${C.reset}
${C.orange}${C.bold}  ███████╗█████╗  ██████╔╝██║██████╔╝    ██║  ██║███████║██████╔╝██║   ██║██║ █╗ ██║██║   ██║${C.reset}
${C.orange}${C.bold}  ╚════██║██╔══╝  ██╔══██╗██║██╔══██╗    ██║  ██║██╔══██║██╔══██╗██║   ██║██║███╗██║██║   ██║${C.reset}
${C.orange}${C.bold}  ███████║███████╗██║  ██║██║██║  ██║    ██████╔╝██║  ██║██████╔╝╚██████╔╝╚███╔███╔╝╚██████╔╝${C.reset}
${C.orange}${C.bold}  ╚══════╝╚══════╝╚═╝  ╚═╝╚═╝╚═╝  ╚═╝    ╚═════╝ ╚═╝  ╚═╝╚═════╝  ╚═════╝  ╚══╝╚══╝  ╚═════╝ ${C.reset}
${C.darkGray}                                                                            ${C.reset}
${C.gray}  ╔══════════════════════════════════════════════════════════════════════════╗${C.reset}
${C.gray}  ║${C.reset}  ${C.white}${C.bold}BaudLab${C.reset}${C.gray} ${C.darkGray}v%s${C.reset}${C.gray}  ${C.darkGray}· %s${C.reset}${C.gray}                                              ║${C.reset}
${C.gray}  ║${C.reset}  ${C.gold}串口协议管理工具${C.reset}${C.gray}                                                              ║${C.reset}
${C.gray}  ╚══════════════════════════════════════════════════════════════════════════╝${C.reset}
`;

const MODES = {
  start: {
    title: '应用启动',
    desc: '启动 Electron 桌面客户端',
    actions: [
      ['启动模式', '开发环境 (dev)'],
      ['入口文件', 'start.js → main.js'],
    ],
  },
  release: {
    title: '发布工具',
    desc: '构建打包 → 版本管理 → 上传发布',
    actions: [
      ['构建工具', 'Vite + electron-builder'],
      ['更新源', '团队服务器 /updates/'],
    ],
  },
  server: {
    title: '团队数据服务器',
    desc: 'SQLite 协议数据库 + 远程同步 + 更新文件托管',
    actions: [
      ['监听端口', '3010'],
      ['数据库', 'server-data/serial_protocol.db'],
      ['更新目录', 'updates/'],
    ],
  },
};

function printBanner(modeName) {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')
  );
  const version = pkg.version || '0.0.0';
  const now = new Date().toISOString().slice(0, 10);
  const mode = MODES[modeName] || MODES.start;

  process.stdout.write('\n');

  const banner = BANNER.replace('%s', version).replace('%s', now);
  process.stdout.write(banner);
  process.stdout.write('\n');

  process.stdout.write(
    `  ${C.darkGray}┌─────────────────────────────────────────────────────────────────┐${C.reset}\n`
  );
  process.stdout.write(
    `  ${C.darkGray}│${C.reset}  ${C.amber}${C.bold}▸ ${mode.title}${C.reset}${C.gray}  ${mode.desc}${C.reset}\n`
  );
  process.stdout.write(`  ${C.darkGray}│${C.reset}\n`);
  for (const [label, value] of mode.actions) {
    process.stdout.write(
      `  ${C.darkGray}│${C.reset}  ${C.gray}${label.padEnd(8)}${C.reset}  ${C.darkGray}→${C.reset}  ${C.white}${value}${C.reset}\n`
    );
  }
  process.stdout.write(
    `  ${C.darkGray}└─────────────────────────────────────────────────────────────────┘${C.reset}\n`
  );
  process.stdout.write('\n');

  if (modeName === 'start') {
    process.stdout.write(`  ${C.green}●${C.reset} ${C.gray}正在启动...${C.reset}\n\n`);
  } else if (modeName === 'server') {
    process.stdout.write(`  ${C.green}●${C.reset} ${C.gray}正在启动服务器...${C.reset}\n\n`);
  } else if (modeName === 'release') {
    process.stdout.write(`  ${C.amber}●${C.reset} ${C.gray}发布工具已就绪${C.reset}\n\n`);
  }
}

const mode = process.argv[2] || 'start';
printBanner(mode);
