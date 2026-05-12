import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { isDesktopRuntime } from './runtime.js';

export async function checkForAppUpdate() {
  if (!isDesktopRuntime()) {
    return null;
  }

  return check();
}

export async function downloadAndInstallAppUpdate(update, onProgress) {
  if (!update) {
    throw new Error('No app update is available to install.');
  }

  let downloadedBytes = 0;
  let totalBytes = null;

  await update.downloadAndInstall((event) => {
    if (event.event === 'Started') {
      downloadedBytes = 0;
      totalBytes = event.data.contentLength ?? null;
      onProgress?.({
        status: 'started',
        downloadedBytes,
        totalBytes,
        percent: 0,
      });
      return;
    }

    if (event.event === 'Progress') {
      downloadedBytes += event.data.chunkLength;
      const percent = totalBytes ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)) : null;
      onProgress?.({
        status: 'progress',
        downloadedBytes,
        totalBytes,
        percent,
      });
      return;
    }

    if (event.event === 'Finished') {
      onProgress?.({
        status: 'finished',
        downloadedBytes,
        totalBytes,
        percent: 100,
      });
    }
  });
}

export async function relaunchApp() {
  await relaunch();
}
