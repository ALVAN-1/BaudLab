'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const yaml = require('js-yaml');
const asar = require('@electron/asar');

function verify(directory, version, owner, repo, prefix) {
  const assert = (value, text) => { if (!value) throw new Error(text); };
  const exe = `${prefix}-Setup-${version}.exe`;
  const filename = path.join(directory, exe);
  assert(fs.existsSync(filename), `缺少安装包 ${exe}`);
  const metadata = yaml.load(fs.readFileSync(path.join(directory, 'latest.yml'), 'utf8'));
  assert(metadata.version === version, 'latest.yml 版本不匹配');
  assert(metadata.path === exe, 'latest.yml path 不匹配');
  const entry = metadata.files?.find(file => file.url === exe);
  assert(entry, 'latest.yml 缺少安装包 files 条目');
  const bytes = fs.readFileSync(filename);
  const sha512 = crypto.createHash('sha512').update(bytes).digest('base64');
  assert(entry.sha512 === sha512 && metadata.sha512 === sha512, '安装包 SHA512 不匹配');
  assert(entry.size == null || entry.size === bytes.length, '安装包 size 不匹配');
  assert(bytes[0] === 0x4d && bytes[1] === 0x5a, '安装包不是 Windows PE 文件');
  const resources = path.join(directory, 'win-unpacked', 'resources');
  const feed = yaml.load(fs.readFileSync(path.join(resources, 'app-update.yml'), 'utf8'));
  assert(feed.provider === 'github' && feed.owner === owner && feed.repo === repo, '安装包内更新源不是目标 GitHub 仓库');
  const archive = path.join(resources, 'app.asar');
  const pkg = JSON.parse(asar.extractFile(archive, 'package.json').toString());
  assert(pkg.version === version && pkg.name === 'serial-protocol-manager', 'asar 版本或安装身份不匹配');
  for (const name of ['main.js', 'preload.js', 'update-controller.js', 'db-schema.js', 'default-protocol-data.js', 'dist/renderer/index.html']) {
    assert(asar.extractFile(archive, name).length > 0, `asar 缺少 ${name}`);
  }
  for (const name of ['mcp-server.js', 'ai-tools.js', 'mcp-bridge.js', 'frame-codec.js', 'package.json']) {
    assert(fs.existsSync(path.join(resources, 'mcp', name)), `MCP 缺少 ${name}`);
  }
  console.log(`校验通过: ${exe} / latest.yml / app-update.yml / asar / MCP`);
}

if (require.main === module) {
  try { verify(...process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { verify };
