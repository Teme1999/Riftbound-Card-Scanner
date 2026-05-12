import { invoke } from '@tauri-apps/api/core';
import { isDesktopRuntime } from './runtime.js';

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
