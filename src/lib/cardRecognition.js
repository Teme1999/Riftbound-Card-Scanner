import { resolveCardData } from './cardData.js';
import { MIN_SIMILARITY_GAP, readCanvasQuality } from './scanQuality.js';
import { MIN_LOCAL_ARTWORK_SIMILARITY, hasLocalArtworkSupport, artworkDetailScore } from './localArtwork.js';
import { assessScanAcceptance } from './scanAcceptance.js';
import { rectifyArtworkTextCrop } from './cardArtworkRegistration.js';

function decide(result, options = {}) {
  const acceptanceDecision = assessScanAcceptance(result, options);
  return { ...result, acceptanceDecision, matched: acceptanceDecision.eligible, reason: acceptanceDecision.reason };
}

export function rotateCardCanvas(canvas, quarterTurns = 1) {
  const turns = ((quarterTurns % 4) + 4) % 4;
  if (!turns) return canvas;
  const rotated = document.createElement('canvas');
  rotated.width = turns % 2 ? canvas.height : canvas.width;
  rotated.height = turns % 2 ? canvas.width : canvas.height;
  const ctx = rotated.getContext('2d');
  ctx.translate(rotated.width / 2, rotated.height / 2);
  ctx.rotate(turns * Math.PI / 2);
  ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  if (canvas.scanCardBounds) {
    let { x, y, width, height } = canvas.scanCardBounds;
    for (let turn = 0; turn < turns; turn++) [x, y, width, height] = [1 - y - height, x, height, width];
    rotated.scanCardBounds = { x, y, width, height };
  }
  return rotated;
}

export function portraitCardCanvas(canvas) {
  return canvas.width > canvas.height ? rotateCardCanvas(canvas) : canvas;
}

export function cropCardBox(source, { cx, cy, w, h, angle }) {
  const size = Math.ceil(Math.hypot(w, h)) + 4;
  const big = document.createElement('canvas');
  big.width = size; big.height = size;
  const ctx = big.getContext('2d');
  ctx.translate(size / 2, size / 2); ctx.rotate(-angle);
  ctx.drawImage(source, -cx, -cy);
  const crop = document.createElement('canvas');
  crop.width = Math.max(1, Math.round(w)); crop.height = Math.max(1, Math.round(h));
  crop.getContext('2d').drawImage(big, size / 2 - w / 2, size / 2 - h / 2, w, h, 0, 0, w, h);
  return portraitCardCanvas(crop);
}

// Photo review retains its quarter-turn retry and actual scores. Camera mode
// keeps the existing single portrait comparison when enhancements are disabled.
export function identifyArtwork(crop, matcher, { setFilter, photo = false, limit = 5, candidates = false, areaSampling = false } = {}) {
  if (!matcher?.ready) return null;
  if (!photo) return candidates ? matchFromRanking(matcher.rank(crop, { setFilter, limit, areaSampling, localStructure: areaSampling })) : matcher.identify(crop, { setFilter, areaSampling, localStructure: areaSampling });
  const byId = new Map();
  for (const canvas of [crop, rotateCardCanvas(crop)]) {
    for (const entry of matcher.rank(canvas, { setFilter, limit, areaSampling, localStructure: areaSampling })) {
      const previous = byId.get(entry.card.id);
      if (!previous || (areaSampling ? artworkDetailScore(entry) > artworkDetailScore(previous) : entry.similarity > previous.similarity)) byId.set(entry.card.id, entry);
    }
  }
  return matchFromRanking([...byId.values()].sort((a, b) => areaSampling ? artworkDetailScore(b) - artworkDetailScore(a) : b.similarity - a.similarity));
}

export function matchFromRanking(ranked) {
  if (!ranked?.length) return null;
  return { ...ranked[0], secondBestSim: ranked[0].secondBestSim ?? Math.max(0, ...ranked.slice(1).map(entry => entry.similarity)), candidates: ranked,
    top3: ranked.slice(0, 3).map((entry) => ({ ...resolveCardData(entry.card),
      sim: (entry.similarity * 100).toFixed(1), similarity: entry.similarity })) };
}

