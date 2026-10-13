#!/usr/bin/env node
/* 启动脚本 TUI — 构建 Vue + 启动 Electron */

const { execSync, spawn } = require('child_process');
const path = require('path');

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red:    '\x1b[38;2;239;68;68m',
  green:  '\x1b[38;2;34;197;94m',
  yellow: '\x1b[38;2;245;158;11m',
  blue:   '\x1b[38;2;59;130;246m',
  purple: '\x1b[38;2;139;92;246m',
  cyan:   '\x1b[38;2;6;182;212m',
  gray:   '\x1b[38;2;107;114;128m',
  bgPurple: '\x1b[48;2;76;65;162m',
};
const W = '═', HW = '─';

function stripAnsi(s) { return typeof s === 'string' ? s.replace(/\x1b\[[0-9;]*m/g, '') : String(s); }
function pad(str, width) { const len = [...stripAnsi(str)].length; return str + ' '.repeat(Math.max(0, width - len)); }
function center(str, width) { const len = [...stripAnsi(str)].length; return ' '.repeat(Math.max(0, Math.floor((width - len) / 2))) + str; }

// ── 横幅 ──
function banner() {
  const lines = [
    '',
    `${C.bgPurple}${C.bold}  ${' '.repeat(44)}  ${C.reset}`,
    `${C.bgPurple}${C.bold}  ${center('串口协议管理工具', 44)}  ${C.reset}`,
    `${C.bgPurple}${C.bold}  ${' '.repeat(44)}  ${C.reset}`,
    '',
  ];
  lines.forEach(l => console.log(l));
}

// ── 步骤面板 ──
function stepPanel(title) {
  console.log(`\n${C.gray}┌${HW.repeat(50)}┐${C.reset}`);
  console.log(`${C.gray}│${C.reset} ${C.bold}${C.cyan}${title}${C.reset}`);
  console.log(`${C.gray}└${HW.repeat(50)}┘${C.reset}`);
}

function ok(msg)   { console.log(`  ${C.green}✓${C.reset} ${msg}`); }
function info(msg) { console.log(`  ${C.cyan}›${C.reset} ${C.gray}${msg}${C.reset}`); }
function warn(msg) { console.log(`  ${C.yellow}!${C.reset} ${C.yellow}${msg}${C.reset}`); }
function fail(msg) { console.log(`  ${C.red}✗${C.reset} ${C.red}${msg}${C.reset}`); }

// ── TUI 预览：node start.js --preview ──
if (process.argv.includes('--preview')) {
  banner();
  stepPanel('1/2  构建 Vue 应用');
  ok('构建完成 (30 modules, 325ms)');
  info('dist/renderer/index.html  0.70 kB');
  info('dist/renderer/assets/index.js  253 kB');
  stepPanel('2/2  启动 Electron 应用');
  info('启动中...');
  const innerW = 50;
  console.log(`\n${C.green}╔${W.repeat(innerW)}╗${C.reset}`);
  console.log(`${C.green}║${C.reset}${center(C.bold + '✅ 应用已启动' + C.reset, innerW)}${C.green}║${C.reset}`);
  console.log(`${C.green}╟${HW.repeat(innerW)}╢${C.reset}`);
  console.log(`${C.green}║${C.reset} 关闭 Electron 窗口即停止应用${' '.repeat(18)}${C.green}║${C.reset}`);
  console.log(`${C.green}╚${W.repeat(innerW)}╝${C.reset}\n`);
  process.exit(0);
}

// ── 启动 ──
async function main() {
  banner();

  const projectDir = __dirname;

  // Step 1: 构建
  stepPanel('1/2  构建 Vue 应用');
  info('执行 vite build ...');
  try {
    execSync('npx vite build', { cwd: projectDir, stdio: 'pipe' });
    ok('构建完成');
  } catch (e) {
    // 构建失败时重新执行显示错误输出
    try { execSync('npx vite build', { cwd: projectDir, stdio: 'inherit' }); }
    catch (e2) {
      fail('构建失败，请检查上方错误信息');
      const innerW = 50;
      console.log(`\n${C.red}╔${W.repeat(innerW)}╗${C.reset}`);
      console.log(`${C.red}║${C.reset}${center(C.bold + '❌ 构建失败' + C.reset, innerW)}${C.red}║${C.reset}`);
      console.log(`${C.red}╟${HW.repeat(innerW)}╢${C.reset}`);
      console.log(`${C.red}║${C.reset} 请检查错误信息，修复后重新运行${' '.repeat(22)}${C.red}║${C.reset}`);
      console.log(`${C.red}╚${W.repeat(innerW)}╝${C.reset}\n`);
      process.exit(1);
    }
  }

  // Step 2: 启动 Electron
  stepPanel('2/2  启动 Electron 应用');
  info('启动中...');

  /* 透传额外启动参数（如 --instance=名称 启用多实例隔离） */
  const extraArgs = process.argv.slice(2);
  const child = spawn('npx', ['electron', '.', ...extraArgs], {
    cwd: projectDir,
    stdio: 'inherit',
    shell: true,
  });

  // 启动成功提示
  setTimeout(() => {
    const innerW = 50;
    console.log(`\n${C.green}╔${W.repeat(innerW)}╗${C.reset}`);
    console.log(`${C.green}║${C.reset}${center(C.bold + '✅ 应用已启动' + C.reset, innerW)}${C.green}║${C.reset}`);
    console.log(`${C.green}╟${HW.repeat(innerW)}╢${C.reset}`);
    console.log(`${C.green}║${C.reset} 关闭 Electron 窗口即停止应用${' '.repeat(18)}${C.green}║${C.reset}`);
    console.log(`${C.green}╚${W.repeat(innerW)}╝${C.reset}\n`);
  }, 2000);

  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      warn(`Electron 退出，代码: ${code}`);
    }
    process.exit(code || 0);
  });
}

main();
