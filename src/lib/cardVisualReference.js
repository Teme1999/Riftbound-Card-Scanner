// A cached desktop file can disappear after import/migration. The bundled
// fallback is always the SAME card ID; a missing reference never changes identity.
export async function loadVisualReference(entry, { fetcher = fetch, decode = blob => createImageBitmap(blob) } = {}) {
  const urls = [...new Set([entry.url, entry.fallbackUrl].filter(Boolean))];
  let lastError;
  for (const url of urls) {
    try {
      const response = await fetcher(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bitmap = await decode(await response.blob());
      return { bitmap, source: url === entry.url ? 'primary' : 'bundled-fallback' };
    } catch (error) { lastError = error; }
  }
  const error = new Error(`Reference ${entry.id} unavailable: ${lastError?.message || 'no image URL'}`);
  error.referenceId = entry.id;
  throw error;
}
