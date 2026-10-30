export const SCANNER_EXPERIMENTS_KEY = 'riftbound_scanner_experiments';
export const SCANNER_DEBUG_KEY = 'riftbound_scanner_debug_overlay_enabled';
export const SCANNER_OVERLAY_KEY = 'riftbound_scanner_overlay_enabled';
export const SCANNER_DIAGNOSTICS_AVAILABLE = import.meta.env?.DEV === true;
export function normalizeScannerExperiments(value) {
  return { perspective: value?.perspective !== false, textVerification: value?.textVerification !== false };
}
