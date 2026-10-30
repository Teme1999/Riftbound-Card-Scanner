import React, { useState } from 'react';
import { invokeDesktopCommand } from '../../lib/desktopBridge.js';

export default function ScanRecordingControls({recording}) {
  const [folderError,setFolderError] = useState(null);
  const state = recording.state, busy = ['starting','recording','stopping'].includes(state.status);
  const seconds = Math.floor((state.elapsedMs || 0)/1000);
  const stoppedBecause = {'duration-limit':'The 5-minute limit was reached.','storage-backlog':'Stopped because saving could not keep up.',
    'context-changed':'Stopped because scan settings changed.','camera-or-debug-stopped':'Stopped when the camera or debug view closed.',
    'camera-ended':'Stopped when the camera stream ended.'}[state.stopReason];
  return <div className="mt-3 border-t border-cyan-300/20 pt-2">
    <div className="font-semibold">Record full scan session</div>
    <div className="mt-1">Start before showing a card. Remove the last card before stopping. Camera video + timeline, up to 5 minutes.</div>
    {state.status === 'recording' ? <>
      <div role="status" className="mt-2 text-red-200">Recording {Math.floor(seconds/60)}:{String(seconds%60).padStart(2,'0')} · {((state.bytes||0)/1048576).toFixed(1)} MB</div>
      <button type="button" className="btn-secondary mt-2 text-xs" onClick={recording.stop}>Stop and save recording</button>
    </> : <button type="button" className="btn-secondary mt-2 text-xs" disabled={busy || !recording.supported} onClick={recording.start}>
      {state.status === 'starting' ? 'Starting recording...' : state.status === 'stopping' ? 'Saving recording...' : 'Start scan recording'}
    </button>}
    {!recording.supported && <div className="mt-1">Video recording requires a supported desktop WebView.</div>}
    {state.status === 'saved' && <div role="status" className="mt-2 text-emerald-100">Video and timeline saved.{stoppedBecause && <div>{stoppedBecause}</div>}
      <div className="break-all select-text">{state.videoPath}</div></div>}
    {state.status === 'error' && <div role="alert" className="mt-2 text-red-200">Recording failed: {state.error}
      {state.partial && <div>Available partial files were retained.</div>}</div>}
    {state.eventsPath && <button type="button" className="mt-2 underline" onClick={() => invokeDesktopCommand('open_storage_folder',{folder:'debug-recordings'}).catch(error=>setFolderError(String(error?.message||error)))}>Open recordings folder</button>}
    {folderError && <div role="alert">{folderError}</div>}
  </div>;
}
