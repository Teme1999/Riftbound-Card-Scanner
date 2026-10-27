export const SCAN_SOUND_STORAGE_KEY = 'riftbound_scan_sound';
export const DEFAULT_SCAN_SOUND = Object.freeze({ enabled: true, volume: 0.35 });

export function normalizeScanSound(value) {
  return {
    enabled: typeof value?.enabled === 'boolean' ? value.enabled : DEFAULT_SCAN_SOUND.enabled,
    volume: Number.isFinite(value?.volume) ? Math.max(0, Math.min(1, value.volume)) : DEFAULT_SCAN_SOUND.volume,
  };
}

// Generated locally: no audio file, download, or extra CSP permission needed.
export function scheduleScanChime(context, volume, active = new Set()) {
  const level = normalizeScanSound({ volume }).volume;
  if (level <= 0) return false;
  const start = context.currentTime + 0.005;
  for (const [frequency, offset] of [[523.25, 0], [659.25, 0.085]]) {
    const oscillator = context.createOscillator(), gain = context.createGain();
    const node = { oscillator, gain };
    active.add(node);
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(frequency, start + offset);
    gain.gain.setValueAtTime(0, start + offset);
    gain.gain.linearRampToValueAtTime(level * 0.18, start + offset + 0.008);
    gain.gain.linearRampToValueAtTime(0, start + offset + 0.14);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.onended = () => {
      oscillator.disconnect(); gain.disconnect(); active.delete(node);
    };
    oscillator.start(start + offset);
    oscillator.stop(start + offset + 0.15);
  }
  return true;
}

export class ScanSoundPlayer {
  constructor(createContext = () => {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    return AudioContext ? new AudioContext() : null;
  }) {
    this.createContext = createContext;
    this.context = null;
    this.active = new Set();
  }

  // Call during a user gesture, before any camera/inference await. Acceptance
  // itself never resumes suspended audio or queues stale sounds for later.
  async unlock() {
    try {
      if (!this.context || this.context.state === 'closed') this.context = this.createContext();
      if (!this.context) return false;
      if (this.context.state !== 'running') await this.context.resume();
      return this.context?.state === 'running';
    } catch { return false; }
  }

  play(volume) {
    if (this.context?.state !== 'running') return false;
    try { return scheduleScanChime(this.context, volume, this.active); }
    catch { return false; } // Audio must never prevent accepting a scanned card.
  }

  dispose() {
    for (const { oscillator, gain } of this.active) {
      try { oscillator.stop(); oscillator.disconnect(); gain.disconnect(); } catch { /* Already ended. */ }
    }
    this.active.clear();
    const context = this.context;
    this.context = null;
    try { context?.close()?.catch?.(() => {}); } catch { /* Audio unavailable. */ }
  }
}
