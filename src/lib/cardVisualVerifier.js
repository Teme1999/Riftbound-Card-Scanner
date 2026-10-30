import { resolveCardImageSource, filterCardsBySet } from './cardMatcher.js';
import { resolveAppUrl } from './runtime.js';
import { matchFromRanking } from './cardRecognition.js';
import { selectVisualProof, visualIdentityAmbiguities, strongVisualGeometry } from './cardVisualProof.js';
import { buildRuneArtworkProof } from './cardRuneVerification.js';
import { normalizeCardName } from './cardTextIdentity.js';

export class CardVisualVerifier {
  constructor({createWorker=()=>new Worker(new URL('../workers/cardVisual.worker.js',import.meta.url),{type:'module'})}={}) {
    this.createWorker=createWorker;this.worker=null;this.pending=null;this.sequence=0;this.ready=false;this.ambiguities=new Map();
  }
  dispose(){this.pending?.finish(null);this.worker?.terminate();this.worker=null;this.ready=false;this.warming=null;}
  request(data,timeout){
    if(this.pending)return Promise.resolve(null);
    return new Promise(resolve=>{
      const id=++this.sequence;
      const finish=value=>{clearTimeout(timer);if(this.pending?.id===id)this.pending=null;resolve(value);};
      const timer=setTimeout(()=>{finish(null);this.dispose();},timeout);
      this.pending={id,finish};
      this.worker.onmessage=({data:value})=>{if(this.pending?.id===value.id)finish(value);};
      this.worker.onerror=()=>{if(this.pending?.id!==id)return;finish(null);this.dispose();};
      try{this.worker.postMessage({...data,id},[data.image,data.topImage].filter(Boolean).map(image=>image.data.buffer));}catch{finish(null);this.dispose();}
    });
  }
  ensureReady(){
    if(this.ready)return Promise.resolve(true);
    if(this.warming)return this.warming;
    try{this.worker ||= this.createWorker();}catch{return Promise.resolve(false);}
    const owned=this.worker;
    this.warming=this.request({type:'warm'},10000).then(reply=>{if(this.worker!==owned)return false;this.ready=reply?.ready===true;return this.ready;});
    return this.warming;
  }
  async verify(crop,{matcher,setFilter,frameId}={}){
    if(!this.ready){void this.ensureReady();return {proof:{status:'unavailable',reason:'visual-worker-loading'}};}
    if(this.pending)return {proof:{status:'unavailable',reason:'visual-worker-busy'}};
    if(this.cards!==matcher.cards){this.cards=matcher.cards;this.ambiguities.clear();}
    // One cheap global search replaces repeated local alignment/homography
    // searches only AFTER independent keypoint geometry has verified identity.
    let ranked=matcher.rank(crop,{setFilter,limit:8,areaSampling:true,localStructure:true,alignLocal:false});
    if(ranked.length<2)return {proof:{status:'unconfirmed',reason:'insufficient-candidates'}};
    const canvas=document.createElement('canvas');canvas.width=432;canvas.height=336;
    const ctx=canvas.getContext('2d',{willReadFrequently:true});
    ctx.drawImage(crop,Math.round(crop.width*.05),Math.round(crop.height*.05),Math.round(crop.width*.9),Math.round(crop.height*.5),0,0,432,336);
    const compare=(entries,rune=false)=>{
      let image=ctx.getImageData(0,0,432,336),topImage;
      if(rune){const full=document.createElement('canvas');full.width=432;full.height=600;const fullContext=full.getContext('2d',{willReadFrequently:true});
        fullContext.drawImage(crop,Math.round(crop.width*.05),Math.round(crop.height*.05),Math.round(crop.width*.9),Math.round(crop.height*.86),0,0,432,600);
        topImage=image;image=fullContext.getImageData(0,0,432,600);}
      return this.request({type:'verify',rune,image,topImage,candidates:entries.map(entry=>({id:entry.card.id,
      fallbackUrl:resolveAppUrl(`/cards/${encodeURIComponent(entry.card.id)}.webp`),
      url:resolveCardImageSource(entry.card.imageUrl,entry.card.id),key:`${entry.card.id}:${matcher.revision||0}:${resolveCardImageSource(entry.card.imageUrl,entry.card.id)}`}))},rune?1000:500);
    };
    const reply=await compare(ranked);
    if(!reply?.comparisons)return {proof:{status:'unavailable',reason:reply?.error?'visual-worker-error':'visual-worker-timeout',
      workerError:reply?.error,referenceId:reply?.referenceId}};
    const best=[...reply.comparisons].sort((a,b)=>b.inliers-a.inliers)[0];
    const winner=ranked.find(entry=>entry.card.id===best?.id);
    if(!winner)return {proof:{status:'unconfirmed',reason:'no-visual-match'}};
    if(winner.card.type==='rune'){
      const family=matcher.cards.filter(card=>card.type==='rune'&&normalizeCardName(card.name)===normalizeCardName(winner.card.name));
      if(family.length>12)return {proof:{status:'unconfirmed',reason:'rune-family-too-large'}};
      const familyRanked=matcher.rank(crop,{requiredIds:family.map(c=>c.id),areaSampling:true,localStructure:false});
      const runeReply=await compare(familyRanked,true);
      if(!runeReply?.comparisons)return {proof:{status:'unavailable',reason:'rune-worker-unavailable',workerError:runeReply?.error,referenceId:runeReply?.referenceId}};
      const proof={...buildRuneArtworkProof(runeReply.comparisons,family,frameId),workerMs:reply.workerMs+runeReply.workerMs,
        fallbackReferenceIds:runeReply.fallbackReferenceIds};
      const allowed=new Set(filterCardsBySet(family,setFilter).map(card=>card.id));
      const identityProof=selectVisualProof(runeReply.comparisons,{frameId,uniqueIdentity:proof.completeFamily});
      const identity=familyRanked.find(entry=>entry.card.id===identityProof.cardId);
      if(identityProof.status==='verified'&&identity&&allowed.has(identity.card.id)&&
        visualIdentityAmbiguities(identity.card,matcher.cards).every(id=>family.some(card=>card.id===id))){
        const runner=Math.max(0,...runeReply.comparisons.filter(c=>c.id!==identity.card.id).map(c=>c.maxInliers??c.inliers),
          ...reply.comparisons.filter(c=>c.id!==identity.card.id).map(c=>c.inliers));
        if(identityProof.inliers-runner>=20&&identityProof.inliers>=Math.max(1,runner)*2){
          return {proof:{...identityProof,runnerInliers:runner,workerMs:proof.workerMs,fallbackReferenceIds:proof.fallbackReferenceIds,
            printingReferenceIds:family.filter(card=>card.id!==identity.card.id).map(card=>card.id),printingIdentity:'compared'},
            match:matchFromRanking([identity,...familyRanked.filter(entry=>entry!==identity)])};
        }
      }
      const entries=familyRanked.filter(entry=>allowed.has(entry.card.id)).sort((a,b)=>Number(proof.candidates.find(c=>c.cardId===b.card.id)?.verified)-Number(proof.candidates.find(c=>c.cardId===a.card.id)?.verified)||
        (runeReply.comparisons.find(c=>c.id===b.card.id)?.inliers||0)-(runeReply.comparisons.find(c=>c.id===a.card.id)?.inliers||0));
      return {proof,runeMatch:entries.some(entry=>proof.candidates.find(c=>c.cardId===entry.card.id)?.verified)?matchFromRanking(entries):null};
    }
    if(!this.ambiguities.has(winner.card.id))this.ambiguities.set(winner.card.id,visualIdentityAmbiguities(winner.card,matcher.cards));
    const ambiguousIds=this.ambiguities.get(winner.card.id);
    let verifiedReply=reply,verifiedRanked=ranked,identityComplete=ambiguousIds.length===0;
    if(ambiguousIds.length&&ambiguousIds.length<=24&&strongVisualGeometry(best)){
      // A shared name is a request to compare printings, not proof that their
      // illustrations are identical. Include rivals hidden by the set filter.
      const requiredIds=[...new Set([...ranked.map(entry=>entry.card.id),...ambiguousIds])];
      if(!requiredIds.every(id=>reply.comparisons.some(c=>c.id===id))){
        const expanded=matcher.rank(crop,{requiredIds,areaSampling:true,localStructure:false});
        if(requiredIds.every(id=>expanded.some(entry=>entry.card.id===id))){
          const expandedReply=await compare(expanded);
          if(expandedReply?.comparisons){verifiedReply=expandedReply;verifiedRanked=expanded.map(entry=>ranked.find(old=>old.card.id===entry.card.id)||entry);}
          else return {proof:{status:'unavailable',reason:'printing-worker-unavailable',workerError:expandedReply?.error,referenceId:expandedReply?.referenceId}};
        }
      }
      const resolved=verifiedRanked.find(entry=>entry.card.id===[...verifiedReply.comparisons].sort((a,b)=>b.inliers-a.inliers)[0]?.id);
      identityComplete=Boolean(resolved&&requiredIds.every(id=>verifiedReply.comparisons.some(c=>c.id===id))&&
        visualIdentityAmbiguities(resolved.card,matcher.cards).every(id=>verifiedReply.comparisons.some(c=>c.id===id))&&
        filterCardsBySet([resolved.card],setFilter).length);
    }
    const proof={...selectVisualProof(verifiedReply.comparisons,{frameId,uniqueIdentity:identityComplete}),
      workerMs:reply.workerMs+(verifiedReply===reply?0:verifiedReply.workerMs),
      ...(ambiguousIds.length?{printingReferenceIds:ambiguousIds,printingIdentity:identityComplete?'compared':'unresolved'}:{}),
      fallbackReferenceIds:verifiedReply.fallbackReferenceIds};
    if(ambiguousIds.length&&proof.status!=='verified')proof.reason='printing-needs-text';
    if(proof.status!=='verified')return {proof};
    const resolved=verifiedRanked.find(entry=>entry.card.id===proof.cardId);
    const entries=[resolved,...verifiedRanked.filter(entry=>entry!==resolved)];
    const match=matchFromRanking(entries.map(entry=>({...entry,secondBestSim:entry.secondBestSim ?? Math.max(0,...verifiedRanked.filter(other=>other!==entry).map(other=>other.similarity))})));
    return {proof,match};
  }
}
