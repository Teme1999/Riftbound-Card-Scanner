// No work or retained observations when no diagnostic recording is running.
const listeners = new Set();

export function subscribeScanDiagnostics(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitScanDiagnostic(type, details = {}) {
  for (const listener of listeners) {
    try { listener(type, details); } catch (error) { console.warn('[Scan diagnostics]', error); }
  }
}
