// Keep the same metadata (including cached desktop image paths) in every scan mode.
export function resolveCardData(card) {
  if (!card) return null;
  const codePart = (card.code || '').split('/')[0];
  const collectorNumber = card.collectorNumber || (codePart.includes('-')
    ? codePart.split('-').slice(1).join('-')
    : String(card.number || '').padStart(3, '0'));
  return {
    id: card.id,
    name: card.name,
    collectorNumber,
    code: card.code,
    set: card.set,
    setName: card.setName,
    domain: card.domain,
    domains: card.domains,
    rarity: card.rarity,
    type: card.type,
    energy: card.energy,
    might: card.might,
    tags: card.tags,
    illustrator: card.illustrator,
    text: card.text,
    imageUrl: card.imageUrl,
  };
}
