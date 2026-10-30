export function textRows({data,width,height}, padding=2, maxLines=1, expectedCenter=null) {
  const transitions=new Uint32Array(height);let peak=0;
  for(let y=0;y<height;y++){
    for(const level of [64,128,192,224]){
      let count=0;
      for(let x=1;x<width;x++)if((data[(y*width+x-1)*4]<level)!==(data[(y*width+x)*4]<level))count++;
      transitions[y]=Math.max(transitions[y],count);
    }
    peak=Math.max(peak,transitions[y]);
  }
  if(peak<10)return{top:0,height};
  const groups=[];
  for(let y=0;y<height;y++)if(transitions[y]>=Math.max(8,peak*.35)){
    let group=groups.at(-1);
    if(!group||y-group.bottom>Math.max(2,padding)){group={top:y,bottom:y,score:0};groups.push(group);}
    group.bottom=y;group.score+=transitions[y];
  }
  const score=g=>g.score*Math.sqrt(g.bottom-g.top+1)*(expectedCenter==null?1:.1+.9*Math.exp(-Math.pow(((g.top+g.bottom)/2/height-expectedCenter)/.25,2)));
  const ranked=groups.filter(g=>g.bottom-g.top>=2).sort((a,b)=>score(b)-score(a));
  if(!ranked.length)return{top:0,height};
  const selected=ranked.slice(0,maxLines),first=Math.min(...selected.map(g=>g.top)),last=Math.max(...selected.map(g=>g.bottom));
  let top=first,bottom=last;
  const extension=Math.max(2,Math.round((last-first+1)*.3));
  while(top>Math.max(0,first-extension)&&transitions[top-1]>=Math.max(3,peak*.1))top--;
  while(bottom<Math.min(height-1,last+extension)&&transitions[bottom+1]>=Math.max(3,peak*.1))bottom++;
  top=Math.max(0,top-padding);bottom=Math.min(height,bottom+padding+1);
  return{top,height:bottom-top};
}

function otsu(histogram,count){
  let sum=0;for(let i=0;i<256;i++)sum+=i*histogram[i];
  let weight=0,partial=0,best=-1,threshold=140;
  for(let i=0;i<255;i++){
    weight+=histogram[i];partial+=i*histogram[i];
    if(!weight||weight===count)continue;
    const delta=partial/weight-(sum-partial)/(count-weight),score=weight*(count-weight)*delta*delta;
    if(score>best){best=score;threshold=i;}
  }
  return threshold;
}

// Separable sliding extrema, with the same clipped square neighborhood as a
// direct min/max search. Each pixel enters/leaves the deque once per axis.
export function textNeighborhoodExtrema(input, width, height, radius, maximum) {
  const horizontal=new Uint8Array(input.length),output=new Uint8Array(input.length);
  const deque=new Int32Array(Math.max(width,height));
  const pass=(source,target,length,lines,stride,lineStride)=>{
    for(let line=0;line<lines;line++){
      let head=0,tail=0,added=-1;const base=line*lineStride;
      for(let at=0;at<length;at++){
        const end=Math.min(length-1,at+radius);
        while(added<end){
          const next=++added,value=source[base+next*stride];
          while(tail>head&&(maximum?source[base+deque[tail-1]*stride]<=value:source[base+deque[tail-1]*stride]>=value))tail--;
          deque[tail++]=next;
        }
        while(deque[head]<at-radius)head++;
        target[base+at*stride]=source[base+deque[head]*stride];
      }
    }
  };
  pass(input,horizontal,width,height,1,width);
  pass(horizontal,output,height,width,width,1);
  return output;
}