export function buildRecognitionResult(match, quality, minSimilarity = 0.9, base = {}) {
  if (!match?.card) return { ...base, quality, matched: false, reason: 'low-similarity' };
  const threshold = Math.max(0.68, minSimilarity);
  const similarityGap = match.similarity - (match.secondBestSim ?? 0);
  const strong = match.similarity >= threshold;
  const matched = !base.geometryConflict && quality?.acceptable === true && strong && similarityGap >= MIN_SIMILARITY_GAP;
  return decide({ ...base, cardData: resolveCardData(match.card), similarity: match.similarity,
    colorSimilarity: match.colorSimilarity, structureSimilarity: match.structureSimilarity,
    localStructureSimilarity: match.localStructureSimilarity,
    alignedArtworkSimilarity: match.alignedArtworkSimilarity, artworkAlignment: match.artworkAlignment,
    similarityGap, minSimilarity: threshold, minSimilarityGap: MIN_SIMILARITY_GAP,
    quality, matched, timestamp: Date.now(),
    reason: matched ? null : quality?.issue || (base.geometryConflict ? 'geometry-conflict' : strong ? 'ambiguous' : 'low-similarity') }, { minSimilarity: threshold });
}

export function applyTextVerification(result, match, verification, { photo = false } = {}) {
  const candidates = match?.candidates || (match?.card ? [match] : []);
  const visualCandidates = candidates.map((entry) => ({ id: entry.card.id, similarity: entry.similarity,
    localStructureSimilarity: entry.localStructureSimilarity,
    alignedArtworkSimilarity: entry.alignedArtworkSimilarity, artworkAlignment: entry.artworkAlignment,
    similarityGap: entry.similarity - (entry.secondBestSim ?? Math.max(0, ...candidates.filter((other) => other.card.id !== entry.card.id).map((other) => other.similarity))) }));
  const base = { ...result, visualCandidates, textVerification: verification, confirmationMethod: 'artwork' };
  if (result.visualVerification?.status === 'verified' && verification.status === 'confirmed' && verification.cardId !== result.cardData?.id)
    return decide({ ...base, textVerification: { ...verification, status: 'conflict', reason: 'visual-text-disagreement' } }, {photo,minSimilarity:result.minSimilarity});
  if (verification.status === 'pending' || verification.status === 'conflict') return decide(base, { photo, minSimilarity: result.minSimilarity });
  const sourceIds = new Set(verification.sourceFrameIds || []);
  if (verification.status !== 'confirmed' || sourceIds.size < (photo ? 1 : 2)) return decide(base, { photo, minSimilarity: result.minSimilarity });
  if(verification.evidenceType==='rune-name-set-artwork'){
    const rune=candidates.find(entry=>entry.card.id===verification.cardId);
    if(!rune)return decide({...base,textVerification:{...verification,status:'conflict',reason:'outside-visual-candidates'}},{photo});
    return decide({...base,cardData:resolveCardData(rune.card),similarity:rune.similarity,colorSimilarity:rune.colorSimilarity,
      structureSimilarity:rune.structureSimilarity,localStructureSimilarity:rune.localStructureSimilarity,
      alignedArtworkSimilarity:rune.alignedArtworkSimilarity,artworkAlignment:rune.artworkAlignment,
      similarityGap:visualCandidates.find(c=>c.id===rune.card.id).similarityGap,
      confirmationMethod:'rune-text',confirmationReason:'name-set-rune-artwork'},{photo,minSimilarity:result.minSimilarity});
  }
  const entry = candidates.slice(0, 5).find((candidate) => candidate.card.id === verification.cardId);
  if (!entry) return { ...base, matched: false, reason: 'text-conflict',
    textVerification: { ...verification, status: 'conflict', reason: 'outside-visual-candidates' } };
  const actualGap = visualCandidates.find((candidate) => candidate.id === entry.card.id).similarityGap;
  const localSupport = hasLocalArtworkSupport(entry);
  const matched = result.quality?.acceptable === true && (entry.similarity >= result.minSimilarity || localSupport);
  return decide({ ...base, cardData: resolveCardData(entry.card), similarity: entry.similarity,
    colorSimilarity: entry.colorSimilarity, structureSimilarity: entry.structureSimilarity,
    localStructureSimilarity: entry.localStructureSimilarity,
    alignedArtworkSimilarity: entry.alignedArtworkSimilarity, artworkAlignment: entry.artworkAlignment,
    cropMethod: entry.cropMethod || result.cropMethod,
    similarityGap: actualGap, geometryConflict: false, matched,
    reason: matched ? null : result.quality?.issue || 'text-artwork-insufficient', confirmationMethod: 'text',
    confirmationReason: matched && entry.similarity < result.minSimilarity
      ? entry.localStructureSimilarity>=MIN_LOCAL_ARTWORK_SIMILARITY?'name-number-local-artwork':'name-number-aligned-artwork'
      : 'name-number' }, { photo, minSimilarity: result.minSimilarity });
}

