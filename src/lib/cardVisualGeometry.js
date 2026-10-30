// OpenCV objects stay inside the worker. Every temporary Mat/vector is released;
// cached descriptors have an explicit LRU owner. No camera pixels are persisted.
export function createVisualGeometry(cv, { fullRune = false } = {}) {
  const width = 432, height = fullRune ? 600 : 336;
  const orb = new cv.ORB(700, 1.2, 8, 12, 0, 2, cv.ORB_HARRIS_SCORE, 31, 12);
  const matcher = new cv.BFMatcher(cv.NORM_HAMMING, false);
  const area = points => Math.abs(points.reduce((sum, p, i) => {
    const q = points[(i + 1) % points.length]; return sum + p.x * q.y - p.y * q.x;
  }, 0)) / 2;
  const hullArea = points => {
    const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
    const cross = (o, a, b) => (a.x-o.x)*(b.y-o.y)-(a.y-o.y)*(b.x-o.x);
    const half = values => { const out=[];for(const p of values){while(out.length>1&&cross(out.at(-2),out.at(-1),p)<=0)out.pop();out.push(p);}return out; };
    const lower=half(sorted),upper=half(sorted.reverse());return area([...lower.slice(0,-1),...upper.slice(0,-1)]);
  };
  const registeredArtwork = (source,reference,homography) => {
    const aligned=new cv.Mat(),valid=new cv.Mat();
    const cell=()=>({n:0,x:0,y:0,xx:0,yy:0,xy:0}),total=cell(),tiles=Array.from({length:16},cell);
    const add=(s,x,y)=>{s.n++;s.x+=x;s.y+=y;s.xx+=x*x;s.yy+=y*y;s.xy+=x*y;};
    const correlation=s=>{const vx=s.xx-s.x*s.x/Math.max(1,s.n),vy=s.yy-s.y*s.y/Math.max(1,s.n);
      return vx>0&&vy>0?(s.xy-s.x*s.y/s.n)/Math.sqrt(vx*vy):0;};
    try{
      cv.warpPerspective(source.image,aligned,homography,new cv.Size(width,height),cv.INTER_LINEAR);
      cv.warpPerspective(source.mask,valid,homography,new cv.Size(width,height),cv.INTER_NEAREST);
      let possible=0;
      for(let y=25;y<575;y+=3)for(let x=35;x<397;x+=3){
        const i=y*width+x;if(!reference.mask.data[i])continue;
        const b=reference.image.data[i];if(b<8||b>247)continue;possible++;
        if(!valid.data[i])continue;
        const a=aligned.data[i];if(a<8||a>247)continue;
        add(total,a,b);const row=Math.min(3,Math.floor((y-25)/550*4)),col=Math.min(3,Math.floor((x-35)/362*4));add(tiles[row*4+col],a,b);
      }
      const textured=tiles.map((s,i)=>({...s,i})).filter(s=>s.n>=100&&s.xx/s.n-(s.x/s.n)**2>=16&&s.yy/s.n-(s.y/s.n)**2>=16);
      const matched=textured.filter(s=>correlation(s)>=.8);
      return {correlation:correlation(total),validCoverage:total.n/Math.max(1,possible),tilesCompared:textured.length,tilesMatched:matched.length,
        outerTilesMatched:matched.filter(s=>s.i%4===0||s.i%4===3).length,columnsMatched:new Set(matched.map(s=>s.i%4)).size,
        rowsMatched:new Set(matched.map(s=>Math.floor(s.i/4))).size};
    }finally{aligned.delete();valid.delete();}
  };
  const extract = (image, { rune = false } = {}) => {
    const pixels = cv.matFromImageData(image), gray = new cv.Mat();
    // The .05-.55 card crop still contains the cost, might and frame. Those
    // shared graphics can produce dozens of geometrically perfect WRONG
    // matches. Keep both keypoints AND their descriptor patches inside art.
    const mask = cv.Mat.zeros(height,width,cv.CV_8UC1);
    const keys = new cv.KeyPointVector(), descriptors = new cv.Mat();
    let retainedImage,validMask;
    try {
      cv.rectangle(mask,new cv.Point(35,fullRune||rune ? 25 : 94),new cv.Point(397,fullRune ? 575 : 302),new cv.Scalar(255),-1);
      // Runes have illustration below the ordinary unit-art box. Exclude the
      // title strip, type ornament, frame and collector text from this view.
      if(fullRune)cv.rectangle(mask,new cv.Point(0,400),new cv.Point(width,515),new cv.Scalar(0),-1);
      cv.cvtColor(pixels, gray, cv.COLOR_RGBA2GRAY); orb.detectAndCompute(gray, mask, keys, descriptors);
      const points = Array.from({ length: keys.size() }, (_, i) => ({ ...keys.get(i).pt }));
      retainedImage=fullRune?gray.clone():null;validMask=fullRune?mask.clone():null;
      return { points, descriptors, rune, fullRune,image:retainedImage,mask:validMask,dispose: () => {descriptors.delete();retainedImage?.delete();validMask?.delete();} };
    } catch (error) { descriptors.delete();retainedImage?.delete();validMask?.delete();throw error; }
    finally { pixels.delete();gray.delete();mask.delete();keys.delete(); }
  };
  const compare = (source, reference, id) => {
    const empty = { id, good: 0, inliers: 0 };
    if (source.points.length < 32 || reference.points.length < 32) return empty;
    const pairs = new cv.DMatchVectorVector(), mask = new cv.Mat();
    let a, b, homography;
    try {
      matcher.knnMatch(source.descriptors, reference.descriptors, pairs, 2);
      const matches = [];
      for (let i=0;i<pairs.size();i++) {
        const pair=pairs.get(i);
        try { if(pair.size()>=2){const m=pair.get(0),n=pair.get(1);if(m.distance<.72*n.distance&&m.distance<=55)matches.push({queryIdx:m.queryIdx,trainIdx:m.trainIdx,distance:m.distance});} }
        finally { pair.delete(); }
      }
      const seen=new Set(),good=matches.sort((x,y)=>x.distance-y.distance).filter(m=>{if(seen.has(m.trainIdx))return false;seen.add(m.trainIdx);return true;});
      if(good.length<8)return {...empty,good:good.length};
      a=cv.matFromArray(good.length,1,cv.CV_32FC2,good.flatMap(m=>{const p=source.points[m.queryIdx];return[p.x,p.y];}));
      b=cv.matFromArray(good.length,1,cv.CV_32FC2,good.flatMap(m=>{const p=reference.points[m.trainIdx];return[p.x,p.y];}));
      cv.setRNGSeed(1827);
      homography=cv.findHomography(a,b,cv.RANSAC,3,mask,1000,.995);
      if(homography.empty())return {...empty,good:good.length};
      const h=homography.data64F;
      const project=p=>{const z=h[6]*p.x+h[7]*p.y+h[8];return{x:(h[0]*p.x+h[1]*p.y+h[2])/z,y:(h[3]*p.x+h[4]*p.y+h[5])/z};};
      const inside=[],targets=[],errors=[];
      good.forEach((m,i)=>{if(mask.data[i]){const p=source.points[m.queryIdx],q=reference.points[m.trainIdx],v=project(p);inside.push(p);targets.push(q);errors.push(Math.hypot(v.x-q.x,v.y-q.y));}});
      if(inside.length<4)return {...empty,good:good.length};
      const corners=[{x:0,y:0},{x:width,y:0},{x:width,y:height},{x:0,y:height}].map(project);
      const crosses=corners.map((p,i)=>{const q=corners[(i+1)%4],r=corners[(i+2)%4];return(q.x-p.x)*(r.y-q.y)-(q.y-p.y)*(r.x-q.x);});
      const projectedArea=area(corners)/(width*height);
      const validProjection=corners.every(p=>Number.isFinite(p.x+p.y)&&p.x>=-width&&p.x<=width*2&&p.y>=-height&&p.y<=height*2)&&
        crosses.every(v=>v>0)&&projectedArea>=.3&&projectedArea<=2.5;
      errors.sort((x,y)=>x-y);
      const span=(key,size)=>(Math.max(...inside.map(p=>p[key]))-Math.min(...inside.map(p=>p[key])))/size;
      const maskHeight = source.fullRune ? 550 : source.rune ? 277 : 208;
      return {id,good:good.length,inliers:inside.length,ratio:inside.length/good.length,
        coverage:hullArea(inside)/(362*maskHeight),referenceCoverage:hullArea(targets)/(362*maskHeight),
        spanX:span('x',362),spanY:span('y',maskHeight),error:errors[Math.floor(errors.length/2)],validProjection,
        ...(fullRune&&validProjection?{registeredArtwork:registeredArtwork(source,reference,homography),homography:Array.from(h)}:{})};
    } finally {pairs.delete();mask.delete();a?.delete();b?.delete();homography?.delete();}
  };
  return {extract,compare,dispose(){orb.delete();matcher.delete();}};
}
