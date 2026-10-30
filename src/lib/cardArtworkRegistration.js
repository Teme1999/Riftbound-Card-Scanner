import { cardHomography, projectCardPoint, validCardQuad, warpCard } from './cardPerspective.js';

export function registeredCardQuad(matrix, original, padded) {
  if(matrix?.length!==9||!matrix.every(Number.isFinite))return null;
  const [a,b,c,d,e,f,g,h,i]=matrix,det=a*(e*i-f*h)-b*(d*i-f*g)+c*(d*h-e*g);
  if(Math.abs(det)<1e-10)return null;
  const inverse=[e*i-f*h,c*h-b*i,b*f-c*e,f*g-d*i,a*i-c*g,c*d-a*f,d*h-e*g,b*g-a*h,a*e-b*d].map(v=>v/det);
  const quad=[[0,0],[1,0],[1,1],[0,1]].map(([u,v])=>{
    const x=(u-.05)/.9*432,y=(v-.05)/.86*600,z=inverse[6]*x+inverse[7]*y+inverse[8];
    return {x:Math.round(original.width*.05)+(inverse[0]*x+inverse[1]*y+inverse[2])/z*Math.round(original.width*.9)/432+(padded.width-original.width)/2,
      y:Math.round(original.height*.05)+(inverse[3]*x+inverse[4]*y+inverse[5])/z*Math.round(original.height*.86)/600+(padded.height-original.height)/2};
  });
  return validCardQuad(quad,padded,original.width*original.height)?quad:null;
}

export function rectifyArtworkTextCrop(padded, original, geometry) {
  if(!geometry?.validProjection||geometry.inliers<16||geometry.error>1.5)return null;
  const quad=registeredCardQuad(geometry.homography,original,padded);if(!quad)return null;
  const ctx=padded.getContext('2d',{willReadFrequently:true});
  const image=warpCard(ctx.getImageData(0,0,padded.width,padded.height),quad,Math.min(720,original.width));
  if(!image)return null;
  const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
  const dest=canvas.getContext('2d'),pixels=dest.createImageData(image.width,image.height);pixels.data.set(image.data);dest.putImageData(pixels,0,0);
  canvas.scanRegistration={matrix:cardHomography(quad)};return canvas;
}

// OCR may resample for readability, but that must not create source pixels.
export function nativeRegistrationScale(canvas,region) {
  const matrix=canvas.scanRegistration?.matrix;if(!matrix)return 1;
  let scale=1;
  for(const u of [region.x,region.x+region.width/2,region.x+region.width])for(const v of [region.y,region.y+region.height/2,region.y+region.height]){
    const p=projectCardPoint(matrix,u,v),q=projectCardPoint(matrix,u,v+1/Math.max(1,canvas.height-1));
    scale=Math.min(scale,Math.hypot(q.x-p.x,q.y-p.y));
  }
  return Number.isFinite(scale)&&scale>0?scale:0;
}
