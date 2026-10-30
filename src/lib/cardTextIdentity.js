export const MIN_TEXT_CONFIDENCE = 90;
export const normalizeCardName = (value) => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

function oneEditApart(left, right) {
  if (Math.abs(left.length - right.length) > 1) return false;
  let a = 0, b = 0, edits = 0;
  while (a < left.length && b < right.length) {
    if (left[a] === right[b]) { a++; b++; continue; }
    if (++edits > 1) return false;
    if (left.length >= right.length) a++;
    if (right.length >= left.length) b++;
  }
  return edits + (left.length - a) + (right.length - b) <= 1;
}

export function parsePrintedCode(value) {
  const text = String(value || '').toUpperCase().replace(/[\u00b7\u2022]/g, ' ').trim();
  const match = text.match(/\b([A-Z]{3})\s*[- ]?\s*([A-Z]*\d+[A-Z]?\*?)(?:\s*\/\s*(\d+))?(?=\s|$)/);
  return match ? { set: match[1], collector: match[2], total: match[3] || null } : null;
}

export class CardTextIndex {
  constructor(cards) {
    this.cards = cards;
    this.records = cards.map((card) => ({ card, code: parsePrintedCode(card.code), name: normalizeCardName(card.name) }));
    this.names = [...new Set(this.records.map((entry) => entry.name).filter(Boolean))];
  }
  collectors(lines = []) {
    const matches = [];
    for (const line of lines) {
      if (!Number.isFinite(line.confidence) || line.confidence < MIN_TEXT_CONFIDENCE) continue;
      const code = parsePrintedCode(line.text);
      if (!code) continue;
      const found = this.records.filter((r) => r.code && r.code.set === code.set && r.code.collector === code.collector &&
        (!code.total || r.code.total === code.total));
      const stem = code.collector.replace(/[A-Z*]+$/, '');
      // A read slash/denominator explicitly terminates the numerator. Without
      // that boundary, a missing a/* suffix must remain ambiguous.
      const ambiguousVariant = !code.total && /^\d+$|^[A-Z]+\d+$/.test(code.collector) && this.records.some((r) => r.code?.set === code.set &&
        r.code.collector !== code.collector && r.code.collector.replace(/[A-Z*]+$/, '') === stem);
      if (found.length === 1) matches.push({ card: found[0].card, code, raw: line.text, confidence: line.confidence, ambiguousVariant });
    }
    return matches;
  }
  collector(lines = []) {
    const matches = this.collectors(lines);
    return matches.length && matches.every((entry) => entry.card.id === matches[0].card.id) ? matches[0] : null;
  }
  resolve({ nameLines = [], footerLines = [], tooSmall = false } = {}) {
    const collectors = this.collectors(footerLines);
    const collector = collectors.length && collectors.every(entry => entry.card.id === collectors[0].card.id) ? collectors[0] : null;
    const goodNames = nameLines.filter((line) => Number.isFinite(line.confidence) && line.confidence >= MIN_TEXT_CONFIDENCE);
    const readings = goodNames.map((line) => ({ ...line, normalized: normalizeCardName(line.text) }));
    // Wrapped names may span adjacent OCR lines. Never search arbitrary substrings
    // in rules text or inject the expected candidate name into the OCR engine.
    for (let i = 0; i < goodNames.length - 1; i++) readings.push({ text: `${goodNames[i].text} ${goodNames[i + 1].text}`,
      confidence: Math.min(goodNames[i].confidence, goodNames[i + 1].confidence),
      partial: goodNames[i].partial || goodNames[i + 1].partial,
      normalized: normalizeCardName(goodNames[i].text + goodNames[i + 1].text) });
    const named = [];
    for (const reading of readings) {
      let names = this.names.filter((name) => name === reading.normalized);
      if (!names.length && reading.normalized.length >= 8) names = this.names.filter((name) => name.length >= 8 && oneEditApart(name, reading.normalized));
      if (names.length === 1) named.push({ ...reading, name: names[0] });
    }
    const name = collector ? named.find((entry) => entry.name === normalizeCardName(collector.card.name)) : named[0];
    const nameCardIds = [...new Set(this.records.filter((entry) => named.some((n) => n.name === entry.name)).map((entry) => entry.card.id))];
    const completeNameIds = [...new Set(this.records.filter((entry) => named.some((n) => !n.partial && n.name === entry.name)).map((entry) => entry.card.id))];
    const base = { name: name?.text || goodNames[0]?.text || nameLines[0]?.text || '', code: collector?.raw || footerLines[0]?.text || '',
      nameConfidence: name?.confidence ?? 0, codeConfidence: collector?.confidence ?? 0,
      codeCardId: collector && !collector.ambiguousVariant ? collector.card.id : null,
      nameCardIds: completeNameIds, matchedNameCardIds: nameCardIds, tooSmall };
    if (new Set(collectors.filter(entry=>!entry.ambiguousVariant).map(entry=>entry.card.id)).size > 1) return { ...base, status: 'conflict', reason: 'collector-readings-conflict' };
    if (collector && completeNameIds.length && !nameCardIds.includes(collector.card.id)) return { ...base, status: 'conflict', reason: 'name-code-conflict' };
    if (collector && name && !collector.ambiguousVariant) return { ...base, status: 'confirmed', cardId: collector.card.id };
    return { ...base, status: 'unreadable', reason: collector?.ambiguousVariant ? 'variant-unclear' : tooSmall ? 'text-too-small' : 'text-unreadable' };
  }
}
