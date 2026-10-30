import { findCardQuad, warpCard } from '../lib/cardPerspective.js';

self.onmessage = ({ data: { id, analysis, native, rect } }) => {
  try {
    const result = findCardQuad(analysis, rect, { limit: 4 });
    if (result.quad) result.quad = result.quad.map((p) => ({ x: p.x * native.width / analysis.width, y: p.y * native.height / analysis.height }));
    const image = result.status === 'corrected' ? warpCard(native, result.quad) : null;
    const alternatives = (result.alternatives || []).map(candidate => {
      const quad = candidate.quad.map(p => ({ x: p.x * native.width / analysis.width, y: p.y * native.height / analysis.height }));
      return { ...candidate, quad, image: warpCard(native, quad), status: 'corrected', reason: null };
    }).filter(candidate => candidate.image);
    self.postMessage({ id, ...result, alternatives, image }, [image, ...alternatives.map(candidate => candidate.image)].filter(Boolean).map(value => value.data.buffer));
  } catch (error) { self.postMessage({ id, status: 'uncertain', reason: String(error) }); }
};
