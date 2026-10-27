export function getScanGuide(width, height) {
  const guideHeight = Math.min(height * 0.8, width * 0.9 / (63 / 88));
  const guideWidth = guideHeight * (63 / 88);
  return { x: (width - guideWidth) / 2, y: (height - guideHeight) / 2, width: guideWidth, height: guideHeight };
}

// The preview uses object-fit: cover. Map its guide through both scaling and
// clipping so hidden parts of a widescreen webcam cannot win the detection.
export function getVideoScanRegion(sourceWidth, sourceHeight, viewWidth, viewHeight) {
  if (!sourceWidth || !sourceHeight) return null;
  const width = viewWidth || sourceWidth;
  const height = viewHeight || sourceHeight;
  const guide = getScanGuide(width, height);
  const scale = Math.max(width / sourceWidth, height / sourceHeight);
  const offsetX = (width - sourceWidth * scale) / 2;
  const offsetY = (height - sourceHeight * scale) / 2;
  const sourceGuide = {
    x: (guide.x - offsetX) / scale,
    y: (guide.y - offsetY) / scale,
    width: guide.width / scale,
    height: guide.height / scale,
  };
  const x = Math.max(0, Math.floor(sourceGuide.x - sourceGuide.width * 0.15));
  const y = Math.max(0, Math.floor(sourceGuide.y - sourceGuide.height * 0.15));
  const right = Math.min(sourceWidth, Math.ceil(sourceGuide.x + sourceGuide.width * 1.15));
  const bottom = Math.min(sourceHeight, Math.ceil(sourceGuide.y + sourceGuide.height * 1.15));
  return { x, y, width: right - x, height: bottom - y, sourceWidth, sourceHeight,
    guide: { ...sourceGuide, x: sourceGuide.x - x, y: sourceGuide.y - y } };
}

export function selectGuideDetection(detections, guide) {
  if (!guide) return detections[0] || null;
  const centerX = guide.x + guide.width / 2;
  const centerY = guide.y + guide.height / 2;
  let selected = null, bestScore = -Infinity;
  for (const detection of detections) {
    const box = detection.box;
    if (box.cx < guide.x || box.cx > guide.x + guide.width || box.cy < guide.y || box.cy > guide.y + guide.height) continue;
    const distance = Math.hypot((box.cx - centerX) / guide.width, (box.cy - centerY) / guide.height);
    const score = 1 - distance + detection.confidence * 0.2;
    if (score > bestScore) { bestScore = score; selected = detection; }
  }
  return selected;
}

export function mapDetectionBox(box, region) {
  return region ? { ...box, cx: box.cx + region.x, cy: box.cy + region.y } : box;
}

export function getDetectorLetterbox(sourceWidth, sourceHeight, inputSize, contextScale = 1) {
  const scale = Math.min(inputSize / sourceWidth, inputSize / sourceHeight) * contextScale;
  const newW = Math.round(sourceWidth * scale), newH = Math.round(sourceHeight * scale);
  return { scale, newW, newH, padX: (inputSize - newW) / 2, padY: (inputSize - newH) / 2 };
}
