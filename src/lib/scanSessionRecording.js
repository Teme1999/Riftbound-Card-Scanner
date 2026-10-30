import { invokeDesktopCommand, invokeDesktopBinaryCommand } from './desktopBridge.js';
import { subscribeScanDiagnostics } from './scanDiagnostics.js';
import { nativeFrameDiagnostics } from './nativeFrame.js';

export const SCAN_RECORDING_MAX_MS = 5 * 60 * 1000;
const MAX_QUEUED_BYTES = 8 * 1024 * 1024;
const clock = () => globalThis.performance?.now?.() ?? Date.now();
const message = error => String(error?.message || error);
const PAGE_OWNER = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;

export function recordingMimeType(Recorder = globalThis.MediaRecorder) {
  return ['video/webm;codecs=vp8','video/webm','video/mp4'].find(type => Recorder?.isTypeSupported?.(type)) || null;
}

export function scanRecordingMetadata(context = {}) {
  const cameraKeys = ['width','height','frameRate','focusMode','exposureMode','whiteBalanceMode'];
  return { appVersion: __APP_RELEASE_VERSION__, buildTime: __BUILD_TIME__,
    perspective: context.perspective === true, textVerification: context.textVerification === true,
    detectorModel: context.detectorModel, cameraProfile: context.cameraProfile,
    setFilter: Array.isArray(context.setFilter) ? context.setFilter.map(String) : 'all',
    cameraSettings: Object.fromEntries(cameraKeys.filter(key => context.cameraSettings?.[key] !== undefined).map(key => [key,context.cameraSettings[key]])),
    video: { content: 'camera-only', audio: false, videoBitsPerSecond: 1500000 },
    timeline: { format: 'jsonl', clock: 'monotonic milliseconds from recorder.start()', maxDurationMs: SCAN_RECORDING_MAX_MS } };
}

