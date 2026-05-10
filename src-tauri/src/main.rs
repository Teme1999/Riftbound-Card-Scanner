#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::{fs, path::Path};
use url::Url;

const MAX_CARD_DATABASE_BYTES: u64 = 64 * 1024 * 1024;
const ALLOWED_EXTERNAL_HOSTS: &[&str] = &["github.com"];

#[derive(Serialize)]
struct RuntimeInfo {
  platform: String,
  arch: String,
  desktop: bool,
}

#[tauri::command]
fn runtime_info() -> RuntimeInfo {
  RuntimeInfo {
    platform: std::env::consts::OS.to_string(),
    arch: std::env::consts::ARCH.to_string(),
    desktop: true,
  }
}

#[tauri::command]
fn import_card_database(file_path: String) -> Result<String, String> {
  let path = Path::new(&file_path);
  let extension = path
    .extension()
    .and_then(|value| value.to_str())
    .unwrap_or_default()
    .to_ascii_lowercase();

  if extension != "json" {
    return Err("Card database imports must be .json files.".to_string());
  }

  let metadata = fs::metadata(path)
    .map_err(|error| format!("Failed to inspect card database at {}: {}", file_path, error))?;

  if !metadata.is_file() {
    return Err("Selected card database path is not a file.".to_string());
  }

  if metadata.len() > MAX_CARD_DATABASE_BYTES {
    return Err(format!(
      "Selected card database is too large. Maximum size is {} MB.",
      MAX_CARD_DATABASE_BYTES / 1024 / 1024
    ));
  }

  fs::read_to_string(path)
    .map_err(|error| format!("Failed to read card database at {}: {}", file_path, error))
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
  let parsed = Url::parse(&url).map_err(|error| format!("Invalid external URL: {}", error))?;

  if parsed.scheme() != "https" {
    return Err("Only HTTPS external links are allowed.".to_string());
  }

  let host = parsed
    .host_str()
    .ok_or_else(|| "External URL must include a host.".to_string())?;

  if !ALLOWED_EXTERNAL_HOSTS.contains(&host) {
    return Err(format!("External host is not allowed: {}", host));
  }

  webbrowser::open(parsed.as_str())
    .map(|_| ())
    .map_err(|error| format!("Failed to open external URL {}: {}", parsed, error))
}

fn main() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .invoke_handler(tauri::generate_handler![runtime_info, import_card_database, open_external_url])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
