import { hasLocalArtworkSupport } from './localArtwork.js';
import { hasStrongVisualProof } from './cardVisualProof.js';
import { hasRuneTextArtwork, hasRuneGeometry } from './cardRuneVerification.js';

export const AUTOMATIC_ARTWORK_MINIMUM = .90;
export const ARTWORK_SEPARATION = .05;
export const SCAN_ACCEPTANCE_POLICY = 'joint-evidence-v6';

// Scores remain observations, not probabilities. Different evidence paths have
// different requirements; text confidence is never added to an artwork score.
export function assessScanAcceptance(result, { photo = false, minSimilarity = AUTOMATIC_ARTWORK_MINIMUM } = {}) {
  const requiredTextFrames = photo ? 1 : 2;
  const threshold = Math.max(minSimilarity, result?.minSimilarity || 0);
  const base = { policy: SCAN_ACCEPTANCE_POLICY, phase: 'candidate', eligible: false, path: null,
    requirements: { standaloneArtwork: threshold, standaloneGap: ARTWORK_SEPARATION,
      textConfidence: 90, independentTextFrames: requiredTextFrames, visualCandidates: 5,
      independentVisualFrames: result?.similarity >= .96 && result?.similarityGap >= .07 ? 2 : 3 } };
  const fail = reason => ({ ...base, reason });
  if (!result?.cardData?.id) return fail('low-similarity');
  if (result.quality?.acceptable !== true) return fail(result.quality?.issue || 'invalid-quality');
  if (![result.similarity, result.similarityGap].every(Number.isFinite)) return fail('invalid-artwork');
  const proof = result.textVerification;
  if (proof?.status === 'conflict') return fail('text-conflict');
  if (hasStrongVisualProof(result) && !result.geometryConflict) return { ...base, phase: 'eligible', eligible: true,
    path: 'verified-artwork-geometry', reason: null, requirements: { ...base.requirements,
      standaloneArtwork: null, standaloneGap: null, independentVisualFrames: 2,
      visualCandidates: result.visualVerification.comparedCandidates, artworkCorroboration: 'keypoint-homography' } };
  if (proof?.status === 'pending' && !proof.artworkFallbackAllowed) return fail('reading-text');
  if(result.confirmationMethod==='rune-text'){
    const ids=proof?.sourceFrameIds||[];
    if(result.cardData.type!=='rune'||proof?.status!=='confirmed'||proof.evidenceType!=='rune-name-set-artwork'||
      proof.cardId!==result.cardData.id||proof.readSet!==result.cardData.set||!(proof.nameConfidence>=90&&proof.setConfidence>=90)||
      new Set(ids).size<requiredTextFrames||!ids.every(id=>(typeof id==='number'&&Number.isFinite(id))||(typeof id==='string'&&id.length>0))||
      !hasRuneTextArtwork(proof,result.cardData.id,requiredTextFrames)||result.geometryConflict||
      !result.visualCandidates?.some(candidate=>candidate.id===result.cardData.id))return fail('text-unconfirmed');
    return {...base,phase:'eligible',eligible:true,path:'rune-name-set-artwork',reason:null,
      requirements:{...base.requirements,standaloneArtwork:null,standaloneGap:null,independentVisualFrames:2,
        artworkCorroboration:'rune-printing-geometry',setConfidence:90}};
  }
  if(result.requiresTextConfirmation&&result.confirmationMethod!=='text')return fail('reading-text');
  if (result.confirmationMethod === 'text') {
    const sourceIds = Array.isArray(proof?.sourceFrameIds) ? proof.sourceFrameIds : [];
    const independent = sourceIds.every(id => (typeof id === 'number' && Number.isFinite(id)) || (typeof id === 'string' && id.length > 0)) &&
      new Set(sourceIds).size >= requiredTextFrames;
    if (proof?.status !== 'confirmed' || proof.cardId !== result.cardData.id || !independent ||
      !(proof.nameConfidence >= 90 && proof.codeConfidence >= 90)) return fail('text-unconfirmed');
    const visual = result.visualCandidates?.slice(0, 5).find(entry => entry.id === result.cardData.id);
    if (!visual) return fail('text-conflict');
    const localSupport = (hasLocalArtworkSupport(result) && hasLocalArtworkSupport(visual)) ||
      (result.cardData.type==='rune'&&hasRuneGeometry(result.visualVerification,result.cardData.id,result.frameId));
    if (result.similarity < threshold && !localSupport) return fail('text-artwork-insufficient');
    return { ...base, phase: 'eligible', eligible: true,
      path: result.similarity < threshold ? 'text-and-local-artwork' : 'text-and-artwork', reason: null,
      independentTextFrames: new Set(sourceIds).size,
      requirements: { ...base.requirements, standaloneArtwork: null, standaloneGap: null,
        artworkCorroboration: result.similarity < threshold ? 'local-detail' : 'strong-artwork' } };
  }
  if(result.detectorProposal)return fail('detector-unconfirmed');
  if (result.geometryConflict) return fail('geometry-conflict');
  if (result.similarity < threshold) return fail('low-similarity');
  if (result.similarityGap < ARTWORK_SEPARATION) return fail('ambiguous');
  return { ...base, phase: 'eligible', eligible: true, path: 'distinct-artwork', reason: null };
}
