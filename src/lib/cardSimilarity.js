// Positive RGB vectors have a high cosine baseline even for unrelated artwork.
// Add normalized, per-channel mean-centered correlation to compare the spatial
// pattern as well as its colors. Both use the existing RGB grid database.
const COLOR_WEIGHT = 0.6;
const EPSILON = 1e-8;

export function describeFeatures(features) {
  const channelSums = [0, 0, 0];
  let normSquared = 0;
  if (!features?.length || features.length % 3 !== 0) return null;
  for (let i = 0; i < features.length; i++) {
    const value = features[i];
    if (!Number.isFinite(value)) return null;
    channelSums[i % 3] += value;
    normSquared += value * value;
  }
  const cells = features.length / 3;
  const meanEnergy = channelSums.reduce((sum, value) => sum + value * value / cells, 0);
  const variance = normSquared - meanEnergy;
  // Subtracting the means can leave rounding residue for a completely flat
  // grid. Never normalize that residue into a perfect structural match.
  const structureEnergy = variance > Math.max(1e-12, normSquared * 1e-12) ? variance : 0;
  return { channelSums, cells, norm: Math.sqrt(normSquared),
    structureNorm: Math.sqrt(structureEnergy) };
}

export function compareFeatures(left, right, leftStats = describeFeatures(left), rightStats = describeFeatures(right)) {
  const empty = { similarity: 0, colorSimilarity: 0, structureSimilarity: 0 };
  if (!leftStats || !rightStats || left.length !== right.length ||
      leftStats.norm < EPSILON || rightStats.norm < EPSILON ||
      leftStats.structureNorm < EPSILON || rightStats.structureNorm < EPSILON) return empty;
  let dot = 0;
  for (let i = 0; i < left.length; i++) dot += left[i] * right[i];
  const meanDot = leftStats.channelSums.reduce((sum, value, channel) =>
    sum + value * rightStats.channelSums[channel] / leftStats.cells, 0);
  const clamp = (value) => Math.max(-1, Math.min(1, value));
  const colorSimilarity = clamp(dot / (leftStats.norm * rightStats.norm));
  const structureSimilarity = clamp((dot - meanDot) / (leftStats.structureNorm * rightStats.structureNorm));
  return { similarity: Math.max(0, COLOR_WEIGHT * colorSimilarity + (1 - COLOR_WEIGHT) * structureSimilarity),
    colorSimilarity, structureSimilarity };
}
