import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { isDesktopRuntime } from './runtime.js';

export async function checkForAppUpdate() {
  if (!isDesktopRuntime()) {
    return null;
  }

  return check();
}

export async function downloadAndInstallAppUpdate(update, onProgress, { beforeInstall } = {}) {
  if (!update) {
    throw new Error('No app update is available to install.');
  }

  let downloadedBytes = 0;
  let totalBytes = null;

  await update.download((event) => {
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
        status: 'downloaded',
        downloadedBytes,
        totalBytes,
        percent: 100,
      });
    }
  });
  // On Windows install() exits the process. Flush current user data before
  // calling it; code after install() is not a reliable persistence hook.
  await beforeInstall?.();
  onProgress?.({ status: 'installing', downloadedBytes, totalBytes, percent: 100 });
  await update.install();
}

export async function relaunchApp() {
  await relaunch();
}
