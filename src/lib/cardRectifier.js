import { cropCardBox } from './cardRecognition.js';

export class CardRectifier {
  constructor({ createWorker = () => new Worker(new URL('../workers/cardPerspective.worker.js', import.meta.url), { type: 'module' }), timeout = 750 } = {}) {
    this.createWorker = createWorker; this.timeout = timeout; this.sequence = 0; this.worker = null; this.pending = null;
  }
  dispose() {
    this.pending?.finish({ status: 'uncertain', reason: 'cancelled' });
    this.worker?.terminate(); this.worker = null;
  }
  async refine(source, box) {
    if (this.pending) return { status: 'uncertain', reason: 'busy' };
    try {
      if (!this.worker) this.worker = this.createWorker();
      const patch = cropCardBox(source, { ...box, w: box.w * 1.3, h: box.h * 1.3 });
      const sample = (maxSide) => {
        const canvas = document.createElement('canvas'), scale = Math.min(1, maxSide / Math.max(patch.width, patch.height));
        canvas.width = Math.round(patch.width * scale); canvas.height = Math.round(patch.height * scale);
        const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.drawImage(patch, 0, 0, canvas.width, canvas.height);
        return ctx.getImageData(0, 0, canvas.width, canvas.height);
      };
      const analysis = sample(480), native = sample(1600), id = ++this.sequence;
      const result = await new Promise((resolve) => {
        const finish = (value) => { clearTimeout(timer); if (this.pending?.id === id) this.pending = null; resolve(value); };
        const timer = setTimeout(() => { finish({ status: 'uncertain', reason: 'timeout' }); this.worker?.terminate(); this.worker = null; }, this.timeout);
        this.pending = { id, finish };
        this.worker.onmessage = ({ data }) => { if (data.id === id && this.pending?.id === id) finish(data); };
        this.worker.onerror = () => {
          if (this.pending?.id !== id) return;
          finish({ status: 'uncertain', reason: 'worker-error' }); this.worker?.terminate(); this.worker = null;
        };
        this.worker.postMessage({ id, analysis, native,
          rect: { x: analysis.width * 0.15 / 1.3, y: analysis.height * 0.15 / 1.3, width: analysis.width / 1.3, height: analysis.height / 1.3 } }, [analysis.data.buffer, native.data.buffer]);
      });
      if (source.scanCancelled) return { status: 'uncertain', reason: 'cancelled' };
      const angle = box.angle - (box.w > box.h ? Math.PI / 2 : 0), cosine = Math.cos(angle), sine = Math.sin(angle);
      const mapQuad = points => points?.map((p) => {
        const x = (p.x / native.width - 0.5) * Math.min(box.w, box.h) * 1.3;
        const y = (p.y / native.height - 0.5) * Math.max(box.w, box.h) * 1.3;
        return { x: box.cx + cosine * x - sine * y, y: box.cy + sine * x + cosine * y };
      });
      const sourceWidth = source.width || source.naturalWidth, sourceHeight = source.height || source.naturalHeight;
      const convert = value => {
        const quad = mapQuad(value.quad);
        if (quad?.some(p => p.x < 0 || p.y < 0 || p.x >= sourceWidth || p.y >= sourceHeight)) return null;
        const { image, alternatives, ...metadata } = value;
        if (!image) return { ...metadata, quad };
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        const ctx = canvas.getContext('2d'), pixels = ctx.createImageData(canvas.width, canvas.height);
        pixels.data.set(image.data); ctx.putImageData(pixels, 0, 0);
        return { ...metadata, quad, canvas };
      };
      const variants = [result, ...(result.alternatives || [])].map(convert).filter(Boolean);
      if (!variants.length) return { status: 'uncertain', reason: 'outside-image' };
      return { ...variants[0], alternatives: variants.slice(1) };
    } catch (error) { this.dispose(); return { status: 'uncertain', reason: 'worker-unavailable' }; }
  }
}
