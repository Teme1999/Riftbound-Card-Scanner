import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { isDesktopRuntime } from './runtime.js';

export function hasDesktopBridge() {
  return isDesktopRuntime();
}

export async function invokeDesktopCommand(command, payload = {}) {
  if (!isDesktopRuntime()) {
    throw new Error('Desktop bridge is not available in this runtime.');
  }

  return invoke(command, payload);
}

export async function openDesktopUrl(url) {
  if (!isDesktopRuntime()) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }

  return invoke('open_external_url', { url });
}

export async function openDesktopFileDialog(options = {}) {
  if (!isDesktopRuntime()) {
    throw new Error('Desktop file dialogs are not available in this runtime.');
  }

  return open(options);
}