// A bounded retry excludes the distant ornament beside the title/collector
// strip. Work on the already scaled pixels so source glyph-height checks are
// unchanged. Nothing is filled in from the candidate's name or number.
export function isolateTextPixels(image,{binary=false,footer=false,glyphHeight=32}={}){
  const width=Math.max(1,Math.round(image.width*.75)-12),height=image.height,data=new Uint8ClampedArray(width*height*4);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)data.set(image.data.subarray((y*image.width+x+12)*4,(y*image.width+x+13)*4),(y*width+x)*4);
  const gray=Uint8Array.from({length:width*height},(_,i)=>data[i*4]);
  if(!footer&&!binary){
    const radius=Math.max(2,Math.round(glyphHeight*.3));
    const filter=(input,maximum)=>textNeighborhoodExtrema(input,width,height,radius,maximum);
    const background=filter(filter(gray,true),false);
    for(let i=0;i<gray.length;i++)gray[i]=255-Math.min(255,Math.max(0,background[i]-gray[i])*4);
  }
  if(footer){
    const seen=new Uint8Array(width*height),queue=new Int32Array(width*height),glyphs=[];
    for(let start=0;start<seen.length;start++)if(!seen[start]&&gray[start]<128){
      let count=1;queue[0]=start;seen[start]=1;let left=start%width,right=left,top=Math.floor(start/width),bottom=top;
      for(let head=0;head<count;head++){
        const at=queue[head],x=at%width,y=Math.floor(at/width);left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);
        for(const next of [x>0?at-1:-1,x+1<width?at+1:-1,y>0?at-width:-1,y+1<height?at+width:-1])if(next>=0&&!seen[next]&&gray[next]<128){seen[next]=1;queue[count++]=next;}
      }
      const w=right-left+1,h=bottom-top+1;
      if(count>=3&&h>=glyphHeight*.35&&h<=glyphHeight*1.8&&w<=glyphHeight*1.8)glyphs.push({left,right,x:left+w/2,bottom,h});
    }
    let best=null;
    // A collector strip has few glyphs. Dense texture is uncertain evidence;
    // keep the unwarped retry instead of doing an unbounded pair search.
    for(let i=0;glyphs.length<=64&&i<glyphs.length;i++)for(let j=i+1;j<glyphs.length;j++){
      const a=glyphs[i],b=glyphs[j];if(Math.abs(a.x-b.x)<glyphHeight*2)continue;
      const slope=(b.bottom-a.bottom)/(b.x-a.x);if(Math.abs(slope)>.2)continue;
      const intercept=a.bottom-slope*a.x,support=glyphs.filter(g=>Math.abs(g.bottom-intercept-slope*g.x)<=glyphHeight*.22);
      if(support.length<4)continue;
      const left=Math.min(...support.map(g=>g.left)),right=Math.max(...support.map(g=>g.right)),score=support.length+(right-left)/width;
      if(right-left<glyphHeight*4)continue;
      if(!best||score>best.score)best={slope,intercept,support,left,right,score};
    }
    if(best){
      const sizes=best.support.map(g=>g.h).sort((a,b)=>a-b),charHeight=sizes[Math.floor(sizes.length*.75)];
      const left=Math.max(0,Math.floor(best.left-charHeight*.5)),right=Math.min(width,Math.ceil(best.right+charHeight*.8));
      const selectedWidth=right-left,selectedHeight=Math.ceil(charHeight*1.8),selected=new Uint8ClampedArray(selectedWidth*selectedHeight*4).fill(255);
      for(let y=0;y<selectedHeight;y++)for(let x=0;x<selectedWidth;x++){
        const sx=left+x,sy=best.intercept+best.slope*sx-charHeight*1.3+y;
        if(sy<0||sy>=height-1)continue;
        const iy=Math.floor(sy),fraction=sy-iy;let value=gray[iy*width+sx]*(1-fraction)+gray[(iy+1)*width+sx]*fraction;
        if(binary)value=value>=64?255:0;
        selected.set([value,value,value,255],(y*selectedWidth+x)*4);
      }
      return{width:selectedWidth,height:selectedHeight,data:selected};
    }
  }
  for(let i=0;i<gray.length;i++){const value=binary?(gray[i]>=64?255:0):gray[i];data.set([value,value,value,255],i*4);}
  return{width,height,data};
}

export function normalizeTextLighting(image, radius) {
  const { data, width, height } = image;
  radius = Math.max(1, Math.min(24, Math.round(radius)));
  const gray = Uint8Array.from({ length: width * height }, (_, i) => Math.round(data[i * 4] * .299 + data[i * 4 + 1] * .587 + data[i * 4 + 2] * .114));
  const localMin=textNeighborhoodExtrema(gray,width,height,radius,false);
  const localMax=textNeighborhoodExtrema(gray,width,height,radius,true);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const lo=localMin[y*width+x],hi=localMax[y*width+x];
    const value = (gray[y * width + x] - lo) * 255 / Math.max(24, hi - lo);
    data.set([value, value, value, 255], (y * width + x) * 4);
  }
  return image;
}

