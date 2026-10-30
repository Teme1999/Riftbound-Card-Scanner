import { invokeDesktopCommand } from './desktopBridge.js';
import { isDesktopRuntime } from './runtime.js';
import { nativeFrameDiagnostics } from './nativeFrame.js';
import { getScanEvidence } from './scanEvidence.js';

export function debugScanDetails(result, context = {}) {
  const stored = getScanEvidence(result), frame = stored?.frame;
  if (!frame || frame.frameId !== result.frameId) throw new Error('The accepted source frame is unavailable. A later camera frame will not be substituted.');
  return { ...nativeFrameDiagnostics(frame, result, { autoScanEnabled: true }), schemaVersion: 2,
    mode: 'debug-auto-scan', event: 'accepted-and-queued',
    candidates: stored.candidates || [],
    scanner: { perspective: context.perspective === true, textVerification: context.textVerification === true,
      detectorMode: context.detectorMode, cameraProfile: context.cameraProfile,
      setFilter: Array.isArray(context.setFilter) ? context.setFilter.map(String) : 'all',
      cameraSettings: Object.fromEntries(['width','height','frameRate','focusMode','exposureMode','whiteBalanceMode','exposureTime','focusDistance']
        .filter(key => context.cameraSettings?.[key] !== undefined).map(key => [key, context.cameraSettings[key]])) },
  };
}

function percent(value) { return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : 'unavailable'; }

