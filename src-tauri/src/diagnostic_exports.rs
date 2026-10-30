use super::card_cache_directory;
use serde::Serialize;
use serde_json::Value;
use std::{fs, io::Write, path::Path, time::{SystemTime, UNIX_EPOCH}};

pub fn native_frame_directory() -> Result<std::path::PathBuf, String> {
  Ok(card_cache_directory()?.with_file_name("native-frames"))
}

pub fn debug_scan_directory() -> Result<std::path::PathBuf, String> {
  Ok(card_cache_directory()?.with_file_name("debug-scans"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugScanSave {
  path: String,
  annotated_path: String,
  diagnostics_path: String,
}

#[tauri::command]
pub async fn save_debug_scan(raw_png: Vec<u8>, annotated_png: Vec<u8>, diagnostics: Value) -> Result<DebugScanSave, String> {
  let directory = debug_scan_directory()?;
  tauri::async_runtime::spawn_blocking(move || save_debug_scan_files(&directory, &raw_png, &annotated_png, &diagnostics))
    .await.map_err(|error| error.to_string())?
}

fn save_debug_scan_files(directory: &Path, raw_png: &[u8], annotated_png: &[u8], diagnostics: &Value) -> Result<DebugScanSave, String> {
  for png in [raw_png, annotated_png] {
    if png.len() > 32 * 1024 * 1024 || !png.starts_with(b"\x89PNG\r\n\x1a\n") {
      return Err("Debug images must be PNG files smaller than 32 MB.".to_string());
    }
  }
  let details = serde_json::to_vec_pretty(diagnostics).map_err(|error| error.to_string())?;
  if details.len() > 128 * 1024 { return Err("The scan details exceed the 128 KB limit.".to_string()); }
  fs::create_dir_all(directory).map_err(|error| error.to_string())?;
  let timestamp = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|error| error.to_string())?.as_nanos();
  let stem = format!("riftbound-debug-scan-{}", timestamp);
  write_debug_scan_bundle(directory, &stem, raw_png, annotated_png, &details)
}

fn write_debug_scan_bundle(directory: &Path, stem: &str, raw_png: &[u8], annotated_png: &[u8], details: &[u8]) -> Result<DebugScanSave, String> {
  let raw_path = directory.join(format!("{}.png", stem));
  let annotated_path = directory.join(format!("{}-debug.png", stem));
  let details_path = directory.join(format!("{}.json", stem));
  let mut created = Vec::new();
  for (path, bytes) in [(&raw_path, raw_png), (&annotated_path, annotated_png), (&details_path, details)] {
    if let Err(error) = write_new_file(path, bytes) {
      for owned in created { let _ = fs::remove_file(owned); }
      return Err(error);
    }
    created.push(path.clone());
  }
  Ok(DebugScanSave { path: raw_path.to_string_lossy().into_owned(), annotated_path: annotated_path.to_string_lossy().into_owned(),
    diagnostics_path: details_path.to_string_lossy().into_owned() })
}

#[tauri::command]
pub async fn save_native_frame(png: Vec<u8>, diagnostics: Option<Value>) -> Result<NativeFrameSave, String> {
  save_native_frame_files(&native_frame_directory()?, &png, diagnostics)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeFrameSave {
  path: String,
  diagnostics_path: Option<String>,
  diagnostics_error: Option<String>,
}

fn write_new_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
  let mut file = fs::OpenOptions::new().write(true).create_new(true).open(path)
    .map_err(|error| format!("Could not create {}: {}", path.display(), error))?;
  if let Err(error) = file.write_all(bytes) {
    drop(file);
    let _ = fs::remove_file(path);
    return Err(format!("Could not save {}: {}", path.display(), error));
  }
  Ok(())
}

fn save_native_frame_files(directory: &Path, png: &[u8], diagnostics: Option<Value>) -> Result<NativeFrameSave, String> {
  if png.len() > 32 * 1024 * 1024 || !png.starts_with(b"\x89PNG\r\n\x1a\n") {
    return Err("The camera frame must be a PNG smaller than 32 MB.".to_string());
  }
  let details = diagnostics.map(|value| serde_json::to_vec_pretty(&value)).transpose().map_err(|error| error.to_string())?;
  if details.as_ref().is_some_and(|bytes| bytes.len() > 128 * 1024) {
    return Err("The scan details exceed the 128 KB limit.".to_string());
  }
  fs::create_dir_all(directory)
    .map_err(|error| format!("Could not create the frame folder: {}", error))?;
  let timestamp = SystemTime::now().duration_since(UNIX_EPOCH)
    .map_err(|error| error.to_string())?.as_nanos();
  let path = directory.join(format!("riftbound-native-frame-{}.png", timestamp));
  write_new_file(&path, png)?;
  let mut saved = NativeFrameSave { path: path.to_string_lossy().into_owned(), diagnostics_path: None, diagnostics_error: None };
  if let Some(bytes) = details {
    let details_path = path.with_extension("json");
    match write_new_file(&details_path, &bytes) {
      Ok(()) => saved.diagnostics_path = Some(details_path.to_string_lossy().into_owned()),
      Err(error) => saved.diagnostics_error = Some(format!("The image was saved, but scan details could not be saved: {}", error)),
    }
  }
  Ok(saved)
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  fn generated_png(shade: u8) -> Vec<u8> {
    let image = image::RgbImage::from_pixel(2, 2, image::Rgb([shade, shade, shade]));
    let mut output = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(image).write_to(&mut output, image::ImageFormat::Png).unwrap();
    output.into_inner()
  }

  #[test]
  fn native_frame_keeps_png_bytes_and_writes_associated_scan_details() {
    let directory = std::env::temp_dir().join(format!("riftbound-frame-test-{}-{}", std::process::id(),
      SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
    let generated = generated_png(64);
    let png = generated.as_slice();
    let details = json!({"capture":{"frameId":12},"recognition":{"frameId":11,"matched":false,"reason":"reading-text"}});
    let saved = save_native_frame_files(&directory, png, Some(details.clone())).unwrap();
    assert_eq!(fs::read(&saved.path).unwrap(), png);
    assert_eq!(serde_json::from_slice::<Value>(&fs::read(saved.diagnostics_path.as_ref().unwrap()).unwrap()).unwrap(), details);
    assert!(saved.diagnostics_error.is_none());
    assert_eq!(Path::new(&saved.path).file_stem(), Path::new(saved.diagnostics_path.as_ref().unwrap()).file_stem());
    assert!(write_new_file(Path::new(&saved.path), b"replacement").is_err());
    assert_eq!(fs::read(&saved.path).unwrap(), png);
    fs::remove_file(&saved.path).unwrap();fs::remove_file(saved.diagnostics_path.unwrap()).unwrap();fs::remove_dir(directory).unwrap();
  }

  #[test]
  fn invalid_diagnostic_exports_do_not_create_files() {
    let directory = std::env::temp_dir().join(format!("riftbound-frame-invalid-{}", std::process::id()));
    assert!(save_native_frame_files(&directory, b"not a PNG", None).is_err());
    assert!(save_native_frame_files(&directory, b"\x89PNG\r\n\x1a\n", Some(json!({"details":"x".repeat(129*1024)}))).is_err());
    assert!(!directory.exists());
  }

  #[test]
  fn debug_acceptance_writes_native_annotated_and_json_as_one_bundle() {
    let directory = std::env::temp_dir().join(format!("riftbound-debug-bundle-{}-{}", std::process::id(),
      SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
    let raw_bytes = generated_png(64);
    let annotated_bytes = generated_png(192);
    let raw = raw_bytes.as_slice();
    let annotated = annotated_bytes.as_slice();
    let details = json!({"mode":"debug-auto-scan","capture":{"frameId":11},"recognition":{"frameId":11,"matched":true}});
    let saved = save_debug_scan_files(&directory, raw, annotated, &details).unwrap();
    assert_eq!(fs::read(&saved.path).unwrap(), raw);
    assert_eq!(fs::read(&saved.annotated_path).unwrap(), annotated);
    assert_eq!(serde_json::from_slice::<Value>(&fs::read(&saved.diagnostics_path).unwrap()).unwrap(), details);
    assert_eq!(Path::new(&saved.path).file_stem(), Path::new(&saved.diagnostics_path).file_stem());
    assert_eq!(Path::new(&saved.path).parent(), Path::new(&saved.annotated_path).parent());
    fs::remove_file(saved.path).unwrap();fs::remove_file(saved.annotated_path).unwrap();fs::remove_file(saved.diagnostics_path).unwrap();
    fs::remove_dir(directory).unwrap();
  }

  #[test]
  fn failed_debug_bundle_cleans_only_new_files_and_never_overwrites_a_prior_image() {
    let directory = std::env::temp_dir().join(format!("riftbound-debug-failure-{}-{}", std::process::id(),
      SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
    let generated = generated_png(64);
    let png = generated.as_slice();
    assert!(save_debug_scan_files(&directory, png, b"not a PNG", &json!({})).is_err());
    assert!(!directory.exists());
    assert!(save_debug_scan_files(&directory, png, png, &json!({"tooLarge":"x".repeat(129*1024)})).is_err());
    assert!(!directory.exists());
    fs::create_dir(&directory).unwrap();let existing = directory.join("fixture-debug.png");
    fs::write(&existing, b"prior capture").unwrap();
    assert!(write_debug_scan_bundle(&directory, "fixture", png, png, b"{}").is_err());
    assert!(!directory.join("fixture.png").exists());assert!(!directory.join("fixture.json").exists());
    assert_eq!(fs::read(&existing).unwrap(), b"prior capture");
    fs::remove_file(existing).unwrap();fs::remove_dir(directory).unwrap();
  }
}
