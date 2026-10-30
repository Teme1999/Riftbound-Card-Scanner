import { useState, useRef, useCallback, useEffect } from 'react';
import { openCameraStream, applyCameraAutoModes, supportsTorch } from '../lib/cameraControls.js';
import { getVideoScanRegion } from '../lib/scanGeometry.js';
import { BestFrameBuffer, readCanvasQuality } from '../lib/scanQuality.js';
import { emitScanDiagnostic } from '../lib/scanDiagnostics.js';

/**
 * Hook for managing camera access and video streaming
 */
export function useCamera({ deviceId = '', profile = 'auto' } = {}) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const cameraConfigRef = useRef({ deviceId, profile, facingMode: 'environment' });
  const [isActive, setIsActive] = useState(false);
  const [error, setError] = useState(null);
  const [facingMode, setFacingMode] = useState('environment'); // 'user' | 'environment'
  const [capabilities, setCapabilities] = useState(null);
  const [torchOn, setTorchOn] = useState(false);
  const [settings, setSettings] = useState(null);
  const [captureQuality, setCaptureQuality] = useState(null);
  const frameBufferRef = useRef(new BestFrameBuffer());
  const frameSequenceRef = useRef(0);
  const requestRef = useRef(0);

  const startCamera = useCallback(async () => {
    const request = ++requestRef.current;
    try {
      setError(null);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      frameBufferRef.current.clear();
      setCaptureQuality(null);
      const stream = await openCameraStream(navigator.mediaDevices, { deviceId, facingMode, profile });
      if (request !== requestRef.current) { stream.getTracks().forEach((track) => track.stop()); return; }
      streamRef.current = stream;
      const track = stream.getVideoTracks()[0];
      const appliedSettings = await applyCameraAutoModes(track);
      if (request !== requestRef.current) { stream.getTracks().forEach((item) => item.stop()); return; }
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      if (request !== requestRef.current) return;
      setCapabilities(track?.getCapabilities?.() || null);
      setSettings(appliedSettings);
      setTorchOn(false);
      setIsActive(true);
    } catch (err) {
      if (request !== requestRef.current) return;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      console.error('[Camera] Error:', err);
      setError(getErrorMessage(err));
      setSettings(null);
      setIsActive(false);
    }
  }, [deviceId, facingMode, profile]);

  const refocus = useCallback(async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    setSettings(await applyCameraAutoModes(track, { focusOnly: true }));
  }, []);

  const stopCamera = useCallback(() => {
    requestRef.current++;
    frameBufferRef.current.clear();
    setCaptureQuality(null);
    setSettings(null);
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setTorchOn(false);
    setIsActive(false);
  }, []);

  const toggleTorch = useCallback(async () => {
    if (!streamRef.current) return;
    const track = streamRef.current.getVideoTracks()[0];
    if (!track) return;
    const caps = track.getCapabilities?.();
    if (!supportsTorch(caps)) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next }] });
      setTorchOn(next);
    } catch (err) {
      console.error('[Camera] Torch error:', err);
    }
  }, [torchOn]);

  const toggleFacing = useCallback(() => {
    const newMode = facingMode === 'environment' ? 'user' : 'environment';
    setFacingMode(newMode);
  }, [facingMode]);

  // Restart camera only when an active stream's selected camera changes.
  useEffect(() => {
    const previous = cameraConfigRef.current;
    const changed = previous.deviceId !== deviceId || previous.facingMode !== facingMode || previous.profile !== profile;
    cameraConfigRef.current = { deviceId, facingMode, profile };

    if (isActive && changed) {
      startCamera();
    }
  }, [deviceId, facingMode, profile, isActive, startCamera]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      requestRef.current++;
      frameBufferRef.current.clear();
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
      }
    };
  }, []);

  const sampleFrame = useCallback(() => {
    const video = videoRef.current;
    if (!streamRef.current || !video?.videoWidth || !video.videoHeight) return null;
    const buffer = frameBufferRef.current;
    if (buffer.lastVideoTime === video.currentTime) return null;
    const region = getVideoScanRegion(video.videoWidth, video.videoHeight, video.clientWidth, video.clientHeight);
    const canvas = document.createElement('canvas');
    canvas.width = region.width;
    canvas.height = region.height;
    canvas.getContext('2d').drawImage(video, region.x, region.y, region.width, region.height, 0, 0, canvas.width, canvas.height);
    const quality = readCanvasQuality(canvas, region.guide);
    const frame = { canvas, quality, region, frameId: ++frameSequenceRef.current, capturedAt: Date.now(), layoutKey: JSON.stringify(region) };
    buffer.add(frame);
    buffer.lastVideoTime = video.currentTime;
    canvas.scanRegion = region;
    canvas.frameId = frame.frameId;
    canvas.capturedAt = frame.capturedAt;
    canvas.scanMoving = frame.moving;
    canvas.scanQuality = quality;
    emitScanDiagnostic('camera-frame',{frameId:frame.frameId,capturedAt:frame.capturedAt,videoTime:video.currentTime,motionEpoch:canvas.scanMotionEpoch,
      moving:frame.moving,region,quality:{acceptable:quality.acceptable,issue:quality.issue,score:quality.score,mean:quality.mean,sharpness:quality.sharpness}});
    const issue = frame.moving ? 'moving' : quality.issue;
    setCaptureQuality((previous) => previous?.issue === issue ? previous : { issue });
    return frame;
  }, []);

  useEffect(() => {
    if (!isActive) return undefined;
    const timer = setInterval(() => { sampleFrame(); }, 100);
    return () => clearInterval(timer);
  }, [isActive, sampleFrame]);

  const captureFrame = useCallback(() => {
    if (!isActive || !videoRef.current) return null;
    sampleFrame();
    return frameBufferRef.current.best(Date.now())?.canvas || null;
  }, [isActive, sampleFrame]);

  const hasTorch = supportsTorch(capabilities);
  const hasFocusControl = capabilities?.focusMode?.includes?.('continuous') === true;

  return {
    videoRef,
    isActive,
    error,
    facingMode,
    capabilities,
    settings,
    captureQuality,
    hasTorch,
    hasFocusControl,
    torchOn,
    startCamera,
    stopCamera,
    toggleFacing,
    toggleTorch,
    refocus,
    captureFrame,
  };
}

function getErrorMessage(err) {
  if (err.name === 'NotAllowedError') {
    return 'Camera permission denied. Please allow camera access in your browser settings.';
  }
  if (err.name === 'NotFoundError') {
    return 'No camera found on this device.';
  }
  if (err.name === 'NotReadableError') {
    return 'Camera is being used by another application.';
  }
  if (err.name === 'OverconstrainedError') {
    return 'Camera does not support the requested resolution.';
  }
  return `Camera error: ${err.message}`;
}
