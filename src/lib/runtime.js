export function getAppBaseUrl() {
  if (typeof globalThis !== 'undefined' && typeof globalThis.__RIFTBOUND_APP_BASE_URL__ === 'string' && globalThis.__RIFTBOUND_APP_BASE_URL__) {
    return globalThis.__RIFTBOUND_APP_BASE_URL__;
  }

  if (typeof window !== 'undefined' && window.location?.origin) {
    return `${window.location.origin}/`;
  }

  return '/';
}

export function isDesktopRuntime() {
  return Boolean(
    typeof globalThis !== 'undefined' &&
    (globalThis.__TAURI__ || globalThis.__TAURI_INTERNALS__)
  );
}

export function resolveAppUrl(pathname) {
  return new URL(pathname, getAppBaseUrl()).toString();
}