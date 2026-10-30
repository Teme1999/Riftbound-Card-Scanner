// Bounded, deterministic image geometry; also used by the browser worker tests.
export function polygonArea(points) {
  return Math.abs(points.reduce((sum, p, i) => {
    const next = points[(i + 1) % points.length];
    return sum + p.x * next.y - p.y * next.x;
  }, 0)) / 2;
}

export function validCardQuad(quad, bounds, expectedArea) {
  if (quad.length !== 4 || quad.some((p) => !Number.isFinite(p.x + p.y) ||
    p.x < 0 || p.y < 0 || p.x > bounds.width - 1 || p.y > bounds.height - 1)) return false;
  const area = polygonArea(quad);
  if (area < expectedArea * 0.65 || area > expectedArea * 1.25) return false;
  let winding = 0;
  const lengths = [];
  for (let i = 0; i < 4; i++) {
    const a = quad[i], b = quad[(i + 1) % 4], c = quad[(i + 2) % 4];
    const u = { x: a.x - b.x, y: a.y - b.y }, v = { x: c.x - b.x, y: c.y - b.y };
    const cross = u.x * v.y - u.y * v.x;
    if (!cross || (winding && Math.sign(cross) !== winding)) return false;
    winding = Math.sign(cross);
    const length = Math.hypot(u.x, u.y), nextLength = Math.hypot(v.x, v.y);
    const cosine = (u.x * v.x + u.y * v.y) / (length * nextLength);
    if (Math.abs(cosine) > Math.SQRT1_2) return false;
    lengths.push(length);
  }
  return lengths[0] / lengths[2] >= 0.5 && lengths[0] / lengths[2] <= 2 &&
    lengths[1] / lengths[3] >= 0.5 && lengths[1] / lengths[3] <= 2;
}

function edgePoints({ data, width, height }) {
  const gray = new Float32Array(width * height), points = [];
  for (let i = 0; i < gray.length; i++) gray[i] = data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114;
  for (let y = 2; y < height - 2; y++) for (let x = 2; x < width - 2; x++) {
    const i = y * width + x;
    const gx = gray[i - width + 1] + 2 * gray[i + 1] + gray[i + width + 1] - gray[i - width - 1] - 2 * gray[i - 1] - gray[i + width - 1];
    const gy = gray[i + width - 1] + 2 * gray[i + width] + gray[i + width + 1] - gray[i - width - 1] - 2 * gray[i - width] - gray[i - width + 1];
    const strength = Math.hypot(gx, gy);
    if (strength >= 40) points.push({ x, y, gx, gy, strength });
  }
  return points;
}

function fitSide(points, vertical, position, spanStart, spanLength, band) {
  const bins = Array.from({ length: 32 }, () => []);
  for (const p of points) {
    const along = vertical ? p.y : p.x, across = vertical ? p.x : p.y;
    if (along < spanStart || along >= spanStart + spanLength || Math.abs(across - position) > band) continue;
    if (vertical ? Math.abs(p.gx) < Math.abs(p.gy) * 1.2 : Math.abs(p.gy) < Math.abs(p.gx) * 1.2) continue;
    const bin = bins[Math.min(31, Math.floor((along - spanStart) / spanLength * 32))];
    bin.push({ u: along, v: across, strength: p.strength });
  }
  const sample = bins.flatMap((bin) => {
    bin.sort((a, b) => b.strength - a.strength);
    const kept = [];
    for (const p of bin) if (kept.length < 16 && !kept.some((q) => Math.abs(p.v - q.v) < 2)) kept.push(p);
    return kept;
  });
  if (sample.length < 20) return [];
  let seed = 1827;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const ranked = [];
  const assess = (a, b) => {
    if (Math.abs(a) > 0.58 || Math.abs(a * (spanStart + spanLength / 2) + b - position) > band) return;
    const support = new Set(); let strength = 0;
    const inliers = sample.filter((p) => Math.abs(p.v - a * p.u - b) < 2.2);
    for (const p of inliers) { support.add(Math.floor((p.u - spanStart) / spanLength * 32)); strength += Math.min(1, p.strength / 500); }
    const coverage = support.size / 32;
    if (coverage < 0.6) return;
    // Refit the inliers for subpixel intersections rather than using the seed pair.
    const n = inliers.length, sumU = inliers.reduce((s, p) => s + p.u, 0), sumV = inliers.reduce((s, p) => s + p.v, 0);
    const sumUU = inliers.reduce((s, p) => s + p.u * p.u, 0), sumUV = inliers.reduce((s, p) => s + p.u * p.v, 0);
    const denominator = n * sumUU - sumU * sumU;
    if (denominator <= 0) return;
    a = (n * sumUV - sumU * sumV) / denominator; b = (sumV - a * sumU) / n;
    const score = coverage * 0.9 + strength / Math.max(1, n) * 0.04 - Math.abs(a * (spanStart + spanLength / 2) + b - position) / band * 0.1;
    if (ranked.some((line) => Math.abs(line.b - b) < 2 && Math.abs(line.a - a) < 0.02)) return;
    ranked.push({ a, b, coverage, score }); ranked.sort((x, y) => y.score - x.score); ranked.length = Math.min(6, ranked.length);
  };
  for (let i = 0; i < 192; i++) {
    const p = sample[Math.floor(random() * sample.length)], q = sample[Math.floor(random() * sample.length)];
    if (Math.abs(p.u - q.u) < spanLength * 0.35) continue;
    const a = (p.v - q.v) / (p.u - q.u); assess(a, p.v - a * p.u);
  }
  return ranked;
}

