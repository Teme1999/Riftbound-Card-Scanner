import { useCallback, useEffect, useRef, useState } from 'react';
import { ScanSessionRecording, recordingMimeType } from '../lib/scanSessionRecording.js';
import { isDesktopRuntime } from '../lib/runtime.js';
import { SCANNER_DIAGNOSTICS_AVAILABLE } from '../lib/scannerExperiments.js';

export function useScanSessionRecording({ videoRef, active, contextKey, metadata }) {
  active=SCANNER_DIAGNOSTICS_AVAILABLE && active;
  const [state,setState] = useState({status:'idle'});
  const controller = useRef(null), latest = useRef(null), previousContext = useRef(contextKey);
  if (!controller.current) controller.current = new ScanSessionRecording({onState:setState});
  latest.current = {active,metadata};
  const start = useCallback(() => {
    if (latest.current.active) return controller.current.start(videoRef.current,latest.current.metadata);
  },[videoRef]);
  const stop = useCallback(() => controller.current.stop(),[]);
  useEffect(() => {
    if (!active || previousContext.current !== contextKey) controller.current.stop(active ? 'context-changed' : 'camera-or-debug-stopped');
    previousContext.current = contextKey;
  },[active,contextKey]);
  useEffect(() => {
    const stopOnExit = () => { controller.current.stop('window-closed'); };
    window.addEventListener('pagehide',stopOnExit);
    return () => { window.removeEventListener('pagehide',stopOnExit);controller.current.stop('view-closed'); };
  },[]);
  return {state,supported:SCANNER_DIAGNOSTICS_AVAILABLE && isDesktopRuntime() && Boolean(recordingMimeType()),start,stop};
}
