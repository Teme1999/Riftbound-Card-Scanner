// Match the reference scraper's INTER_AREA reduction deterministically, rather
// than relying on browser/GPU drawImage filtering for the final artwork grid.
export function areaColorGrid({ data, width, height }, gridSize) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
    !Number.isInteger(gridSize) || gridSize < 1 || data.length < width * height * 4) throw new Error('Invalid artwork grid dimensions');
  const features = new Float32Array(gridSize * gridSize * 3);
  const cellWidth = width / gridSize, cellHeight = height / gridSize, area = cellWidth * cellHeight;
  for (let gy = 0; gy < gridSize; gy++) for (let gx = 0; gx < gridSize; gx++) {
    const left = gx * cellWidth, right = (gx + 1) * cellWidth;
    const top = gy * cellHeight, bottom = (gy + 1) * cellHeight;
    let red = 0, green = 0, blue = 0;
    for (let y = Math.floor(top); y < Math.min(height, Math.ceil(bottom)); y++) {
      const dy = Math.min(y + 1, bottom) - Math.max(y, top);
      for (let x = Math.floor(left); x < Math.min(width, Math.ceil(right)); x++) {
        const weight = dy * (Math.min(x + 1, right) - Math.max(x, left)), offset = (y * width + x) * 4;
        red += data[offset] * weight; green += data[offset + 1] * weight; blue += data[offset + 2] * weight;
      }
    }
    const offset = (gy * gridSize + gx) * 3;
    features[offset] = Math.round(red / area) / 255;
    features[offset + 1] = Math.round(green / area) / 255;
    features[offset + 2] = Math.round(blue / area) / 255;
  }
  return features;
}