function intersection(vertical, horizontal) {
  const denominator = 1 - vertical.a * horizontal.a;
  if (Math.abs(denominator) < 1e-8) return { x: NaN, y: NaN };
  const x = (vertical.a * horizontal.b + vertical.b) / denominator;
  return { x, y: horizontal.a * x + horizontal.b };
}

export function perspectiveDivergence(quad) {
  const angles = quad.map((p, i) => Math.atan2(quad[(i + 1) % 4].y - p.y, quad[(i + 1) % 4].x - p.x));
  const difference = (a, b) => Math.acos(Math.min(1, Math.abs(Math.cos(a - b))));
  return Math.max(difference(angles[0], angles[2]), difference(angles[1], angles[3]));
}

export function findCardQuad(image, rect, { limit = 1 } = {}) {
  if (Math.max(image.width, image.height) > 480) throw new Error('Perspective analysis must be bounded to 480px');
  const points = edgePoints(image);
  const vertical = (x) => fitSide(points, true, x, rect.y + rect.height * 0.08, rect.height * 0.84, rect.width * 0.18);
  const horizontal = (y) => fitSide(points, false, y, rect.x + rect.width * 0.08, rect.width * 0.84, rect.height * 0.18);
  const sides = [vertical(rect.x), horizontal(rect.y), vertical(rect.x + rect.width), horizontal(rect.y + rect.height)];
  if (sides.some((side) => !side.length)) return { status: 'uncertain', reason: 'edges-incomplete' };
  let best = null;
  const hypotheses = [];
  for (const left of sides[0]) for (const top of sides[1]) for (const right of sides[2]) for (const bottom of sides[3]) {
    const quad = [intersection(left, top), intersection(right, top), intersection(right, bottom), intersection(left, bottom)];
    if (!validCardQuad(quad, image, rect.width * rect.height)) continue;
    const cx = quad.reduce((s, p) => s + p.x, 0) / 4, cy = quad.reduce((s, p) => s + p.y, 0) / 4;
    if (Math.abs(cx - rect.x - rect.width / 2) > rect.width * 0.1 || Math.abs(cy - rect.y - rect.height / 2) > rect.height * 0.1) continue;
    // Prefer the outer card over its high-contrast printed inner frame, which
    // otherwise removes the footer. The OBB supplies an independent size prior.
    const score = left.score + top.score + right.score + bottom.score -
      1.5 * Math.abs(Math.log(polygonArea(quad) / (rect.width * rect.height)));
    const candidate = { quad, score, support: [left, top, right, bottom].map((s) => s.coverage) };
    if (limit > 1) hypotheses.push(candidate);
    if (!best || score > best.score) best = candidate;
  }
  if (!best) return { status: 'uncertain', reason: 'invalid-quadrilateral' };
  const expected = [{ x: rect.x, y: rect.y }, { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height }, { x: rect.x, y: rect.y + rect.height }];
  const near = best.quad.every((p, i) => Math.hypot(p.x - expected[i].x, p.y - expected[i].y) < Math.hypot(rect.width, rect.height) * 0.015);
  // A smaller, almost parallel frame is not evidence of projective distortion.
  // Warping it to the card aspect ratio can discard the physical card's footer.
  // Keep the detector crop when the proposed change only moves/insets a box.
  if (!near && perspectiveDivergence(best.quad) < Math.PI / 120) return { status: 'uncertain', reason: 'no-perspective-evidence' };
  const result = { ...best, status: near ? 'unchanged' : 'corrected', reason: near ? 'already-straight' : null };
  if (limit > 1 && !near) {
    // Printed borders and a sleeve/stack can each support valid lines. Keep a
    // small, spatially distinct geometry shortlist, independent of card IDs.
    const separation = Math.hypot(rect.width, rect.height) * .017;
    result.alternatives = [];
    for (const candidate of hypotheses.sort((a, b) => b.score - a.score)) {
      if (perspectiveDivergence(candidate.quad) < Math.PI / 120) continue;
      if ([best, ...result.alternatives].some(other => other.quad.every((p, i) =>
        Math.hypot(p.x - candidate.quad[i].x, p.y - candidate.quad[i].y) < separation))) continue;
      result.alternatives.push(candidate);
      if (result.alternatives.length >= Math.min(4, Math.floor(limit)) - 1) break;
    }
  }
  return result;
}