export function prepareTextPixels(image,{binary=false,footer=false,padding=2,maxLines=1,legacy=false,localContrast=0,localizedPolarity=false,goldInk=false}={}){
  if (localContrast) normalizeTextLighting(image, localContrast);
  const{data,width,height}=image,gray=new Uint8ClampedArray(width*height),histogram=new Uint32Array(256);
  for(let i=0;i<gray.length;i++){
    const at=i*4,r=data[at],g=data[at+1],b=data[at+2];
    // Alternate-rune lettering uses gold over full illustration. This bounded
    // color retry separates actual ink; it supplies no glyphs or expected text.
    gray[i]=goldInk?(r>=170&&g>=115&&g/r>=.65&&g/r<=.9&&b/r<=.5?0:255):binary&&footer?Math.min(r,g,b):r*.299+g*.587+b*.114;
    histogram[gray[i]]++;
  }
  const percentile=fraction=>{let count=0;for(let i=0;i<256;i++){count+=histogram[i];if(count>=gray.length*fraction)return i;}return 255;};
  const low=percentile(.02),high=percentile(.98),invert=binary&&footer||percentile(.5)<128;
  for(let i=0;i<gray.length;i++){
    let value=Math.max(0,Math.min(255,(gray[i]-low)*255/Math.max(20,high-low)));
    if(invert)value=255-value;
    data.set([value,value,value,255],i*4);
  }
  if(legacy){
    if(binary)for(let i=0;i<width*height;i++){const value=data[i*4]>=140?255:0;data.set([value,value,value,255],i*4);}
    return{image,rows:{top:0,height}};
  }
  if(footer){
    // Remove only long straight frame strokes. Source-sized glyphs occupy a
    // small fraction of the broad search band and are not these border runs.
    const margin=Math.max(2,Math.round(width*.04));
    for(let x=0;x<width;x++)if(x<margin||x>=width-margin){
      let count=0;for(let y=0;y<height;y++)if(data[(y*width+x)*4]<192)count++;
      if(count>=height*.85)for(let y=0;y<height;y++)data.set([255,255,255,255],(y*width+x)*4);
    }
    for(let y=0;y<height;y++){
      let count=0;for(let x=0;x<width;x++)if(data[(y*width+x)*4]<64)count++;
      if(count>=width*.65)for(let x=0;x<width;x++)data.set([255,255,255,255],(y*width+x)*4);
    }
    const visited=new Uint8Array(width*height);
    for(let i=0;i<visited.length;i++)if(!visited[i]&&data[i*4]<208){
      const component=[i];visited[i]=1;let left=i%width,right=left,top=Math.floor(i/width),bottom=top;
      for(let head=0;head<component.length;head++){
        const at=component[head],x=at%width,y=Math.floor(at/width);
        left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);
        for(const next of [x>0?at-1:-1,x<width-1?at+1:-1,y>0?at-width:-1,y<height-1?at+width:-1]){
          if(next>=0&&!visited[next]&&data[next*4]<208){visited[next]=1;component.push(next);}
        }
      }
      const w=right-left+1,h=bottom-top+1;
      if(w>=width*.55&&h<=height*.35&&w>=h*5)for(const at of component)data.set([255,255,255,255],at*4);
    }
  }
  const rows=textRows(image,padding,maxLines,footer?null:.5);
  if(localizedPolarity){
    let dark=0;for(let y=rows.top;y<rows.top+rows.height;y++)for(let x=0;x<width;x++)if(data[(y*width+x)*4]<128)dark++;
    if(dark>width*rows.height/2)for(let i=0;i<width*height;i++){const value=255-data[i*4];data.set([value,value,value,255],i*4);}
  }
  if(binary){
    const localHistogram=new Uint32Array(256);
    for(let y=rows.top;y<rows.top+rows.height;y++)for(let x=0;x<width;x++)localHistogram[data[(y*width+x)*4]]++;
    const threshold=otsu(localHistogram,width*rows.height);
    for(let i=0;i<width*height;i++){const value=data[i*4]>threshold?255:0;data.set([value,value,value,255],i*4);}
  }
  return{image,rows};
}
