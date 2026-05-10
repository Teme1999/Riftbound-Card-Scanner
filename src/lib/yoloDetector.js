import * as ort from 'onnxruntime-web/wasm';
import { resolveAppUrl } from './runtime.js';

const MODEL_URLS = {
  normal: resolveAppUrl('/models/yolo11n-obb-riftbound.onnx'),
  quantized: resolveAppUrl('/models/yolo11n-obb-riftbound-q8.onnx'),
};

ort.env.wasm.wasmPaths = resolveAppUrl('/ort/');
ort.env.wasm.numThreads = 1;

const isDevelopment = import.meta.env.DEV;
const debugLog = (...args) => {
  if (isDevelopment) {
    console.log(...args);
  }
};

export const DetectorState = {
  UNLOADED: 'unloaded',
  LOADING: 'loading',
  WARMING: 'warming',
  READY: 'ready',
  ERROR: 'error',
};

function getSourceSize(source) {
  return {
    width: source?.width || source?.videoWidth || source?.naturalWidth || 0,
    height: source?.height || source?.videoHeight || source?.naturalHeight || 0,
  };
}

class YOLODetector {
  constructor() {
    this.onnxSession = null;
    this.state = DetectorState.UNLOADED;
    this.inputSize = 640;
    this.confidenceThreshold = 0.75;
    this.iouThreshold = 0.45;
    this.modelFormat = 'onnx';
    this.modelPreference = 'quantized';
    this._warmupComplete = false;
  }

  async initialize(modelPreference = 'quantized') {
    this.state = DetectorState.LOADING;
    this.modelPreference = modelPreference === 'normal' ? 'normal' : 'quantized';

    try {
      const modelUrl = MODEL_URLS[this.modelPreference];
      debugLog('[YOLO] Loading ONNX model:', modelUrl);

      this.onnxSession = await ort.InferenceSession.create(modelUrl, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });

      this.state = DetectorState.WARMING;
      await this._warmup();

      this.state = DetectorState.READY;
      debugLog('[YOLO] Detector ready:', this.modelPreference);
    } catch (error) {
      this.state = DetectorState.ERROR;
      const message = error?.message || String(error);
      throw new Error(`Failed to load ONNX detector model from /models/: ${message}`);
    }
  }

  async _warmup() {
    if (!this.onnxSession) {
      throw new Error('ONNX detector session is not initialized.');
    }

    const dummyData = new Float32Array(this.inputSize * this.inputSize * 3).fill(0.5);
    const dummyTensor = new ort.Tensor('float32', dummyData, [1, 3, this.inputSize, this.inputSize]);
    await this.onnxSession.run({ images: dummyTensor });
    this._warmupComplete = true;
  }

  async detect(source) {
    if (this.state !== DetectorState.READY || !this.onnxSession) {
      return [];
    }

    const { width, height } = getSourceSize(source);
    if (!width || !height) {
      return [];
    }

    return this._onnxDetect(source, width, height);
  }

  async _onnxDetect(source, srcW, srcH) {
    const scale = Math.min(this.inputSize / srcW, this.inputSize / srcH);
    const newW = Math.round(srcW * scale);
    const newH = Math.round(srcH * scale);
    const padX = (this.inputSize - newW) / 2;
    const padY = (this.inputSize - newH) / 2;

    const canvas = document.createElement('canvas');
    canvas.width = this.inputSize;
    canvas.height = this.inputSize;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#727272';
    ctx.fillRect(0, 0, this.inputSize, this.inputSize);
    ctx.drawImage(source, 0, 0, srcW, srcH, padX, padY, newW, newH);

    const imageData = ctx.getImageData(0, 0, this.inputSize, this.inputSize);
    const data = imageData.data;
    const inputData = new Float32Array(3 * this.inputSize * this.inputSize);
    const planeSize = this.inputSize * this.inputSize;

    for (let i = 0; i < planeSize; i += 1) {
      inputData[i] = data[i * 4] / 255.0;
      inputData[planeSize + i] = data[i * 4 + 1] / 255.0;
      inputData[2 * planeSize + i] = data[i * 4 + 2] / 255.0;
    }

    const tensor = new ort.Tensor('float32', inputData, [1, 3, this.inputSize, this.inputSize]);
    const results = await this.onnxSession.run({ images: tensor });
    const output = results.output0 || results[Object.keys(results)[0]];
    const outputData = output.data;

    const detections = [];
    const numDetections = output.dims?.[2] || 8400;

    for (let i = 0; i < numDetections; i += 1) {
      const conf = outputData[4 * numDetections + i];
      if (conf < this.confidenceThreshold) {
        continue;
      }

      // Map from YOLO letterbox space back into the original source coordinates.
      const cx = (outputData[0 * numDetections + i] - padX) / scale;
      const cy = (outputData[1 * numDetections + i] - padY) / scale;
      const w = outputData[2 * numDetections + i] / scale;
      const h = outputData[3 * numDetections + i] / scale;
      const angle = outputData[5 * numDetections + i];
      const cropCanvas = this._cropRotated(source, srcW, srcH, cx, cy, w, h, angle);

      detections.push({
        box: { cx, cy, w, h, angle },
        confidence: conf,
        cropCanvas,
      });
    }

    return this._nmsOBB(detections);
  }

  _cropRotated(source, sourceWidth, sourceHeight, cx, cy, w, h, angle) {
    const diag = Math.sqrt(sourceWidth * sourceWidth + sourceHeight * sourceHeight);
    const big = document.createElement('canvas');
    big.width = Math.ceil(diag);
    big.height = Math.ceil(diag);
    const bctx = big.getContext('2d');
    const bcx = big.width / 2;
    const bcy = big.height / 2;
    bctx.translate(bcx, bcy);
    bctx.rotate(-angle);
    bctx.drawImage(source, -cx, -cy);

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w));
    canvas.height = Math.max(1, Math.round(h));
    canvas.getContext('2d').drawImage(big, bcx - w / 2, bcy - h / 2, w, h, 0, 0, w, h);
    return canvas;
  }

  _nmsOBB(detections) {
    if (detections.length <= 1) return detections;

    detections.sort((a, b) => b.confidence - a.confidence);
    const kept = [];

    for (const det of detections) {
      let dominated = false;
      for (const keptDet of kept) {
        if (this._computeOBBIoU(det.box, keptDet.box) > this.iouThreshold) {
          dominated = true;
          break;
        }
      }
      if (!dominated) kept.push(det);
    }

    return kept;
  }

  _computeOBBIoU(box1, box2) {
    const x1 = Math.max(box1.cx - box1.w / 2, box2.cx - box2.w / 2);
    const y1 = Math.max(box1.cy - box1.h / 2, box2.cy - box2.h / 2);
    const x2 = Math.min(box1.cx + box1.w / 2, box2.cx + box2.w / 2);
    const y2 = Math.min(box1.cy + box1.h / 2, box2.cy + box2.h / 2);

    const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const area1 = box1.w * box1.h;
    const area2 = box2.w * box2.h;
    const union = area1 + area2 - intersection;

    return union > 0 ? intersection / union : 0;
  }

  dispose() {
    const session = this.onnxSession;
    this.onnxSession = null;
    if (typeof session?.release === 'function') {
      void session.release();
    }
    this.state = DetectorState.UNLOADED;
    this._warmupComplete = false;
  }
}

let detectorInstance = null;

export function getDetector() {
  if (!detectorInstance) {
    detectorInstance = new YOLODetector();
  }
  return detectorInstance;
}

export default YOLODetector;
