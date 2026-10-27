// Deliberately throws on quota/permission failures so installing an update can
// be stopped while the current collection is still available in memory.
export function persistUserSnapshot(snapshot, storage = localStorage) {
  const serialized = Object.entries(snapshot).map(([key, value]) => [key, JSON.stringify(value)]);
  for (const [key, value] of serialized) storage.setItem(key, value);
}