export function annotateDebugScan(frame, details) {
  const result = details.recognition, card = result.card;
  const scale = Math.min(1, 1400 / Math.max(frame.width, frame.height)), width = Math.round(frame.width * scale), height = Math.round(frame.height * scale);
  const canvas = document.createElement('canvas'); canvas.width = width + 520; canvas.height = Math.max(height, 1600);
  const ctx = canvas.getContext('2d'); ctx.fillStyle = '#101827'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(frame, 0, 0, width, height);
  const region = frame.scanRegion || {}, point = value => ({ x: (value.x - (region.x || 0)) * scale, y: (value.y - (region.y || 0)) * scale });
  ctx.strokeStyle = '#67e8f9'; ctx.lineWidth = 3;
  if (result.quad?.length === 4) {
    ctx.beginPath(); result.quad.map(point).forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));ctx.closePath();ctx.stroke();
  }
  if (result.box) {
    const box = result.box, center = point({ x: box.cx, y: box.cy });
    ctx.save();ctx.translate(center.x, center.y);ctx.rotate(box.angle);ctx.strokeStyle='#f7d36b';
    ctx.strokeRect(-box.w * scale / 2, -box.h * scale / 2, box.w * scale, box.h * scale);ctx.restore();
  }
  const proof = result.textVerification || {}, consensus = result.autoScanConsensus || {}, decision = result.acceptanceDecision || {};
  const geometry=result.visualVerification?.candidates?.find(c=>c.cardId===card?.id)||result.visualVerification;
  const lines = ['ACCEPTED + ADDED TO PENDING', card?.name, card?.code || card?.id,
    `Accepted: ${new Date(result.timestamp).toISOString()}`, `Source frame: ${result.frameId} at ${frame.capturedAt}`,
    `App: ${details.appVersion} / build ${details.buildTime}`, `Policy: ${decision.path || result.confirmationReason || result.confirmationMethod || 'artwork'}`,
    `Artwork: ${percent(result.similarity)} / gap ${Number.isFinite(result.similarityGap) ? (result.similarityGap * 100).toFixed(2) + ' pp' : 'unavailable'}`,
    `Color: ${percent(result.colorSimilarity)} / structure: ${percent(result.structureSimilarity)}`,
    `Local: ${percent(result.localStructureSimilarity)} / aligned: ${percent(result.alignedArtworkSimilarity)}`,
    `Visual geometry: ${result.visualVerification?.status || 'none'} / inliers ${geometry?.inliers ?? '?'} / runner ${geometry?.runnerInliers ?? '?'} / ${result.visualVerification?.workerMs?.toFixed(1) || '?'} ms`,
    ...(result.visualVerification?.workerError?[`Reference error: ${result.visualVerification.workerError}`]:[]),
    ...(result.visualVerification?.fallbackReferenceIds?.length?[`Bundled reference fallback: ${result.visualVerification.fallbackReferenceIds.join(', ')}`]:[]),
    ...(geometry?.registeredArtwork?[`Registered artwork NCC: ${geometry.registeredArtwork.correlation.toFixed(3)} / runner ${geometry.registeredRunnerCorrelation?.toFixed(3)} / tiles ${geometry.registeredArtwork.tilesMatched}/${geometry.registeredArtwork.tilesCompared}`]:[]),
    `Quality: ${result.quality?.acceptable ? 'pass' : 'fail'} / ${result.quality?.issue || 'no blocking issue'}`,
    `Sharpness: ${result.quality?.sharpness?.toFixed(3) || '?'} / brightness: ${result.quality?.mean?.toFixed(1) || '?'}`,
    `Crop: ${result.cropMethod} / ${result.rectificationStatus || 'none'}`, `Crop note: ${result.rectificationReason || 'none'}`,
    `OCR: ${proof.status || 'disabled'} / ${proof.textCropMethod || ''} / ${proof.textLayout || ''}`,
    `Name: ${proof.name || 'unreadable'} (${proof.nameConfidence ?? 0})`, `Code: ${proof.code || 'unreadable'} (${proof.codeConfidence ?? 0})`,
    ...(proof.evidenceType==='rune-name-set-artwork'?[`Rune set: ${proof.readSet || 'unreadable'} (${proof.setConfidence ?? 0}) / ${proof.evidenceType}`]:[]),
    `Text source frames: ${(proof.sourceFrameIds || []).join(', ') || 'none'}`,
    `OCR attempt: ${proof.attemptNumber ?? '?'} / track ${proof.trackAgeMs ?? '?'} ms / read ${proof.ocrMs ?? '?'} ms`,
    `Frame: ${result.timings?.frameMs ?? '?'} ms / detector ${result.timings?.detectorMs ?? '?'} / artwork ${result.timings?.artworkMs ?? '?'}`,
    `Visual confirmations: ${consensus.consecutiveHits ?? consensus.matchedHits ?? 0} / ${consensus.durationMs ?? 0} ms`,
    `Visual source frames: ${(consensus.sourceFrameIds || []).join(', ') || 'unavailable'}`,
    `Detector: ${details.scanner.detectorMode || result.detectorModel || '?'} / database revision ${result.matcherRevision ?? '?'}`,
    `Perspective: ${details.scanner.perspective} / OCR: ${details.scanner.textVerification}`, '', 'VISUAL CANDIDATES',
    ...(details.candidates || []).flatMap((entry, i) => [`${i + 1}. ${entry.name} (${entry.code || entry.id})`,
      `   RGB ${percent(entry.similarity)} / detail ${percent(entry.localStructureSimilarity)} / aligned ${percent(entry.alignedArtworkSimilarity)}`]),
    '', 'Original PNG and full JSON saved separately.'];
  ctx.font = '16px monospace'; ctx.textBaseline = 'top'; ctx.fillStyle = '#e5e7eb';
  let y = 18;
  for (const line of lines.filter(line => line != null)) {
    const words = String(line).replace(/\s+/g, ' ').split(' '); let row = '';
    for (const word of words) {
      if (row && ctx.measureText(row + ' ' + word).width > 485) { ctx.fillText(row, width + 18, y); y += 22; row = word; }
      else row += (row ? ' ' : '') + word;
    }
    ctx.fillText(row, width + 18, y);y += 22;
  }
  return canvas;
}

const pngBytes = async canvas => {
  const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Could not encode debug image.')), 'image/png'));
  return Array.from(new Uint8Array(await blob.arrayBuffer()));
};

export async function saveAcceptedDebugScan(result, context) {
  if (!isDesktopRuntime()) throw new Error('Automatic debug capture requires the desktop app.');
  const details = debugScanDetails(result, context), frame = getScanEvidence(result).frame;
  const annotated = annotateDebugScan(frame, details);
  const rawPng = await pngBytes(frame), annotatedPng = await pngBytes(annotated);
  return invokeDesktopCommand('save_debug_scan', { rawPng, annotatedPng, diagnostics: details });
}

export function openDebugScanFolder() { return invokeDesktopCommand('open_storage_folder', { folder: 'debug-scans' }); }
