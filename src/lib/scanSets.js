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

export function summarizeScanSetCoverage(cards = [], maxItems = 6) {
  const options = buildScanSetOptions(cards).slice(1);
  if (options.length === 0) {
    return {
      count: 0,
      fullLabel: 'No sets loaded',
      label: 'No sets loaded',
    };
  }

  const labels = options.map((option) => option.label);
  const visibleLabels = labels.slice(0, maxItems);

  if (labels.length > maxItems) {
    visibleLabels.push(`+${labels.length - maxItems} more`);
  }

  return {
    count: labels.length,
    fullLabel: labels.join(', '),
    label: visibleLabels.join(', '),
  };
}
