'use strict';

function normalizeNotes(notes) {
  return Array.isArray(notes) ? notes.map(item => item.note || '').join('\n\n') : String(notes || '');
}

/** Electron-independent update state machine. Feed comes from packaged app-update.yml. */
function createUpdateController({ app, updater, send, prepareInstall = () => {}, restoreInstall = () => {} }) {
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = true;
  updater.allowDowngrade = false;
  let phase = 'idle';
  let info = null;
  let checking = null;
  let downloading = null;
  let downloadErrorSent = false;
  let installError = null;
  const snapshot = () => ({ success: true, available: !!info, phase,
    currentVersion: app.getVersion(), version: info?.version || app.getVersion(),
    releaseNotes: normalizeNotes(info?.releaseNotes) });
  const failure = (error, stage) => ({ success: false, error: String(error.message || error), stage });
  updater.on('error', error => {
    // check() returns errors to its caller; background checks remain quiet.
    if (phase === 'downloading' || phase === 'installing') {
      const stage = phase === 'downloading' ? 'download' : 'install';
      phase = stage === 'download' ? 'available' : 'downloaded';
      if (stage === 'download') downloadErrorSent = true;
      else restoreInstall();
      const result = failure(error, stage);
      if (stage === 'install') installError = result;
      send('update:error', result);
    }
  });
  updater.on('download-progress', progress => {
    if (phase === 'downloading') send('update:progress', progress);
  });
  updater.on('update-downloaded', downloaded => {
    info = downloaded || info;
    phase = 'downloaded';
    send('update:downloaded', snapshot());
  });
  async function check() {
    if (!app.isPackaged) return { success: false, devMode: true };
    if (downloading || ['downloaded', 'installing'].includes(phase)) return snapshot();
    if (checking) return checking;
    checking = (async () => {
      try {
        const result = await updater.checkForUpdates();
        // Updater performs semver comparison and channel checks, including downgrade prevention.
        info = result?.isUpdateAvailable === true ? result.updateInfo : null;
        phase = info ? 'available' : 'idle';
        const state = snapshot();
        if (info) send('update:available', state);
        return state;
      } catch (error) { return failure(error, 'check'); }
    })();
    try { return await checking; } finally { checking = null; }
  }
  async function download() {
    if (!app.isPackaged) return { success: false, devMode: true };
    // A pending recheck may replace available metadata; wait before starting a download.
    if (checking) await checking;
    if (downloading) return downloading;
    if (phase === 'downloaded') return snapshot();
    if (phase !== 'available') return failure(new Error('请先检查并确认有新版本'), 'download');
    downloadErrorSent = false;
    phase = 'downloading';
    downloading = (async () => {
      try {
        await updater.downloadUpdate();
        if (phase !== 'downloaded') throw new Error('更新文件尚未校验完成，请重试下载');
        return snapshot();
      } catch (error) {
        phase = 'available';
        const result = failure(error, 'download');
        if (!downloadErrorSent) send('update:error', result);
        return result;
      }
    })();
    try { return await downloading; } finally { downloading = null; }
  }
  function install() {
    if (phase !== 'downloaded') return failure(new Error('请等待更新下载完成后安装'), 'install');
    installError = null;
    try {
      prepareInstall();
      phase = 'installing';
      updater.quitAndInstall(false, true);
      // NSISUpdater can emit an error synchronously without throwing.
      if (installError) return installError;
      return { success: true };
    } catch (error) {
      if (installError) return installError;
      phase = 'downloaded';
      restoreInstall();
      const result = failure(error, 'install');
      send('update:error', result);
      return result;
    }
  }
  return { check, download, install };
}
module.exports = { createUpdateController, normalizeNotes };