// Solve a unit-square -> source-plane homography using pivoted elimination.
export function cardHomography(quad) {
  const corners = [[0, 0], [1, 0], [1, 1], [0, 1]], matrix = [];
  for (let i = 0; i < 4; i++) {
    const [u, v] = corners[i], { x, y } = quad[i];
    matrix.push([u, v, 1, 0, 0, 0, -u * x, -v * x, x], [0, 0, 0, u, v, 1, -u * y, -v * y, y]);
  }
  for (let i = 0; i < 8; i++) {
    let pivot = i;
    for (let j = i + 1; j < 8; j++) if (Math.abs(matrix[j][i]) > Math.abs(matrix[pivot][i])) pivot = j;
    [matrix[i], matrix[pivot]] = [matrix[pivot], matrix[i]];
    const divisor = matrix[i][i]; if (Math.abs(divisor) < 1e-10) return null;
    for (let k = i; k <= 8; k++) matrix[i][k] /= divisor;
    for (let j = 0; j < 8; j++) if (j !== i) {
      const factor = matrix[j][i]; for (let k = i; k <= 8; k++) matrix[j][k] -= factor * matrix[i][k];
    }
  }
  return [...matrix.map((row) => row[8]), 1];
}

export function projectCardPoint(matrix, u, v) {
  const d = matrix[6] * u + matrix[7] * v + 1;
  return { x: (matrix[0] * u + matrix[1] * v + matrix[2]) / d,
    y: (matrix[3] * u + matrix[4] * v + matrix[5]) / d };
}

export function warpCard(image, quad, maxWidth = 720) {
  const matrix = cardHomography(quad); if (!matrix) return null;
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const width = Math.max(2, Math.min(maxWidth, Math.round((distance(quad[0], quad[1]) + distance(quad[3], quad[2])) / 2)));
  const height = Math.round(width * 88 / 63), data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = projectCardPoint(matrix, x / (width - 1), y / (height - 1));
    if (!Number.isFinite(p.x + p.y) || p.x < 0 || p.y < 0 || p.x > image.width - 1 || p.y > image.height - 1) return null;
    const ix = Math.floor(p.x), iy = Math.floor(p.y), dx = p.x - ix, dy = p.y - iy;
    const at = (py, px) => (Math.min(image.height - 1, py) * image.width + Math.min(image.width - 1, px)) * 4;
    const a = at(iy, ix), b = at(iy, ix + 1), c = at(iy + 1, ix), d = at(iy + 1, ix + 1), dest = (y * width + x) * 4;
    for (let ch = 0; ch < 3; ch++) data[dest + ch] = (image.data[a + ch] * (1 - dx) + image.data[b + ch] * dx) * (1 - dy) +
      (image.data[c + ch] * (1 - dx) + image.data[d + ch] * dx) * dy;
    data[dest + 3] = 255;
  }
  return { data, width, height };
}
