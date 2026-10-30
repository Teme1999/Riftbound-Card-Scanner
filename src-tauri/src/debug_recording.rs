use serde::Serialize;
use serde_json::{json, Value};
use std::{fs::{self, File, OpenOptions}, io::Write, path::Path, sync::{Arc, Mutex}, time::{Instant, SystemTime, UNIX_EPOCH}};

const MAX_VIDEO_BYTES: usize = 128 * 1024 * 1024;
const MAX_LOG_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingPaths { id: String, video_path: String, events_path: String }

struct ActiveRecording {
  paths: RecordingPaths, video: File, log: File, sequence: u32,
  video_bytes: usize, log_bytes: usize, started: Instant, webm: bool,
  owner: String,
}

#[derive(Default)]
pub struct RecordingStore { active: Option<ActiveRecording> }
pub type RecordingState = Arc<Mutex<RecordingStore>>;

impl RecordingStore {
  fn start(&mut self, directory: &Path, mime: &str, owner: &str, metadata: Value) -> Result<RecordingPaths, String> {
    if owner.is_empty() || owner.len() > 100 { return Err("Invalid recording owner.".into()); }
    let extension = match mime.split(';').next() { Some("video/webm") => "webm", Some("video/mp4") => "mp4", _ => return Err("Unsupported recording format.".into()) };
    let header = serde_json::to_vec(&json!({"type":"session-start","schemaVersion":1,"metadata":metadata,"mimeType":mime})).map_err(|e| e.to_string())?;
    if header.len() > 32 * 1024 { return Err("Recording metadata is too large.".into()); }
    if let Some(active) = self.active.as_ref() {
      if active.owner == owner { return Err("A scan recording is already running.".into()); }
      // A renderer reload can interrupt pagehide before its final IPC call.
      // Close that partial journal without blocking the new page's recording.
      let id=active.paths.id.clone();
      let _=self.finish(&id,json!({"reason":"renderer-reloaded","partial":true}));
    }
    fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let id = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos().to_string();
    let stem = format!("riftbound-scan-session-{}", id);
    let video_path = directory.join(format!("{}.{}", stem, extension));
    let events_path = directory.join(format!("{}.jsonl", stem));
    let video = OpenOptions::new().write(true).create_new(true).open(&video_path).map_err(|e| e.to_string())?;
    let mut log = match OpenOptions::new().write(true).create_new(true).open(&events_path) {
      Ok(file) => file, Err(error) => { drop(video); let _ = fs::remove_file(&video_path); return Err(error.to_string()); }
    };
    if let Err(error) = log.write_all(&header).and_then(|_| log.write_all(b"\n")) {
      drop(video); drop(log); let _ = fs::remove_file(&video_path); let _ = fs::remove_file(&events_path); return Err(error.to_string());
    }
    let paths = RecordingPaths { id, video_path: video_path.to_string_lossy().into_owned(), events_path: events_path.to_string_lossy().into_owned() };
    self.active = Some(ActiveRecording { paths: paths.clone(), video, log, sequence: 0, video_bytes: 0,
      log_bytes: header.len()+1, started: Instant::now(), webm: extension == "webm", owner:owner.to_string() });
    Ok(paths)
  }
  fn active(&mut self, id: &str) -> Result<&mut ActiveRecording, String> {
    self.active.as_mut().filter(|r| r.paths.id == id).ok_or_else(|| "This scan recording is no longer active.".into())
  }
  fn append_video(&mut self, id: &str, sequence: u32, bytes: &[u8]) -> Result<(), String> {
    let r = self.active(id)?;
    if sequence != r.sequence { return Err("Out-of-order recording chunk.".into()); }
    if bytes.is_empty() || bytes.len() > 8*1024*1024 || r.video_bytes + bytes.len() > MAX_VIDEO_BYTES || r.started.elapsed().as_secs() > 360 {
      return Err("Recording size or duration limit reached.".into());
    }
    if sequence == 0 && !(if r.webm { bytes.starts_with(b"\x1a\x45\xdf\xa3") } else { bytes.get(4..8) == Some(b"ftyp") }) {
      return Err("The recording has an invalid video header.".into());
    }
    r.video.write_all(bytes).map_err(|e| e.to_string())?;
    r.video_bytes += bytes.len(); r.sequence += 1; Ok(())
  }
  fn append_events(&mut self, id: &str, events: &[Value]) -> Result<(), String> {
    if events.len() > 512 { return Err("Too many recording events in one batch.".into()); }
    let mut bytes = Vec::new();
    for event in events { serde_json::to_writer(&mut bytes, event).map_err(|e| e.to_string())?; bytes.push(b'\n'); }
    let r = self.active(id)?;
    if bytes.len() > 256*1024 || r.log_bytes + bytes.len() > MAX_LOG_BYTES { return Err("Recording event limit reached.".into()); }
    r.log.write_all(&bytes).map_err(|e| e.to_string())?; r.log_bytes += bytes.len(); Ok(())
  }
  fn finish(&mut self, id: &str, summary: Value) -> Result<RecordingPaths, String> {
    self.active(id)?;
    let mut r = self.active.take().unwrap();
    let end = serde_json::to_vec(&json!({"type":"session-end","videoBytes":r.video_bytes,"chunks":r.sequence,"summary":summary})).map_err(|e| e.to_string())?;
    if end.len() > 32*1024 { return Err("Recording summary is too large; partial files were retained.".into()); }
    r.log.write_all(&end).and_then(|_| r.log.write_all(b"\n")).and_then(|_| r.log.sync_all()).map_err(|e| e.to_string())?;
    r.video.sync_all().map_err(|e| e.to_string())?;
    if r.video_bytes == 0 { return Err("No video frames were recorded; the event log was retained.".into()); }
    Ok(r.paths)
  }
}

