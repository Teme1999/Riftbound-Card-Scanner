import { invokeDesktopCommand } from './desktopBridge.js';
import { isDesktopRuntime } from './runtime.js';

export function nativeFrameDiagnostics(frame, detection, {autoScanEnabled=false,isProcessing=false,fakeScanEnabled=false,fakeScanResult=null}={}) {
  const fields=['observedAt','capturedAt','frameId','matched','reason','similarity','similarityGap','minSimilarity','minSimilarityGap',
    'confidence','colorSimilarity','structureSimilarity','artworkSampling',
    'localStructureSimilarity','alignedArtworkSimilarity','artworkAlignment','confirmationMethod','confirmationReason',
    'cropMethod','rectificationStatus','rectificationReason','geometryConflict','requiresTextConfirmation','box','quad','quality','textVerification',
    'visualVerification','visualCandidates','recognitionEpoch','detectorModel','detectorProposal','matcherRevision','timings','acceptedByAutoScan','acceptedByFakeScan','autoScanConsensus','timestamp','acceptanceDecision'];
  const summarize = value => value ? { card: value.cardData ? { id:value.cardData.id,name:value.cardData.name,code:value.cardData.code } : null,
    ...Object.fromEntries(fields.filter(key=>value[key]!==undefined).map(key=>[key,value[key]])) } : null;
  return {schemaVersion:1,appVersion:__APP_RELEASE_VERSION__,buildTime:__BUILD_TIME__,exportedAt:new Date().toISOString(),
    mode:fakeScanEnabled?'fake-scan':autoScanEnabled?'auto-scan':'debug-preview',isProcessing,
    ...(fakeScanEnabled?{fakeScan:{status:fakeScanResult?'locked':'searching',lockedResult:summarize(fakeScanResult)}}:{}),
    capture:{width:frame?.width,height:frame?.height,frameId:frame?.frameId,capturedAt:frame?.capturedAt,
      moving:frame?.scanMoving,motionEpoch:frame?.scanMotionEpoch,quality:frame?.scanQuality,region:frame?.scanRegion},
    recognition:summarize(detection)};
}

export async function saveNativeFrame(frame, diagnostics=null) {
  if (!frame?.toBlob) throw new Error('No camera frame is available.');
  const png = await new Promise((resolve, reject) => {
    frame.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Could not encode the camera frame.')), 'image/png');
  });

  if (isDesktopRuntime()) {
    const saved = await invokeDesktopCommand('save_native_frame', {
      png: Array.from(new Uint8Array(await png.arrayBuffer())),
      diagnostics,
    });
    // An older running desktop binary can still return just the PNG path.
    return typeof saved==='string'?{path:saved}:saved;
  }

  const url = URL.createObjectURL(png);
  const link = document.createElement('a');
  link.href = url;
  link.download = `riftbound-native-frame-${Date.now()}.png`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return { path: null };
}

export function openNativeFrameFolder() {
  return invokeDesktopCommand('open_storage_folder', { folder: 'native-frames' });
}
