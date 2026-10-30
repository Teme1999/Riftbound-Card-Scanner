import { frameDifference, isScanFrameCancelled } from './scanQuality.js';
import { hasLocalArtworkSupport } from './localArtwork.js';
import { emitScanDiagnostic } from './scanDiagnostics.js';
import { hasRuneGeometry } from './cardRuneVerification.js';

export const TEXT_BUDGET_MS = 2000;
export const TEXT_RETRY_DELAY_MS = 1000;

// OCR never owns the camera loop. It consumes immutable crops and emits evidence
// that the next fresh visual observation can use, never a synthetic camera frame.
export class CardTextVerification {
  constructor(reader, { now = () => Date.now(), budget = TEXT_BUDGET_MS, requiredReads = 2 } = {}) {
    this.reader = reader; this.now = now; this.budget = budget; this.requiredReads = requiredReads;
    this.sequence = 0; this.trackSequence = 0; this.session = null; this.active = null;
  }
  reset(reason = 'recognition-reset') {
    this.photoAbort?.abort(); this.photoAbort = null;
    if (this.session) {
      emitScanDiagnostic('ocr-reset',{reason,sessionId:this.session.id,trackId:this.session.trackId});
      clearTimeout(this.session.timer); this.session.abort.abort(); this.session.queued = null;
    }
    this.session = null;
  }
  dispose() { this.reset(); this.reader.dispose?.(); }
  getGeometryHint({frame,context,capturedAt}) {
    const session=this.session;
    if(!session||session.conflict||session.context!==context||this.now()-session.lastSeenAt>1500||isScanFrameCancelled(frame)||
      !frame?.scanMotionContext||session.motionEpoch!==frame.scanMotionEpoch)return null;
    const read=session.reads.filter(r=>r.status==='confirmed'&&r.nameConfidence>=90&&r.codeConfidence>=90&&
      Number.isFinite(r.capturedAt)&&capturedAt>=r.capturedAt&&capturedAt-r.capturedAt<=this.budget).at(-1);
    return read?{cardId:read.cardId}:null;
  }
  expireAt(session, deadline) {
    clearTimeout(session.timer);session.deadline=deadline;
    session.timer=setTimeout(()=>{
      if(this.session!==session)return;
      emitScanDiagnostic('ocr-timeout',{sessionId:session.id,trackId:session.trackId});
      session.expired=true;session.queued=null;session.abort.abort();
    },Math.max(0,deadline-this.now()));
  }
  async verifyPhoto(crop, { hint, index, frameId, alternativeCrops = [] }) {
    this.reset();
    const abort = new AbortController(); this.photoAbort = abort;
    try {
      const result = await this.reader.read(crop, { hint, index, alternativeCrops, signal: abort.signal, deadline: this.now() + this.budget });
      if (abort.signal.aborted) return { status: 'unreadable', sourceFrameIds: [] };
      return { ...result, sourceFrameIds: result.status === 'confirmed' ? [frameId] : [] };
    } catch { return { status: 'unavailable', reason: 'ocr-unavailable', sourceFrameIds: [] }; }
    finally { if (this.photoAbort === abort) this.photoAbort = null; }
  }
  observe(observation, crop, { frame, context, index, candidates, minSimilarity = .9, photo = false, alternativeCrops = [], skipRead = false } = {}) {
    const now = this.now();
    if (isScanFrameCancelled(frame) || frame?.scanMoving || !observation.quality?.acceptable || !candidates?.length) {
      this.reset(); return { status: 'unreadable', reason: 'invalid-frame', sourceFrameIds: [] };
    }
    // The guide sample has fixed camera coordinates. A YOLO crop can move or
    // change shape while the physical card is still held in the same place.
    const motionEpoch=frame?.scanMotionContext&&Number.isInteger(frame.scanMotionEpoch)?frame.scanMotionEpoch:null;
    const fingerprintSource=motionEpoch!=null?'camera-motion':frame?.scanQuality?.fingerprint?.length?'camera-guide':'card-crop';
    const fingerprint = frame?.scanQuality?.fingerprint?.length?frame.scanQuality.fingerprint:observation.trackingFingerprint || observation.quality.fingerprint;
    const anchorId = hasLocalArtworkSupport(candidates[0]) ? candidates[0].card.id : null;
    let session = this.session;
    const changedReason = session && (session.context !== context ? 'context-changed' : now-session.lastSeenAt>1500 ? 'capture-gap' :
      session.fingerprintSource!==fingerprintSource ? 'tracking-source-changed' :
      session.motionEpoch!==motionEpoch ? 'camera-motion' :
      session.anchorId&&anchorId&&session.anchorId!==anchorId ? 'artwork-identity-changed' :
      motionEpoch==null&&frameDifference(session.fingerprint,fingerprint)>.1 ? 'scene-changed' :
      session.box&&observation.box&&Math.hypot(session.box.cx-observation.box.cx,session.box.cy-observation.box.cy)>Math.max(1,observation.box.h)*.18 ? 'card-moved' :
      !candidates.some(c=>session.candidateIds.includes(c.card.id)) ? 'visual-candidates-changed' : null);
    const changed=Boolean(changedReason);
    const previousVerdict=session&&this.verdict(session);
    const freshFrame=session&&observation.frameId!=null&&observation.frameId!==session.lastFrameId&&!session.attempts.has(observation.frameId)&&
      (observation.capturedAt==null||session.latest.observation.capturedAt==null||observation.capturedAt>session.latest.observation.capturedAt);
    const retry=session&&!session.conflict&&['unreadable','unavailable'].includes(previousVerdict.status)&&freshFrame&&
      now-session.startedAt>=this.budget+TEXT_RETRY_DELAY_MS;
    // Retrying text is not a new physical card. Keep the initial fallback
    // deadline and visual epoch; discard only this attempt's OCR evidence.
    const track = retry && !changed ? session : null;
    if (changed||retry) { this.reset(changedReason||'ocr-retry'); session = null; }
    const runeWeak=observation.visualVerification?.status==='rune-artwork'&&!observation.visualVerification.candidates.some(candidate=>
      hasRuneGeometry(observation.visualVerification,candidate.cardId,observation.frameId));
    if(runeWeak&&!session)return {status:'unreadable',reason:'rune-artwork-insufficient',sourceFrameIds:[]};
    if (!session) {
      session = { id: ++this.sequence, context, startedAt: now, lastSeenAt: now, reads: [], attempts: new Set(), queued: null,
        trackId: track?.trackId ?? ++this.trackSequence, trackStartedAt: track?.trackStartedAt ?? now,
        attemptNumber: track ? track.attemptNumber + 1 : 1,
        abort: new AbortController(), expired: false, fingerprint: track?.fingerprint ?? fingerprint, fingerprintSource,motionEpoch,
        box: track?.box ?? observation.box, anchorId: track?.anchorId ?? anchorId,
        candidateIds: track?.candidateIds ?? candidates.map((c) => c.card.id) };
      this.session = session;
      this.expireAt(session,now+this.budget);
      emitScanDiagnostic('ocr-attempt',{sessionId:session.id,trackId:session.trackId,attemptNumber:session.attemptNumber,frameId:observation.frameId});
    }
    session.latest = { observation, candidates, minSimilarity, photo };
    // Follow a continuous track, rather than comparing every hand-held pose
    // against its first detector rectangle forever. Abrupt scene/identity
    // changes and the camera buffer's independent motion guard still reset it.
    if(observation.frameId!==session.lastFrameId){
      session.fingerprint=fingerprint;session.box=observation.box;
      if(!session.anchorId&&anchorId)session.anchorId=anchorId;
    }
    session.lastFrameId=observation.frameId;
    session.lastSeenAt = now;
    if (now >= session.deadline) { session.expired = true; session.abort.abort(); session.queued = null; }
    const frameId = observation.frameId;
    if (!skipRead && !runeWeak && !session.expired && !session.error && !session.conflict && this.verdict(session).status !== 'confirmed' && frameId != null && !session.attempts.has(frameId)) {
      session.queued = { frameId, capturedAt: observation.capturedAt, crop, alternativeCrops, frame, index, hint: candidates[0].card,
        runeArtwork:observation.visualVerification?.status==='rune-artwork'?observation.visualVerification:null };
      this.pump();
    }
    return this.verdict(session);
  }
  pump() {
    const session = this.session;
    if (this.active || !session?.queued || session.expired || session.error || session.conflict || this.verdict(session).status === 'confirmed') return;
    const job = session.queued; session.queued = null;
    session.attempts.add(job.frameId);
    const startedAt=this.now();
    emitScanDiagnostic('ocr-start',{sessionId:session.id,trackId:session.trackId,frameId:job.frameId,capturedAt:job.capturedAt});
    const token = {}; this.active = token;
    Promise.resolve().then(() => this.reader.read(job.crop, { index: job.index, hint: job.hint, alternativeCrops: job.alternativeCrops,
      runeArtwork:job.runeArtwork,signal: session.abort.signal, deadline: session.deadline })).then((result) => {
      if (this.session !== session || session.expired || session.abort.signal.aborted || isScanFrameCancelled(job.frame) || this.now() >= session.deadline) {
        emitScanDiagnostic('ocr-discarded',{sessionId:session.id,trackId:session.trackId,frameId:job.frameId});return;
      }
      if(result.evidenceType==='rune-name-set-artwork'&&result.artworkSourceFrameId!==job.frameId)return;
      session.reads.push({ ...result, sourceFrameId: job.frameId, capturedAt: job.capturedAt, ocrMs: this.now()-startedAt });
      // The initial two-second artwork fallback is unchanged. A successful
      // first text reading gets one bounded handoff for the independent second
      // source, instead of aborting it and destroying a warmed OCR worker.
      if(result.status==='confirmed'&&!session.confirmationWindow){
        session.confirmationWindow=true;
        this.expireAt(session,Math.min(session.startedAt+this.budget*2,this.now()+this.budget));
        emitScanDiagnostic('ocr-confirmation-window',{sessionId:session.id,trackId:session.trackId,deadline:session.deadline});
      }
      emitScanDiagnostic('ocr-result',{sessionId:session.id,trackId:session.trackId,frameId:job.frameId,durationMs:this.now()-startedAt,
        reading:{status:result.status,reason:result.reason,cardId:result.cardId,name:result.name,code:result.code,readSet:result.readSet,setConfidence:result.setConfidence,evidenceType:result.evidenceType,
          nameConfidence:result.nameConfidence,codeConfidence:result.codeConfidence,textLayout:result.textLayout,textCropMethod:result.textCropMethod}});
    }).catch((error) => {
      if (this.session === session && !session.abort.signal.aborted) session.error = 'ocr-unavailable';
      emitScanDiagnostic('ocr-error',{sessionId:session.id,trackId:session.trackId,frameId:job.frameId,error:String(error?.message||error)});
    }).finally(() => {
      if (this.active === token) this.active = null;
      this.pump();
    });
  }
  verdict(session = this.session) {
    if (!session) return { status: 'unreadable', sourceFrameIds: [] };
    if (session.conflict) return { ...session.conflict, status: 'conflict', reason: 'text-conflict', sourceFrameIds: [], sessionId: session.id, trackId: session.trackId };
    const { observation, candidates, photo } = session.latest;
    const reads = session.reads.filter((read) => observation.capturedAt == null || read.capturedAt == null ||
      (observation.capturedAt >= read.capturedAt && observation.capturedAt - read.capturedAt <= this.budget*2));
    const latest = reads.at(-1);
    const common = { ...latest, sessionId: session.id, trackId: session.trackId, sourceFrameIds: [], completedReads: reads.length,
      budgetMs: this.budget, startedAt: session.startedAt, trackStartedAt: session.trackStartedAt,
      deadline:session.deadline,confirmationWindowMs:session.confirmationWindow?this.budget:0,evidenceWindowMs:this.budget*2,
      trackingFingerprintSource:session.fingerprintSource,
      motionEpoch:session.motionEpoch,
      attemptNumber: session.attemptNumber, trackAgeMs: this.now()-session.trackStartedAt,
      artworkFallbackAllowed: this.now() - session.trackStartedAt >= this.budget || Boolean(session.error) };
    const allConfirmed = reads.filter((read) => read.status === 'confirmed');
    const evidenceType=allConfirmed.at(-1)?.evidenceType;
    const confirmed=allConfirmed.filter(read=>read.evidenceType===evidenceType);
    const ids = new Set(allConfirmed.map((r) => r.cardId));
    const target = ids.size === 1 ? confirmed[0]?.cardId : null;
    const candidate = candidates.find((entry) => entry.card.id === target);
    const intrinsicConflict = reads.some((read) => read.status === 'conflict') || ids.size > 1;
    const contradictory = reads.some((read) =>
      (read.codeCardId && read.codeCardId !== observation.cardData?.id && read.status !== 'confirmed') ||
      (read.nameCardIds?.length && !read.nameCardIds.includes(observation.cardData?.id) && read.status !== 'confirmed'));
    // Agreement about identity and visual eligibility are separate decisions.
    // A low artwork score is not evidence that the printed text disagrees.
    if (intrinsicConflict) {
      session.conflict = common;
      return { ...common, status: 'conflict', reason: 'text-conflict' };
    }
    // A provisional visual candidate can change while the printed identity is
    // stable. Reevaluate that disagreement against every fresh visual frame;
    // only contradictions between the text readings themselves are sticky.
    if (contradictory || (target && !candidate)) return { ...common, status: 'conflict', reason: 'text-conflict' };
    const lastConfirmed=confirmed.at(-1);
    const recent=lastConfirmed&&(observation.capturedAt==null||lastConfirmed.capturedAt==null||observation.capturedAt-lastConfirmed.capturedAt<=this.budget);
    const pair=recent?confirmed.filter(r=>r.cardId===target&&(r.capturedAt==null||lastConfirmed.capturedAt==null||lastConfirmed.capturedAt-r.capturedAt<=this.budget)):[];
    const sourceFrameIds = [...new Set(pair.map(r=>r.sourceFrameId))];
    common.confirmedReads=sourceFrameIds.length;common.requiredReads=photo?1:this.requiredReads;
    if (target && sourceFrameIds.length >= (photo ? 1 : this.requiredReads)) return { ...common, ...lastConfirmed, status: 'confirmed', cardId: target, sourceFrameIds,
      ...(evidenceType==='rune-name-set-artwork'?{sourceArtwork:pair.map(read=>({frameId:read.sourceFrameId,proof:read.artworkProof}))}:{}) };
    if (session.error) return { ...common, status: 'unavailable', reason: session.error };
    if (session.expired) return { ...common, status: 'unreadable', reason: latest?.reason || 'text-unreadable' };
    return { ...common, status: 'pending', reason: 'reading-text' };
  }
}
