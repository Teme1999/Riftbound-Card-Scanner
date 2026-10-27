export const MIN_SIMILARITY_GAP = 0.05;
export const QUALITY_MESSAGES = {
  'too-dark': 'Add more light to the card.',
  'too-bright': 'Reduce direct light or tilt the card slightly.',
  'too-small': 'Bring the card closer to the camera.',
  blurred: 'Hold the card still and let the camera focus.',
  moving: 'Hold the card still for a moment.',
  glare: 'Try tilting the card to reduce reflections, or review it manually.',
  ambiguous: 'Card unclear. Adjust the light or review it manually.',
  'low-similarity': 'Move the card closer and let the camera focus.',
  'outside-guide': 'Place one card inside the scanning frame.',
  ready: 'Keep the card inside the frame and hold it steady.',
};

// All thresholds operate on a bounded, consistently sized sample, not on the
// webcam resolution. Only severe defects block acceptance; glare is advisory.
export function measureImageQuality({ data, width, height }, sourceWidth = width, sourceHeight = height) {
  const count = width * height;
  if (!count || data.length < count * 4) return { acceptable: false, score: 0, issue: 'too-dark', fingerprint: [] };
  const luminance = new Float32Array(count), histogram = new Uint32Array(256);
  let sum = 0, clipped = 0;
  for (let i = 0; i < count; i++) {
    const value = data[i * 4] * 0.2126 + data[i * 4 + 1] * 0.7152 + data[i * 4 + 2] * 0.0722;
    luminance[i] = value;
    histogram[Math.round(value)]++;
    sum += value;
    if (value > 245) clipped++;
  }
  const percentile = (fraction) => {
    let cumulative = 0;
    for (let value = 0; value < 256; value++) { cumulative += histogram[value]; if (cumulative >= count * fraction) return value; }
    return 255;
  };
  const low = percentile(0.05), high = percentile(0.95), mean = sum / count;
  let laplacian = 0, edge = 0, pixels = 0;
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const i = y * width + x;
    const lap = luminance[i - 1] + luminance[i + 1] + luminance[i - width] + luminance[i + width] - 4 * luminance[i];
    laplacian += lap * lap;
    edge += Math.abs(luminance[i + 1] - luminance[i - 1]) + Math.abs(luminance[i + width] - luminance[i - width]);
    pixels++;
  }
  const contrast = high - low;
  const sharpness = Math.sqrt(laplacian / Math.max(1, pixels)) / Math.max(30, contrast);
  const detail = edge / Math.max(1, pixels);
  const clippedFraction = clipped / count;
  let issue = null;
  if (mean < 16 && high < 45) issue = 'too-dark';
  else if (low > 220 && contrast < 25) issue = 'too-bright';
  else if (Math.min(sourceWidth, sourceHeight) < 64) issue = 'too-small';
  else if (sharpness < 0.025 && detail < 4 && contrast < 120) issue = 'blurred';
  // Bright artwork and white card borders are legitimate. Reflection risk
  // becomes a user-facing hint only when matching is also ambiguous.
  const reflectionRisk = high > 210 && mean < 175;
  const acceptable = !['too-dark', 'too-bright', 'too-small', 'blurred'].includes(issue);
  const fingerprint = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    fingerprint.push(luminance[Math.min(height - 1, Math.floor((y + 0.5) * height / 8)) * width + Math.min(width - 1, Math.floor((x + 0.5) * width / 8))]);
  }
  const score = Math.max(0, Math.min(1, Math.min(1, sharpness * 3) * 0.55 + Math.min(1, contrast / 150) * 0.3 + (1 - clippedFraction) * 0.15 - clippedFraction * 0.3 - (acceptable ? 0 : 0.6)));
  return { acceptable, issue, score, mean, contrast, sharpness, clippedFraction, reflectionRisk, fingerprint };
}

export function readCanvasQuality(canvas, region = null) {
  const crop = region || { x: 0, y: 0, width: canvas.width, height: canvas.height };
  const sample = document.createElement('canvas');
  sample.width = 64;
  sample.height = 88;
  const ctx = sample.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, crop.x, crop.y, crop.width, crop.height, 0, 0, sample.width, sample.height);
  return measureImageQuality(ctx.getImageData(0, 0, sample.width, sample.height), crop.width, crop.height);
}

export function frameDifference(left = [], right = []) {
  if (!left.length || left.length !== right.length) return 0;
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const offset = mean(left) - mean(right);
  return left.reduce((sum, value, i) => sum + Math.abs(value - right[i] - offset), 0) / left.length / 255;
}

export class BestFrameBuffer {
  constructor() { this.clear(); }
  clear() {
    for (const frame of this.frames || []) if (frame.canvas) frame.canvas.scanCancelled = true;
    this.frames = [];
    this.lastVideoTime = null;
  }
  add(frame) {
    const previous = this.frames.at(-1);
    const moving = previous && frameDifference(previous.quality.fingerprint, frame.quality.fingerprint) > 0.1;
    if (moving || (previous && previous.layoutKey !== frame.layoutKey)) this.clear();
    frame.moving = Boolean(moving);
    this.frames.push(frame);
    this.frames = this.frames.filter((item) => frame.capturedAt - item.capturedAt <= 350).slice(-3);
  }
  best(now) {
    const recent = this.frames.filter((frame) => now - frame.capturedAt <= 350);
    return recent.reduce((best, frame) => {
      const score = (item) => item.quality.score - (item.moving ? 0.2 : 0) - (now - item.capturedAt) / 350 * 0.04;
      return !best || score(frame) >= score(best) ? frame : best;
    }, null);
  }
}

export function isReliableScanResult(result, minSimilarity = 0.68) {
  return Boolean(result?.cardData?.id) && result.matched === true && result.quality?.acceptable === true &&
    Number.isFinite(result.similarity) &&
    Number.isFinite(result.similarityGap) && result.similarityGap >= MIN_SIMILARITY_GAP &&
    result.similarity >= minSimilarity;
}

export function getScanGuidance(captureQuality, lastDetection, now = Date.now()) {
  const recent = lastDetection && now - lastDetection.observedAt < 1200;
  let issue = captureQuality?.issue === 'moving' ? 'moving'
    : recent ? lastDetection.reason || lastDetection.quality?.issue || 'ready'
    : captureQuality?.issue || 'ready';
  if (issue === 'outside-guide' && ['too-dark', 'too-bright'].includes(captureQuality?.issue)) issue = captureQuality.issue;
  if (issue === 'ambiguous' && lastDetection.quality?.reflectionRisk) issue = 'glare';
  return { issue, message: QUALITY_MESSAGES[issue] || QUALITY_MESSAGES.ready };
}
