export const CAMERA_PROFILES = [
  { value: 'auto', label: 'Automatic · prefer 1080p', width: 1920, height: 1080, frameRate: 30 },
  { value: 'balanced', label: 'Balanced · prefer 720p', width: 1280, height: 720, frameRate: 30 },
  { value: 'low-light', label: 'Low light · prefer 720p / 15 fps', width: 1280, height: 720, frameRate: 15 },
];

export function normalizeCameraProfile(profile) {
  return CAMERA_PROFILES.some((item) => item.value === profile) ? profile : 'auto';
}

export async function openCameraStream(mediaDevices, { deviceId, facingMode, profile }) {
  const target = CAMERA_PROFILES.find((item) => item.value === normalizeCameraProfile(profile));
  const identity = deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: facingMode || 'environment' } };
  try {
    return await mediaDevices.getUserMedia({ audio: false, video: { ...identity,
      width: { ideal: target.width }, height: { ideal: target.height }, frameRate: { ideal: target.frameRate } } });
  } catch (error) {
    if (error.name !== 'OverconstrainedError') throw error;
    // Keep the selected device even when a driver rejects its format hints.
    return mediaDevices.getUserMedia({ audio: false, video: identity });
  }
}

export async function applyCameraAutoModes(track, { focusOnly = false } = {}) {
  const capabilities = track?.getCapabilities?.() || {};
  if (typeof track?.applyConstraints !== 'function') return track?.getSettings?.() || {};
  for (const property of focusOnly ? ['focusMode'] : ['focusMode', 'exposureMode', 'whiteBalanceMode']) {
    if (!capabilities[property]?.includes?.('continuous')) continue;
    try { await track.applyConstraints({ advanced: [{ [property]: 'continuous' }] }); }
    catch { /* A rejected control must not disable the remaining controls. */ }
  }
  return track.getSettings?.() || {};
}

export function supportsTorch(capabilities) {
  return capabilities?.torch === true || capabilities?.torch?.includes?.(true) === true;
}