export function chooseArtworkCrop(original, refined, minSimilarity = .9) {
  if (!refined?.quality?.acceptable) return { ...original, geometryConflict: false };
  const previous = buildRecognitionResult(original.match, original.quality, minSimilarity);
  const next = buildRecognitionResult(refined.match, refined.quality, minSimilarity);
  const geometryConflict = previous.matched && next.matched && previous.cardData.id !== next.cardData.id;
  const compare = (candidate) => candidate.match?.localStructureSimilarity==null?candidate.match?.similarity??0:artworkDetailScore(candidate.match);
  const better = !geometryConflict && ((next.matched && (!previous.matched || next.similarity > previous.similarity)) ||
    (!previous.matched && compare(refined) > compare(original)));
  return { ...(better ? refined : original), geometryConflict };
}

// Stable injection points keep either enhancement usable without the other.
export async function recognizeCard({ source, detection, matcher, setFilter, photo = false,
  cropRefiner = null, observation = {}, minSimilarity = 0.9, candidates = false, textCorroboration = null, visualVerifier = null, visualOnly = false }) {
  const original = portraitCardCanvas(detection.cropCanvas || cropCardBox(source, detection.box));
  let crop = original, quality = photo && !cropRefiner && !candidates ? null : readCanvasQuality(original);
  const trackingFingerprint = quality?.fingerprint;
  const areaSampling = Boolean(cropRefiner || candidates);
  let visualVerification;
  if (!photo && quality?.acceptable && visualVerifier) {
    const visual = await visualVerifier.verify(original, { matcher, setFilter, frameId: source.frameId });
    visualVerification = visual?.proof;
    if (visual?.match && visualVerification?.status === 'verified') return {
      crop: original, original, textCrop: original, alternateTextCrops: [], trackingFingerprint,
      match: visual.match, quality, geometryConflict: false, requiresTextConfirmation: false,
      cropMethod: 'obb', artworkSampling: 'area', visualVerification,
      refinement: { status: 'deferred', reason: 'verified-feature-geometry' }, ...observation, minSimilarity };
    if (visual?.runeMatch) {
      const factor=1.08;
      const padded=detection.box&&source?.width?cropCardBox(source,{...detection.box,w:detection.box.w*factor,h:detection.box.h*factor}):original;
      if(padded!==original)padded.scanCardBounds={x:.04/factor,y:.04/factor,width:1/factor,height:1/factor};
      const geometry=visualVerification.candidates.find(c=>c.cardId===visual.runeMatch.card.id)?.registeredGeometry;
      const registered=cropRefiner?rectifyArtworkTextCrop(padded,original,geometry):null;
      return {crop:original,original,textCrop:registered||padded,alternateTextCrops:registered?[padded]:[],trackingFingerprint,match:visual.runeMatch,quality,
        geometryConflict:false,requiresTextConfirmation:true,cropMethod:'obb',artworkSampling:'area',visualVerification,
        refinement:{status:'deferred',reason:'rune-name-set-required'},...observation,minSimilarity};
    }
  }
  if (visualOnly) return null;
  let match = !photo && !quality.acceptable ? null : identifyArtwork(original, matcher, { setFilter, photo, candidates, areaSampling });
  // A fresh printed identity plus current original-crop detail can avoid
  // repeating four homographies while the second OCR frame is being read.
  // These frames are TEXT ONLY: they never qualify for artwork fallback.
  const requiresTextConfirmation=Boolean(visualVerification?.status==='rune-artwork'&&match?.card.type==='rune')||Boolean(!photo&&cropRefiner&&candidates&&quality.acceptable&&textCorroboration?.cardId===match?.card?.id&&hasLocalArtworkSupport(match)&&
    !buildRecognitionResult(match,quality,minSimilarity).matched);
  let refinement = requiresTextConfirmation ? {status:'deferred',reason:'fresh-text-local-artwork'} : cropRefiner && quality.acceptable ? await cropRefiner(source, detection.box, original) : null;
  const refinements = refinement ? [refinement, ...(refinement.alternatives || [])].slice(0, 4) : [];
  const evaluated = [{ crop: original, quality, match, cropMethod: 'obb' }];
  let geometryConflict = false;
  for (const variant of refinements) if (variant.canvas) {
    const refinedQuality = readCanvasQuality(variant.canvas);
    if (refinedQuality.acceptable) {
      const refinedMatch = identifyArtwork(variant.canvas, matcher, { setFilter, photo, candidates, areaSampling });
      evaluated.push({ crop: variant.canvas, quality: refinedQuality, match: refinedMatch, cropMethod: 'perspective', refinement: variant });
      const chosen = chooseArtworkCrop({ crop, quality, match }, { crop: variant.canvas, quality: refinedQuality, match: refinedMatch }, minSimilarity);
      geometryConflict ||= chosen.geometryConflict;
      ({ crop, quality, match } = chosen);
    }
  }
  const strongIds = new Set(evaluated.filter(value => buildRecognitionResult(value.match, value.quality, minSimilarity).matched).map(value => value.match.card.id));
  geometryConflict ||= strongIds.size > 1;
  if (geometryConflict && candidates) {
    const merged = new Map();
    for (const value of evaluated) for (const entry of value.match?.candidates || []) {
      if (!merged.has(entry.card.id) || artworkDetailScore(merged.get(entry.card.id)) < artworkDetailScore(entry)) {
        merged.set(entry.card.id, { ...entry, cropMethod: value.cropMethod });
      }
    }
    match = { ...match, candidates: [...merged.values()].sort((a, b) => artworkDetailScore(b) - artworkDetailScore(a)).slice(0, 5) };
  }
  refinement = evaluated.find(value => value.crop === crop)?.refinement || refinement;
  // Text has its own source selection. A crop that raises artwork similarity
  // can still cut off the printed ID, so it must not replace the OCR original.
  let textCrop = original;
  if (candidates && (source?.width || source?.naturalWidth) && Number.isFinite(detection.box?.w + detection.box?.h)) {
    const factor = 1.08;
    textCrop = cropCardBox(source, { ...detection.box, w: detection.box.w * factor, h: detection.box.h * factor });
    textCrop.scanCardBounds = { x: .04 / factor, y: .04 / factor, width: 1 / factor, height: 1 / factor };
  }
  const alternateTextCrops = evaluated.filter(value => value.refinement).sort((a, b) =>
    Number(b.crop === crop) - Number(a.crop === crop) || artworkDetailScore(b.match) - artworkDetailScore(a.match)).map(value => value.crop);
  return { crop, original, textCrop, alternateTextCrops, trackingFingerprint, match, quality, geometryConflict,requiresTextConfirmation,visualVerification,
    cropMethod: crop === original ? 'obb' : 'perspective', artworkSampling: areaSampling ? 'area' : 'canvas', refinement, ...observation, minSimilarity };
}
