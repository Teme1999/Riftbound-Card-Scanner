import cv from '@techstark/opencv-js';
import { createVisualGeometry } from '../lib/cardVisualGeometry.js';
import { strongVisualGeometry } from '../lib/cardVisualProof.js';
import { loadVisualReference } from '../lib/cardVisualReference.js';

// OpenCV 4's module is a thenable, not a Promise. Awaiting it directly can
// recursively assimilate the module forever. Resolve readiness without a value.
const ready = new Promise(resolve => { if(cv.Mat)resolve();else cv.onRuntimeInitialized=()=>resolve(); });
let engine,fullRuneEngine;
const references = new Map();
async function reference(entry, rune, fullRune=false) {
  const key=(entry.key || entry.url)+':'+Boolean(rune)+':'+fullRune,previous=references.get(key);
  if(previous){references.delete(key);references.set(key,previous);return previous;}
  const {bitmap,source}=await loadVisualReference(entry);
  try {
    const height=fullRune?600:336,canvas=new OffscreenCanvas(432,height),ctx=canvas.getContext('2d',{willReadFrequently:true});
    ctx.drawImage(bitmap,Math.round(bitmap.width*.05),Math.round(bitmap.height*.05),Math.round(bitmap.width*.9),Math.round(bitmap.height*(fullRune ? .86 : .5)),0,0,432,height);
    const value=(fullRune?fullRuneEngine:engine).extract(ctx.getImageData(0,0,432,height),{rune});value.referenceSource=source;references.set(key,value);
    while(references.size>96){const [old,item]=references.entries().next().value;item.dispose();references.delete(old);}
    return value;
  } finally {bitmap.close();}
}
self.onmessage=async({data})=>{
  let source,alternate,top;
  try {
    await ready;engine ||= createVisualGeometry(cv);
    if(data.type==='warm'){self.postMessage({id:data.id,ready:true});return;}
    const start=performance.now();
    const fullRune=Boolean(data.rune&&data.topImage);
    if(fullRune)fullRuneEngine ||= createVisualGeometry(cv,{fullRune:true});
    const owned=fullRune?fullRuneEngine:engine;
    // Prepare references concurrently; the descriptor comparisons themselves
    // are serial and deterministic. The caller owns the one-job queue.
    const refs=await Promise.all(data.candidates.map(async entry=>({entry,value:await reference(entry,data.rune,fullRune)})));
    source=owned.extract(data.image,{rune:data.rune});
    let comparisons=refs.map(({entry,value})=>({...owned.compare(source,value,entry.id),layout:fullRune?'rune-full':'interior'}));
    if(data.rune){
      alternate=engine.extract(data.topImage||data.image);
      const originalRefs=await Promise.all(data.candidates.map(async entry=>({entry,value:await reference(entry,false)})));
      const original=originalRefs.map(({entry,value})=>engine.compare(alternate,value,entry.id));
      let expanded=[];
      if(fullRune){
        top=engine.extract(data.topImage,{rune:true});
        const topRefs=await Promise.all(data.candidates.map(async entry=>({entry,value:await reference(entry,true)})));
        expanded=topRefs.map(({entry,value})=>({...engine.compare(top,value,entry.id),layout:'rune-top'}));
      }
      comparisons=comparisons.map(value=>{
        const other=original.find(c=>c.id===value.id);
        const choices=[value,other,expanded.find(c=>c.id===value.id)].filter(Boolean).sort((a,b)=>Number(strongVisualGeometry(b))-Number(strongVisualGeometry(a))||b.inliers-a.inliers);
        return {...choices[0],maxInliers:Math.max(...choices.map(c=>c.inliers)),
          registeredGeometry:fullRune?value:undefined,registeredArtwork:value.registeredArtwork};
      });
    }
    self.postMessage({id:data.id,comparisons,workerMs:performance.now()-start,
      fallbackReferenceIds:refs.filter(ref=>ref.value.referenceSource==='bundled-fallback').map(ref=>ref.entry.id)});
  }catch(error){self.postMessage({id:data.id,error:String(error?.message||error),referenceId:error?.referenceId});}
  finally{source?.dispose();alternate?.dispose();top?.dispose();}
};
