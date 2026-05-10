export function buildScanSetOptions(cards = []) {
  const bySet = new Map();

  for (const card of cards) {
    const setCode = String(card?.set || '').trim().toUpperCase();
    if (!setCode || bySet.has(setCode)) continue;

    const setName = String(card?.setName || '').trim();
    bySet.set(setCode, {
      value: setCode,
      label: setName ? `${setCode} · ${setName}` : setCode,
    });
  }

  return [
    { value: 'all', label: 'All sets' },
    ...[...bySet.values()].sort((left, right) => left.value.localeCompare(right.value)),
  ];
}
