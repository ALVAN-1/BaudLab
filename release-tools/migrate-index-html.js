// index.html：私有 Gitee 渠道 → GitHub 渠道 + 版本 0.0.40 → 1.0.0
// 有序替换，每处校验命中数，防止静默漏改
// 存档说明：本脚本已於 2026-10-13 对官网 index.html 执行过一次（16 处替换全部命中）。
//           路径相对本脚本定位（上级目录的 index.html）。
//           后续版本迁移时可参照修改 edits 数组复用。
const fs = require('fs');
const path = require('path');
const htmlPath = path.join(__dirname, '..', 'index.html');
let html = fs.readFileSync(htmlPath, 'utf8');
const before = html.length;

const GITHUB_REPO = 'https://github.com/ALVAN-1/BaudLab.io';
const GITEE_BASE = 'https://gitee.com/ALVAN1819184/alvan-uart-tool-privacy';

const edits = [
  // ---- URL（先长后短，避免前缀互相吃掉）----
  [`${GITEE_BASE}/releases/download/latest/SerialProtocolManager-Setup-0.0.40.exe`, `${GITHUB_REPO}/releases/latest`, 2],
  [`${GITEE_BASE}/releases`, `${GITHUB_REPO}/releases`, 2],
  [`${GITEE_BASE}/issues`, `${GITHUB_REPO}/issues`, 2],
  [`${GITEE_BASE}"`, `${GITHUB_REPO}"`, 1],
  // ---- 文件名 ----
  ['SerialProtocolManager-Setup-0.0.40.exe', 'SerialProtocolManager-Setup-1.0.0.exe', 2],
  // ---- 版本与日期 ----
  ['v0.0.40', 'v1.0.0', 8],
  ['2025-09-29', '2026-10-13', 2],
  // ---- 文案 ----
  ['Gitee Issue 反馈', 'GitHub Issue 反馈', 1],
  ['下载将跳转至 Gitee Releases 页面', '下载将跳转至 GitHub Releases 页面', 1],
  ['Gitee 仓库 docs 目录', 'GitHub 仓库 docs 目录', 1],
  ['<h4>Gitee Issues</h4>', '<h4>GitHub Issues</h4>', 1],
  ['>Gitee Issues</a>', '>GitHub Issues</a>', 1],
  ['Gitee Releases 获取', 'GitHub Releases 获取', 1],
  ['aria-label="Gitee 仓库"', 'aria-label="GitHub 仓库"', 1],
  // ---- 图标：两处 use 引用 + sprite 符号定义 ----
  ['#i-gitee', '#i-github', 2],
];

// sprite 符号：stroke 系 i-gitee → fill 系 GitHub 官方标
const giteeSymbol = '<symbol id="i-gitee" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4.5 L13.5 4.5 C14.6 4.5 15.5 5.4 15.5 6.5 L15.5 20 L7.5 17.2 L4.5 20 Z"/><path d="M15.5 8 L19 8 C20.1 8 21 8.9 21 10 L21 18.5 L15.5 20.8"/></symbol>';
const githubSymbol = '<symbol id="i-github" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></symbol>';
edits.push([giteeSymbol, githubSymbol, 1]);

let failed = 0;
for (const [from, to, expected] of edits) {
  const count = html.split(from).length - 1;
  if (count !== expected) {
    console.error(`MISMATCH expected=${expected} got=${count} :: ${from.slice(0, 70)}`);
    failed++;
    continue;
  }
  html = html.split(from).join(to);
  console.log(`ok (${count}x) ${from.slice(0, 60)}`);
}
if (failed) {
  console.error('ABORTED: ' + failed + ' pattern(s) mismatched, file not written');
  process.exit(1);
}
fs.writeFileSync(htmlPath, html);

// ---- 写后校验 ----
const after = fs.readFileSync(htmlPath, 'utf8');
const leftovers = [];
if (/gitee/i.test(after)) leftovers.push('gitee');
if (after.includes('0.0.40')) leftovers.push('0.0.40');
if (after.includes('2025-09-29')) leftovers.push('2025-09-29');
if (leftovers.length) { console.error('LEFTOVER:', leftovers.join(', ')); process.exit(1); }
console.log('---');
console.log('written OK, size', before, '->', after.length);
console.log('github refs:', (after.match(/github\.com\/ALVAN-1\/BaudLab\.io/g) || []).length);
console.log('v1.0.0 refs:', (after.match(/v1\.0\.0/g) || []).length);
console.log('leftover check: clean');
