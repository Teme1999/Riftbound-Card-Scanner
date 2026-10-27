import { useCallback, useEffect, useRef, useState } from 'react';
import { SCAN_SOUND_STORAGE_KEY, normalizeScanSound, ScanSoundPlayer } from '../lib/scanSound.js';

export function useScanSound() {
  const [settings, setSettings] = useState(() => {
    try { return normalizeScanSound(JSON.parse(localStorage.getItem(SCAN_SOUND_STORAGE_KEY))); }
    catch { return normalizeScanSound(null); }
  });
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const playerRef = useRef(null);
  if (!playerRef.current) playerRef.current = new ScanSoundPlayer();

  useEffect(() => {
    try { localStorage.setItem(SCAN_SOUND_STORAGE_KEY, JSON.stringify(settings)); } catch { /* Keep session settings. */ }
  }, [settings]);

  useEffect(() => {
    if (!settings.enabled || settings.volume <= 0) return undefined;
    const unlock = () => { void playerRef.current.unlock(); };
    document.addEventListener('pointerdown', unlock, { capture: true, passive: true });
    document.addEventListener('keydown', unlock, true);
    return () => {
      document.removeEventListener('pointerdown', unlock, true);
      document.removeEventListener('keydown', unlock, true);
    };
  }, [settings.enabled, settings.volume]);

  useEffect(() => () => playerRef.current.dispose(), []);

  const updateSettings = useCallback((patch) => {
    const next = normalizeScanSound({ ...settingsRef.current, ...patch });
    settingsRef.current = next;
    setSettings(next);
    if (next.enabled && next.volume > 0) void playerRef.current.unlock();
  }, []);

  const playScanAccepted = useCallback(() => {
    const current = settingsRef.current;
    return current.enabled && playerRef.current.play(current.volume);
  }, []);

  const testSound = useCallback(async () => {
    if (settingsRef.current.volume <= 0 || !await playerRef.current.unlock()) return false;
    return playerRef.current.play(settingsRef.current.volume);
  }, []);

  return { settings, updateSettings, playScanAccepted, testSound };
}
