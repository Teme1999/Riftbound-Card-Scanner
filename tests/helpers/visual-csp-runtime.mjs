import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createVisualGeometry } from '../../src/lib/cardVisualGeometry.js';
import { strongVisualGeometry } from '../../src/lib/cardVisualProof.js';

export async function verifyVisualRuntime(cv) {
  await new Promise(resolve=>{if(cv.Mat)resolve();else cv.onRuntimeInitialized=()=>resolve();});
  const engine=createVisualGeometry(cv),runeEngine=createVisualGeometry(cv,{fullRune:true}),resources=[];
  try{
    const make=seed=>{
      const image=new cv.Mat(336,432,cv.CV_8UC4,new cv.Scalar(30,30,30,255));resources.push(image);
      const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
      for(let i=0;i<140;i++){const x=Math.floor(random()*400),y=Math.floor(random()*305),color=40+random()*210;
        cv.rectangle(image,new cv.Point(x,y),new cv.Point(x+5+random()*25,y+5+random()*25),new cv.Scalar(color,color,color,255),i%3===0?-1:2);}
      // Deliberately shared card graphics around different illustrations.
      for(const [x,y] of [[5,10],[330,10],[5,307],[330,307]])cv.putText(image,'4',new cv.Point(x,y+20),cv.FONT_HERSHEY_SIMPLEX,1,new cv.Scalar(230,230,230,255),2);
      return image;
    };
    const reference=make(1881),unrelated=make(731),warped=new cv.Mat(),h=cv.matFromArray(3,3,cv.CV_64F,[.94,.025,9,-.025,.94,14,-.00004,.00007,1]);resources.push(warped,h);
    cv.warpPerspective(reference,warped,h,new cv.Size(432,336));
    const extract=mat=>{const value=engine.extract({data:new Uint8ClampedArray(mat.data),width:432,height:336});resources.push({delete:()=>value.dispose()});return value;};
    const source=extract(warped),same=engine.compare(source,extract(reference),'same'),wrong=engine.compare(source,extract(unrelated),'wrong');
    assert.equal(strongVisualGeometry(same),true,JSON.stringify(same));
    assert.equal(strongVisualGeometry(wrong),false,JSON.stringify(wrong));
    const rune=new cv.Mat(600,432,cv.CV_8UC4,new cv.Scalar(40,40,40,255));resources.push(rune);
    for(let y=30;y<580;y+=23)for(let x=40;x<395;x+=29){const shade=60+(x*7+y*11)%180;
      cv.rectangle(rune,new cv.Point(x,y),new cv.Point(x+11+(y%9),y+9+(x%7)),new cv.Scalar(shade,shade,shade,255),2);}
    cv.putText(rune,'EXCLUDED TITLE',new cv.Point(20,460),cv.FONT_HERSHEY_SIMPLEX,1,new cv.Scalar(240,240,240,255),2);
    const runeWarped=new cv.Mat();resources.push(runeWarped);cv.warpPerspective(rune,runeWarped,h,new cv.Size(432,600));
    const extractRune=mat=>{const value=runeEngine.extract({data:new Uint8ClampedArray(mat.data),width:432,height:600});resources.push({delete:()=>value.dispose()});return value;};
    const runeReference=extractRune(rune),runeSource=extractRune(runeWarped),runeMatch=runeEngine.compare(runeSource,runeReference,'rune');
    assert.ok(runeReference.points.every(p=>p.y<400||p.y>515),'Rune title/type strip is excluded');
    assert.ok(runeMatch.registeredArtwork.correlation>.9,JSON.stringify(runeMatch));
    assert.ok(runeMatch.registeredArtwork.outerTilesMatched>=4,JSON.stringify(runeMatch));
    // Intrinsic white illustration areas are not lost camera pixels. They
    // cannot contribute texture, but must not penalize an otherwise valid crop.
    cv.rectangle(rune,new cv.Point(140,30),new cv.Point(395,395),new cv.Scalar(255,255,255,255),-1);
    const bright=extractRune(rune),brightMatch=runeEngine.compare(bright,bright,'white-heavy-rune');
    assert.ok(brightMatch.registeredArtwork.validCoverage>.98,JSON.stringify(brightMatch));
    return {inliers:same.inliers,wrongInliers:wrong.inliers,runeInliers:runeMatch.inliers,runeCorrelation:runeMatch.registeredArtwork.correlation};
  }finally{resources.reverse().forEach(resource=>resource.delete());engine.dispose();runeEngine.dispose();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const cv=createRequire(import.meta.url)(process.argv[2]);console.log(JSON.stringify(await verifyVisualRuntime(cv)));
}
