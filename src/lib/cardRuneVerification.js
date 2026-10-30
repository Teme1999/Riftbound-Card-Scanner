import { strongVisualGeometry, VISUAL_PROOF_LIMITS } from './cardVisualProof.js';
import { normalizeCardName } from './cardTextIdentity.js';

export const RUNE_ARTWORK_VERSION = 'rune-artwork-v2';

// This is text-corroborated rune artwork, never the standalone visual path.
// Dense registered pixels cover parts of smooth/foil art without ORB corners.
export function strongRegisteredRuneArtwork(value) {
  const geometry=value?.registeredGeometry,art=value?.registeredArtwork;
  return Boolean(geometry&&art&&['inliers','ratio','error'].every(key=>Number.isFinite(geometry[key]))&&
    ['correlation','validCoverage','tilesCompared','tilesMatched','outerTilesMatched','columnsMatched','rowsMatched'].every(key=>Number.isFinite(art[key]))&&
    geometry.inliers>=20&&geometry.ratio>=.6&&geometry.error<=1.5&&geometry.validProjection===true&&
    art.correlation>=.45&&art.validCoverage>=.75&&art.tilesCompared>=8&&art.tilesMatched>=4&&
    art.outerTilesMatched>=1&&art.columnsMatched>=3&&art.rowsMatched>=2);
}

const separatedGeometry = candidate => strongVisualGeometry(candidate)&&candidate.inliers-candidate.runnerInliers>=VISUAL_PROOF_LIMITS.separation&&
  candidate.inliers>=Math.max(1,candidate.runnerInliers)*VISUAL_PROOF_LIMITS.runnerRatio;
const separatedRegistration = candidate => strongRegisteredRuneArtwork(candidate)&&
  candidate.registeredArtwork.correlation-candidate.registeredRunnerCorrelation>=.2;

// Shared art across sets is expected. Every printing of this name, including
// hidden sets, must actually be compared before set text may resolve identity.
export function buildRuneArtworkProof(comparisons, family, frameId) {
  const complete = family.length > 0 && family.every(card => comparisons.some(c => c.id === card.id));
  const candidates = family.map(card => {
    const geometry = comparisons.find(c => c.id === card.id);
    const rivals = comparisons.filter(c => c.id !== card.id && family.some(other => other.id === c.id && other.set === card.set));
    const runner = Math.max(0, ...rivals.map(c => c.maxInliers ?? c.inliers ?? 0));
    const registeredRunner=Math.max(0,...rivals.map(c=>c.registeredArtwork?.correlation||0));
    const separated = geometry && geometry.inliers - runner >= VISUAL_PROOF_LIMITS.separation && geometry.inliers >= Math.max(1, runner) * VISUAL_PROOF_LIMITS.runnerRatio;
    const candidate={...geometry,runnerInliers:runner,registeredRunnerCorrelation:registeredRunner};
    return { ...candidate, cardId: card.id, set: card.set, name: card.name,
      verified: complete && card.type === 'rune' && ((strongVisualGeometry(geometry)&&Boolean(separated))||separatedRegistration(candidate)) };
  });
  return { version: RUNE_ARTWORK_VERSION, status: 'rune-artwork', sourceFrameId: frameId,
    completeFamily: complete, familyIds: family.map(card => card.id), candidates };
}

export function hasRuneArtwork(proof, cardId, frameId) {
  const candidate = proof?.candidates?.find(c => c.cardId === cardId);
  return Boolean(proof?.version === RUNE_ARTWORK_VERSION && proof.completeFamily && proof.sourceFrameId != null && proof.sourceFrameId === frameId &&
    candidate?.verified && (separatedGeometry(candidate)||separatedRegistration(candidate)));
}

export function hasRuneGeometry(proof, cardId, frameId) {
  return Boolean(proof?.version===RUNE_ARTWORK_VERSION&&proof.completeFamily&&proof.sourceFrameId===frameId&&frameId!=null&&
    (strongVisualGeometry(proof.candidates?.find(candidate=>candidate.cardId===cardId))||strongRegisteredRuneArtwork(proof.candidates?.find(candidate=>candidate.cardId===cardId))));
}

export function hasRuneTextArtwork(reading, cardId, requiredFrames = 2) {
  const ids = reading?.sourceFrameIds || [];
  return new Set(ids).size >= requiredFrames && ids.every(id =>
    reading.sourceArtwork?.some(source => source.frameId === id && hasRuneArtwork(source.proof, cardId, id)));
}

export function resolveRuneText(index, { nameLines = [], setLines = [], artwork } = {}) {
  const names = index.resolve({ nameLines });
  // These lines come only from the rune title band. A complete rune name in a
  // high-confidence word run is usable even when an ornament spoiled the rest
  // of its OCR line. Missing name characters are never supplied by the artwork.
  const trustedNames=nameLines.filter(line=>line.confidence>=90&&index.cards.some(card=>card.type==='rune'&&normalizeCardName(card.name)===normalizeCardName(line.text)));
  const nameIds=index.cards.filter(card=>card.type==='rune'&&trustedNames.some(line=>normalizeCardName(line.text)===normalizeCardName(card.name))).map(card=>card.id);
  const sets = setLines.filter(line => line.confidence >= 90 && /^[A-Z]{3}$/.test(line.text)).map(line => ({ ...line, set: line.text }));
  const distinctSets = [...new Set(sets.map(line => line.set))];
  const base = { ...names, name:trustedNames[0]?.text||names.name,nameConfidence:trustedNames[0]?.confidence||names.nameConfidence,nameCardIds:nameIds,
    evidenceType: 'rune-name-set-artwork', readSet: sets[0]?.set || '', setConfidence: sets[0]?.confidence || 0,
    code: '', codeConfidence: 0, artworkSourceFrameId: artwork?.sourceFrameId };
  if(new Set(trustedNames.map(line=>normalizeCardName(line.text))).size>1)return {...base,status:'conflict',reason:'rune-name-readings-conflict'};
  if (distinctSets.length > 1) return { ...base, status: 'conflict', reason: 'set-readings-conflict' };
  if (!distinctSets.length || !nameIds.length) return { ...base, status: 'unreadable', reason: 'rune-name-set-unreadable' };
  const candidates = index.cards.filter(card => card.type === 'rune' && card.set === sets[0].set && nameIds.includes(card.id) &&
    hasRuneArtwork(artwork, card.id, artwork?.sourceFrameId));
  const name = nameLines.find(line => line.confidence >= 90 && candidates.some(card => normalizeCardName(card.name) === normalizeCardName(line.text)));
  if (candidates.length === 1 && name) return { ...base, name: name.text, nameConfidence: name.confidence,
    status: 'confirmed', reason: null, cardId: candidates[0].id, artworkProof: artwork };
  return { ...base, status: 'unreadable', reason: 'rune-printing-needs-full-code' };
}