#[tauri::command]
pub async fn start_debug_recording(state: tauri::State<'_, RecordingState>, mime_type: String, owner: String, metadata: Value) -> Result<RecordingPaths, String> {
  let state = state.inner().clone(); let directory = super::card_cache_directory()?.with_file_name("debug-recordings");
  tauri::async_runtime::spawn_blocking(move || state.lock().map_err(|e| e.to_string())?.start(&directory, &mime_type, &owner, metadata)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn append_debug_recording(request: tauri::ipc::Request<'_>, state: tauri::State<'_, RecordingState>) -> Result<(), String> {
  let id = request.headers().get("x-recording-id").and_then(|h| h.to_str().ok()).ok_or("Missing recording ID.")?.to_owned();
  let sequence = request.headers().get("x-chunk-index").and_then(|h| h.to_str().ok()).and_then(|v| v.parse::<u32>().ok()).ok_or("Missing chunk sequence.")?;
  let bytes = match request.body() { tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(), _ => return Err("Video chunks must use binary IPC.".into()) };
  let state = state.inner().clone();
  tauri::async_runtime::spawn_blocking(move || state.lock().map_err(|e| e.to_string())?.append_video(&id, sequence, &bytes)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn record_debug_events(state: tauri::State<'_, RecordingState>, id: String, events: Vec<Value>) -> Result<(), String> {
  let state = state.inner().clone();
  tauri::async_runtime::spawn_blocking(move || state.lock().map_err(|e| e.to_string())?.append_events(&id, &events)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn finish_debug_recording(state: tauri::State<'_, RecordingState>, id: String, summary: Value) -> Result<RecordingPaths, String> {
  let state = state.inner().clone();
  tauri::async_runtime::spawn_blocking(move || state.lock().map_err(|e| e.to_string())?.finish(&id, summary)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
  use super::*;
  fn directory() -> std::path::PathBuf { std::env::temp_dir().join(format!("riftbound-recording-test-{}-{}",std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos())) }
  #[test]
  fn streams_ordered_video_and_events_and_rejects_foreign_or_late_writes() {
    let directory=directory(); let mut store=RecordingStore::default();
    let paths=store.start(&directory,"video/webm;codecs=vp8","page-1",json!({"appVersion":"test"})).unwrap();
    assert!(store.start(&directory,"video/webm","page-1",json!({})).is_err());
    assert!(store.append_video("../other",0,b"\x1a\x45\xdf\xa3").is_err());
    assert!(store.append_video(&paths.id,1,b"later").is_err());
    assert!(store.append_video(&paths.id,0,b"invalid").is_err());
    store.append_video(&paths.id,0,b"\x1a\x45\xdf\xa3first").unwrap();
    store.append_events(&paths.id,&[json!({"type":"observation","tMs":20}),json!({"type":"accepted","tMs":80})]).unwrap();
    store.append_video(&paths.id,1,b"last").unwrap();
    store.finish(&paths.id,json!({"reason":"user","durationMs":100})).unwrap();
    assert_eq!(fs::read(&paths.video_path).unwrap(),b"\x1a\x45\xdf\xa3firstlast");
    let lines:Vec<Value>=fs::read_to_string(&paths.events_path).unwrap().lines().map(|line|serde_json::from_str(line).unwrap()).collect();
    assert_eq!(lines.len(),4); assert_eq!(lines[3]["type"],"session-end");
    assert!(store.append_events(&paths.id,&[]).is_err());
    let next=store.start(&directory,"video/mp4","page-1",json!({})).unwrap();
    assert_ne!(next.id,paths.id);store.append_video(&next.id,0,b"\x00\x00\x00\x18ftypisom").unwrap();store.finish(&next.id,json!({})).unwrap();
    for entry in fs::read_dir(&directory).unwrap(){fs::remove_file(entry.unwrap().path()).unwrap();}fs::remove_dir(directory).unwrap();
  }
  #[test]
  fn bounds_payloads_and_retains_partial_files_on_failure() {
    let directory=directory();let mut store=RecordingStore::default();
    assert!(store.start(&directory,"../arbitrary","page-1",json!({})).is_err());assert!(!directory.exists());
    let paths=store.start(&directory,"video/webm","page-1",json!({})).unwrap();
    assert!(store.append_events(&paths.id,&[json!({"tooLarge":"x".repeat(257*1024)})]).is_err());
    assert!(store.append_video(&paths.id,0,&vec![0;8*1024*1024+1]).is_err());
    assert!(store.finish(&paths.id,json!({"reason":"encoder-error"})).is_err());assert!(store.active.is_none());
    assert!(Path::new(&paths.events_path).is_file());assert!(Path::new(&paths.video_path).is_file());
    fs::remove_file(paths.events_path).unwrap();fs::remove_file(paths.video_path).unwrap();fs::remove_dir(directory).unwrap();
  }
  #[test]
  fn renderer_reload_retains_the_old_recording_and_releases_its_handle() {
    let directory=directory();let mut store=RecordingStore::default();
    let old=store.start(&directory,"video/webm","old-page",json!({})).unwrap();
    store.append_video(&old.id,0,b"\x1a\x45\xdf\xa3old").unwrap();
    let new=store.start(&directory,"video/webm","new-page",json!({})).unwrap();
    assert!(fs::read_to_string(&old.events_path).unwrap().contains("renderer-reloaded"));
    assert!(store.append_video(&old.id,1,b"late").is_err());
    store.append_video(&new.id,0,b"\x1a\x45\xdf\xa3new").unwrap();store.finish(&new.id,json!({})).unwrap();
    for entry in fs::read_dir(&directory).unwrap(){fs::remove_file(entry.unwrap().path()).unwrap();}fs::remove_dir(directory).unwrap();
  }
}
