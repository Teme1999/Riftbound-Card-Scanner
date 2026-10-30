// This correlation describes local artwork detail, not OCR confidence and not
// the existing RGB artwork score. A smooth illumination plane carries no ID.
export const MIN_LOCAL_ARTWORK_SIMILARITY = .55;
export const MIN_ALIGNED_ARTWORK_SIMILARITY = .65;

export function hasLocalArtworkSupport(entry) {
  const alignment=entry?.artworkAlignment;
  return Boolean((entry?.localStructureSimilarity>=MIN_LOCAL_ARTWORK_SIMILARITY&&entry.localStructureSimilarity<=1) ||
    (entry?.alignedArtworkSimilarity>=MIN_ALIGNED_ARTWORK_SIMILARITY&&entry.alignedArtworkSimilarity<=1&&alignment &&
      Number.isInteger(alignment.dx)&&Number.isInteger(alignment.dy)&&
      Math.abs(alignment.dx)<=2&&Math.abs(alignment.dy)<=2&&alignment.overlap>=.75&&alignment.overlap<=1));
}

export function artworkDetailScore(entry) {
  return Math.max(entry?.localStructureSimilarity??-1,entry?.alignedArtworkSimilarity??-1);
}

export function describeLocalArtwork(features, size, { radius = Math.max(1, Math.round(size / 8)) } = {}) {
  if (!Number.isInteger(size) || size < 3 || features?.length !== size * size * 3) return null;
  const count = size * size, gray = new Float64Array(count), center = (size - 1) / 2;
  let mean = 0, ax = 0, ay = 0, denominator = 0;
  for (let i = 0; i < count; i++) {
    const at = i * 3;
    gray[i] = features[at] * .299 + features[at + 1] * .587 + features[at + 2] * .114;
    if (!Number.isFinite(gray[i])) return null;
    mean += gray[i];
  }
  mean /= count;
  for (let i = 0; i < count; i++) {
    const x = i % size - center, y = Math.floor(i / size) - center;
    ax += (gray[i] - mean) * x; ay += (gray[i] - mean) * y; denominator += x * x;
  }
  for (let i = 0; i < count; i++) gray[i] -= mean + ax / denominator * (i % size - center) + ay / denominator * (Math.floor(i / size) - center);
  const local = new Float64Array(count);
  mean = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let sum = 0, n = 0;
    for (let yy = Math.max(0, y - radius); yy <= Math.min(size - 1, y + radius); yy++) {
      for (let xx = Math.max(0, x - radius); xx <= Math.min(size - 1, x + radius); xx++) { sum += gray[yy * size + xx]; n++; }
    }
    const i = y * size + x;
    local[i] = gray[i] - sum / n; mean += local[i];
  }
  mean /= count;
  let energy = 0;
  for (let i = 0; i < count; i++) { local[i] -= mean; energy += local[i] * local[i]; }
  if (energy < 1e-8) return null;
  const norm = Math.sqrt(energy);
  return Float32Array.from(local, value => value / norm);
}

export function compareLocalArtwork(left, right) {
  if (!left || !right || left.length !== right.length) return 0;
  let dot = 0;
  for (let i = 0; i < left.length; i++) dot += left[i] * right[i];
  return Math.max(-1, Math.min(1, dot));
}

// Both detail scales must agree on one bounded translation. Require at least
// 75% spatial overlap and half the descriptor energy on each side/scale, so a
// tiny matching corner cannot become corroboration for an unrelated card.
export function compareAlignedArtwork(fine, referenceFine, broad, referenceBroad, size) {
  if(![fine,referenceFine,broad,referenceBroad].every(value=>value?.length===size*size))return null;
  let best=null;const shift=Math.min(2,Math.floor(size/8));
  for(let dy=-shift;dy<=shift;dy++)for(let dx=-shift;dx<=shift;dx++){
    const overlap=(size-Math.abs(dx))*(size-Math.abs(dy))/(size*size);if(overlap<.75)continue;
    let score=0,valid=true;
    for(const [left,right] of [[fine,referenceFine],[broad,referenceBroad]]){
      let dot=0,leftEnergy=0,rightEnergy=0;
      for(let y=Math.max(0,-dy);y<Math.min(size,size-dy);y++)for(let x=Math.max(0,-dx);x<Math.min(size,size-dx);x++){
        const a=left[y*size+x],b=right[(y+dy)*size+x+dx];dot+=a*b;leftEnergy+=a*a;rightEnergy+=b*b;
      }
      if(leftEnergy<.5||rightEnergy<.5){valid=false;break;}
      score+=dot/Math.sqrt(leftEnergy*rightEnergy)/2;
    }
    if(valid&&(!best||score>best.similarity))best={similarity:Math.max(-1,Math.min(1,score)),dx,dy,overlap};
  }
  return best;
}