// Video encoding reads a clone of the existing camera track. It does not draw
// extra canvases, request another camera/microphone, or change camera settings.
export class ScanSessionRecording {
  constructor({ invoke = invokeDesktopCommand, invokeBinary = invokeDesktopBinaryCommand,
    Recorder = globalThis.MediaRecorder, Stream = globalThis.MediaStream, now = clock, onState = () => {},
    every = (fn,ms) => setInterval(fn,ms), clearEvery = id => clearInterval(id),
    later = (fn,ms) => setTimeout(fn,ms), clearLater = id => clearTimeout(id) } = {}) {
    Object.assign(this,{invoke,invokeBinary,Recorder,Stream,now,onState,every,clearEvery,later,clearLater});
    this.session = null;
  }
  state(session, status, extra = {}) {
    if (this.session !== session) return;
    session.status = status;
    this.onState({ status, elapsedMs: Math.max(0,this.now()-(session.startedAt ?? this.now())),
      bytes: session.bytes || 0, ...session.paths, ...extra });
  }
  start(video, context) {
    if (this.session && ['starting','recording','stopping'].includes(this.session.status)) return this.session.startPromise;
    const session = { status:'starting', video, events:[], pending:Promise.resolve(), queuedBytes:0, bytes:0, sequence:0 };
    this.session = session;this.state(session,'starting');
    session.startPromise = this.startSession(session,context);
    return session.startPromise;
  }
  async startSession(session, context) {
    try {
      const mimeType = recordingMimeType(this.Recorder);
      const tracks = session.video?.srcObject?.getVideoTracks?.().filter(track => track.readyState === 'live');
      if (!mimeType) throw new Error('Camera video recording is unavailable in this WebView.');
      if (!tracks?.length) throw new Error('Start the camera before recording a scan session.');
      session.tracks = tracks.map(track => track.clone());
      const recorder = session.recorder = new this.Recorder(new this.Stream(session.tracks),{mimeType,videoBitsPerSecond:1500000});
      session.paths = await this.invoke('start_debug_recording',{mimeType,owner:PAGE_OWNER,metadata:scanRecordingMetadata(context)});
      if (session.stopRequested) { await this.finish(session);return; }
      recorder.onstart = () => {
        if (this.session !== session || session.finishPromise) return;
        if (session.stopRequested) return;
        this.state(session,'recording');
        this.event('video-start',{wallTime:Date.now(),videoTime:session.video.currentTime,
          notificationDelayMs:this.now()-session.startedAt,
          width:session.video.videoWidth,height:session.video.videoHeight});
        session.timer = this.every(() => { this.flush(session);this.state(session,'recording'); },1000);
        session.limit = this.later(() => this.stop('duration-limit'),SCAN_RECORDING_MAX_MS);
      };
      recorder.ondataavailable = ({ data }) => {
        if (!data?.size || this.session !== session || session.finishPromise) return;
        const sequence = session.sequence++;
        session.queuedBytes += data.size;
        this.enqueue(session,async () => {
          try {
            const bytes = new Uint8Array(await data.arrayBuffer());
            await this.invokeBinary('append_debug_recording',bytes,{'x-recording-id':session.paths.id,'x-chunk-index':String(sequence)});
            session.bytes += bytes.byteLength;
          } finally { session.queuedBytes -= data.size; }
        });
        if (session.queuedBytes > MAX_QUEUED_BYTES) this.stop('storage-backlog');
      };
      recorder.onerror = event => {
        if (this.session !== session || session.finishPromise) return;
        session.error = message(event.error || 'Video encoder failed.');this.stop('encoder-error');
      };
      recorder.onstop = () => { session.recorderStopped = true;this.finish(session); };
      session.tracks.forEach(track => track.addEventListener?.('ended',() => { if (this.session === session) this.stop('camera-ended'); },{once:true}));
      session.stopped = new Promise(resolve => { session.resolveStopped = resolve; });
      session.startedAt=this.now();
      session.unsubscribe=subscribeScanDiagnostics((type,details)=>this.event(type,details));
      this.event('video-start-request',{wallTime:Date.now(),videoTime:session.video.currentTime});
      recorder.start(1000);session.started = true;
    } catch (error) {
      session.error = message(error);session.stopRequested ||= 'start-error';
      if (session.paths) await this.finish(session);
      else { this.cleanup(session);this.state(session,'error',{error:session.error}); }
    }
  }
  event(type, details = {}) {
    const session = this.session;
    if (!session || session.startedAt == null || !['starting','recording','stopping'].includes(session.status)) return;
    // Recognition results are explicitly sanitized; attached source canvases,
    // collection rows and device IDs never enter the event journal.
    const { result, ...rest } = details;
    const entry = { type, tMs:Math.max(0,this.now()-session.startedAt), ...rest,
      ...(result ? {result:nativeFrameDiagnostics(null,result).recognition} : {}) };
    session.events.push(entry);
    if (session.events.length >= 64) this.flush(session);
  }
  enqueue(session, job) {
    session.pending = session.pending.then(async () => { if (!session.writeError) await job(); }).catch(error => {
      session.writeError = message(error);this.stop('write-error');
    });
  }
  flush(session) {
    while (session.events.length) {
      const events = session.events.splice(0,64);
      this.enqueue(session,() => this.invoke('record_debug_events',{id:session.paths.id,events}));
    }
  }
  stop(reason = 'user') {
    const session = this.session;
    if (!session || ['saved','error'].includes(session.status)) return Promise.resolve();
    session.stopRequested ||= reason;
    if (!session.paths || !session.recorder) return session.startPromise?.then(() => session.finishPromise);
    if (session.finishPromise) return session.finishPromise;
    this.state(session,'stopping');
    if (session.started && !session.recorderStopped) {
      if (!session.stopIssued) {
        session.stopIssued = true;
        session.stopWatchdog = this.later(() => { session.error ||= 'The video encoder did not finish.';this.finish(session); },10000);
        if (session.recorder.state !== 'inactive') session.recorder.stop();
      }
      return session.stopped;
    }
    return this.finish(session);
  }
  cleanup(session) {
    session.unsubscribe?.();this.clearEvery(session.timer);this.clearLater(session.limit);this.clearLater(session.stopWatchdog);
    session.tracks?.forEach(track => track.stop());
  }
  finish(session) {
    if (session.finishPromise) return session.finishPromise;
    this.event('video-stop',{reason:session.stopRequested || 'camera-ended',videoTime:session.video?.currentTime});
    const durationMs = session.startedAt == null ? 0 : Math.max(0,this.now()-session.startedAt);
    this.cleanup(session);this.state(session,'stopping');this.flush(session);
    session.finishPromise = (async () => {
      await session.pending;
      try {
        const summary = {reason:session.stopRequested || 'camera-ended',durationMs,
          error:session.error || session.writeError || (session.bytes ? null : 'No video frames were recorded.'),videoBytes:session.bytes};
        const paths = await this.invoke('finish_debug_recording',{id:session.paths.id,summary});
        if (summary.error) throw new Error(summary.error);
        this.state(session,'saved',{...paths,elapsedMs:durationMs,stopReason:summary.reason});
      } catch (error) { this.state(session,'error',{error:message(error),elapsedMs:durationMs,partial:true}); }
      finally { session.resolveStopped?.(); }
    })();
    return session.finishPromise;
  }
}
