'use strict';
/* update-controller 状态机回归测试。不依赖 Electron：用假 app / 假 updater 驱动。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createUpdateController, normalizeNotes } = require('../update-controller');

function makeUpdater() {
  const handlers = new Map();
  return {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    allowDowngrade: true,
    installed: [],
    on(event, handler) { handlers.set(event, handler); },
    emit(event, data) { const handler = handlers.get(event); if (handler) handler(data); },
    async checkForUpdates() { return this.checkResult; },
    async downloadUpdate() { await this.onDownload?.(); },
    quitAndInstall(...args) { this.installed.push(args); },
  };
}

function makeApp(isPackaged = true, version = '1.0.0') {
  return { isPackaged, getVersion: () => version };
}

function makeController({ isPackaged = true, version = '1.0.0' } = {}) {
  const app = makeApp(isPackaged, version);
  const updater = makeUpdater();
  const events = [];
  const install = { prepared: 0, restored: 0 };
  const controller = createUpdateController({
    app, updater,
    send: (channel, data) => events.push({ channel, data }),
    prepareInstall: () => { install.prepared += 1; },
    restoreInstall: () => { install.restored += 1; },
  });
  return { app, updater, events, install, controller };
}

test('normalizeNotes joins array notes and stringifies plain text', () => {
  assert.equal(normalizeNotes([{ note: 'a' }, { note: 'b' }]), 'a\n\nb');
  assert.equal(normalizeNotes([{ note: 'only' }]), 'only');
  assert.equal(normalizeNotes('plain'), 'plain');
  assert.equal(normalizeNotes(undefined), '');
});

test('configures updater to never auto-download and to install on quit', () => {
  const { updater } = makeController();
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, true);
  assert.equal(updater.allowDowngrade, false);
});

test('development mode returns devMode and does not touch the updater', async () => {
  const { controller, updater } = makeController({ isPackaged: false });
  updater.checkResult = { isUpdateAvailable: true, updateInfo: { version: '9.9.9' } };
  const result = await controller.check();
  assert.deepEqual(result, { success: false, devMode: true });
});

test('reports an available update and exposes joined release notes', async () => {
  const { controller, updater, events } = makeController({ version: '1.0.0' });
  updater.checkResult = {
    isUpdateAvailable: true,
    updateInfo: { version: '1.1.0', releaseNotes: [{ note: 'fix' }, { note: 'feat' }] },
  };
  const result = await controller.check();
  assert.equal(result.success, true);
  assert.equal(result.available, true);
  assert.equal(result.phase, 'available');
  assert.equal(result.version, '1.1.0');
  assert.equal(result.currentVersion, '1.0.0');
  assert.equal(result.releaseNotes, 'fix\n\nfeat');
  assert.equal(events.at(-1).channel, 'update:available');
});

test('reports no update when already current', async () => {
  const { controller, updater } = makeController();
  updater.checkResult = { isUpdateAvailable: false };
  const result = await controller.check();
  assert.equal(result.success, true);
  assert.equal(result.available, false);
  assert.equal(result.phase, 'idle');
  assert.equal(result.version, '1.0.0');
});

test('check failure is returned instead of thrown', async () => {
  const { controller, updater } = makeController();
  updater.checkForUpdates = async () => { throw new Error('network down'); };
  const result = await controller.check();
  assert.equal(result.success, false);
  assert.equal(result.stage, 'check');
  assert.match(result.error, /network down/);
});

test('download refuses to start before an update is available', async () => {
  const { controller } = makeController();
  const result = await controller.download();
  assert.equal(result.success, false);
  assert.equal(result.stage, 'download');
});

test('download emits progress and settles on downloaded', async () => {
  const { controller, updater, events } = makeController();
  updater.checkResult = { isUpdateAvailable: true, updateInfo: { version: '1.1.0' } };
  await controller.check();
  updater.onDownload = async () => {
    updater.emit('download-progress', { percent: 40 });
    updater.emit('update-downloaded', { version: '1.1.0' });
  };
  const result = await controller.download();
  assert.equal(result.success, true);
  assert.equal(result.phase, 'downloaded');
  assert.deepEqual(events.find(e => e.channel === 'update:progress').data, { percent: 40 });
  assert.equal(events.at(-1).channel, 'update:downloaded');
});

test('download failure returns to available and reports the error', async () => {
  const { controller, updater, events } = makeController();
  updater.checkResult = { isUpdateAvailable: true, updateInfo: { version: '1.1.0' } };
  await controller.check();
  updater.onDownload = async () => { throw new Error('disk full'); };
  const result = await controller.download();
  assert.equal(result.success, false);
  assert.equal(result.stage, 'download');
  assert.match(result.error, /disk full/);
  assert.equal(events.at(-1).channel, 'update:error');
  // A second attempt is allowed again.
  const again = await controller.download();
  assert.equal(again.success, false);
  assert.equal(again.stage, 'download');
});

test('install requires a completed download', () => {
  const { controller, updater } = makeController();
  const result = controller.install();
  assert.equal(result.success, false);
  assert.equal(result.stage, 'install');
  assert.equal(updater.installed.length, 0);
});

test('install quits and relaunches after a successful download', async () => {
  const { controller, updater, install } = makeController();
  updater.checkResult = { isUpdateAvailable: true, updateInfo: { version: '1.1.0' } };
  await controller.check();
  updater.onDownload = async () => { updater.emit('update-downloaded', { version: '1.1.0' }); };
  await controller.download();
  const result = controller.install();
  assert.equal(result.success, true);
  assert.equal(install.prepared, 1);
  assert.equal(install.restored, 0);
  assert.deepEqual(updater.installed, [[false, true]]);
});
