#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use image::{imageops::{self, FilterType}, DynamicImage, RgbImage};
use directories::ProjectDirs;
use regex::Regex;
use reqwest::blocking::Client;
use serde::Serialize;
use serde_json::Value;
use std::{collections::HashSet, fs, path::Path, time::Duration};
use tauri::{Emitter, Manager};
use url::Url;
#[cfg(any(debug_assertions, test))]
mod debug_recording;
#[cfg(any(debug_assertions, test))]
mod diagnostic_exports;

const GALLERY_URL: &str = "https://playriftbound.com/en-us/card-gallery/";
const GRID_SIZE: usize = 16;
const ART_TOP: f32 = 0.05;
const ART_BOTTOM: f32 = 0.55;
const ART_LEFT: f32 = 0.05;
const ART_RIGHT: f32 = 0.95;

const ALLOWED_EXTERNAL_HOSTS: &[&str] = &["github.com"];
const CARD_DATABASE_PROGRESS_EVENT: &str = "card-database-progress";

#[derive(Serialize)]
struct RuntimeInfo {
  platform: String,
  arch: String,
  desktop: bool,
  storage: Option<StorageInfo>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StorageInfo {
  cards_directory: String,
  profile_directory: String,
}

fn card_cache_directory() -> Result<std::path::PathBuf, String> {
  ProjectDirs::from("com", "Teme1999", "RiftboundScanner")
    .map(|dirs| dirs.data_local_dir().join("cards"))
    .ok_or_else(|| "Could not resolve the card data directory.".to_string())
}

#[tauri::command]
fn runtime_info(app: tauri::AppHandle) -> RuntimeInfo {
  RuntimeInfo {
    platform: std::env::consts::OS.to_string(),
    arch: std::env::consts::ARCH.to_string(),
    desktop: true,
    storage: card_cache_directory().ok().zip(app.path().app_local_data_dir().ok())
      .map(|(cards, profile)| StorageInfo {
        cards_directory: cards.to_string_lossy().into_owned(),
        profile_directory: profile.join("EBWebView").to_string_lossy().into_owned(),
      }),
  }
}

#[tauri::command]
fn open_storage_folder(app: tauri::AppHandle, folder: String) -> Result<(), String> {
  let path = match folder.as_str() {
    "cards" => card_cache_directory()?,
    #[cfg(debug_assertions)]
    "native-frames" => diagnostic_exports::native_frame_directory()?,
    #[cfg(debug_assertions)]
    "debug-scans" => diagnostic_exports::debug_scan_directory()?,
    #[cfg(debug_assertions)]
    "debug-recordings" => card_cache_directory()?.with_file_name("debug-recordings"),
    "profile" => app.path().app_local_data_dir().map_err(|error| error.to_string())?.join("EBWebView"),
    _ => return Err("Unknown application data folder.".to_string()),
  };
  if !path.is_dir() { return Err("This data folder has not been created yet.".to_string()); }
  #[cfg(target_os = "windows")]
  {
    std::process::Command::new("explorer.exe").arg(path).spawn()
      .map(|_| ()).map_err(|error| format!("Could not open data folder: {}", error))
  }
  #[cfg(not(target_os = "windows"))]
  { Err("Opening data folders is supported in the Windows desktop build.".to_string()) }
}

#[derive(Serialize)]
struct CardHashesDatabase {
  #[serde(rename = "gridSize")]
  grid_size: usize,
  cards: Vec<CardHashRecord>,
  #[serde(rename = "skippedCards")]
  skipped_cards: usize,
}

#[derive(Serialize)]
struct CardHashRecord {
  id: String,
  name: String,
  number: String,
  code: String,
  set: String,
  #[serde(rename = "setName")]
  set_name: String,
  domain: Option<String>,
  domains: Vec<String>,
  rarity: String,
  #[serde(rename = "type")]
  card_type: String,
  energy: String,
  might: String,
  tags: Vec<String>,
  illustrator: String,
  text: String,
  orientation: String,
  #[serde(rename = "imageUrl")]
  image_url: String,
  f: Vec<f32>,
}

#[derive(Clone, Serialize)]
struct CardDatabaseProgress {
  phase: String,
  message: String,
  completed: usize,
  total: usize,
  percent: f32,
}

fn emit_card_database_progress(
  app: &tauri::AppHandle,
  phase: &str,
  message: String,
  completed: usize,
  total: usize,
  percent: f32,
) {
  let _ = app.emit(
    CARD_DATABASE_PROGRESS_EVENT,
    CardDatabaseProgress {
      phase: phase.to_string(),
      message,
      completed,
      total,
      percent,
    },
  );
}

fn value_to_string(value: Option<&Value>) -> String {
  match value {
    Some(Value::String(text)) => text.clone(),
    Some(Value::Number(number)) => number.to_string(),
    Some(Value::Bool(flag)) => flag.to_string(),
    Some(other) => other.to_string(),
    None => String::new(),
  }
}

#[derive(Serialize)]
struct ExchangeRateInfo {
  #[serde(rename = "exchangeRates")]
  exchange_rates: std::collections::HashMap<String, f32>,
  #[serde(rename = "exchangeRateDate")]
  exchange_rate_date: Option<String>,
  #[serde(rename = "exchangeRateSource")]
  exchange_rate_source: String,
  #[serde(rename = "exchangeRateFallback")]
  exchange_rate_fallback: bool,
}

#[tauri::command]
async fn fetch_exchange_rates() -> Result<ExchangeRateInfo, String> {
  tauri::async_runtime::spawn_blocking(fetch_exchange_rates_blocking)
    .await.map_err(|error| error.to_string())?
}

fn fetch_exchange_rates_blocking() -> Result<ExchangeRateInfo, String> {
  let client = Client::builder()
    .timeout(Duration::from_secs(30))
    .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
    .build()
    .map_err(|error| format!("Failed to initialize HTTP client: {}", error))?;

  let response = client
    .get("https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml")
    .send()
    .and_then(|response| response.error_for_status())
    .map_err(|error| format!("Failed to fetch ECB exchange rate: {}", error))?;

  let xml_text = response
    .text()
    .map_err(|error| format!("Failed to read ECB exchange rate response: {}", error))?;

  let date_regex = Regex::new(r#"<Cube\s+time=["'](\d{4}-\d{2}-\d{2})["']"#)
    .map_err(|error| format!("Failed to build ECB parser: {}", error))?;
  let date = date_regex
    .captures(&xml_text)
    .and_then(|captures| captures.get(1))
    .map(|capture| capture.as_str().to_string());

  let cube_pattern = Regex::new(r#"<Cube\s+([^>]*currency=["'][A-Z]{3}["'][^>]*)/?>"#)
    .map_err(|error| format!("Failed to build ECB parser: {}", error))?;
  let currency_regex = Regex::new(r#"currency=["']([A-Z]{3})["']"#)
    .map_err(|error| format!("Failed to build ECB parser: {}", error))?;
  let rate_regex = Regex::new(r#"rate=["']([^"']+)["']"#)
    .map_err(|error| format!("Failed to build ECB parser: {}", error))?;

  let mut exchange_rates = std::collections::HashMap::from([(String::from("EUR"), 1.0_f32)]);

  for captures in cube_pattern.captures_iter(&xml_text) {
    let Some(attributes) = captures.get(1).map(|capture| capture.as_str()) else {
      continue;
    };

    let currency = currency_regex
      .captures(attributes)
      .and_then(|captures| captures.get(1))
      .map(|capture| capture.as_str().to_string());

    let raw_rate = rate_regex
      .captures(attributes)
      .and_then(|captures| captures.get(1))
      .and_then(|capture| capture.as_str().parse::<f32>().ok());

    if let (Some(currency), Some(rate)) = (currency, raw_rate) {
      if rate > 0.0 {
        exchange_rates.insert(currency, rate);
      }
    }
  }

  if !exchange_rates.get("USD").is_some_and(|rate| *rate > 0.0) {
    return Err("ECB exchange rate response did not include a valid USD rate.".to_string());
  }

  Ok(ExchangeRateInfo {
    exchange_rates,
    exchange_rate_date: date,
    exchange_rate_source: String::from("https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml"),
    exchange_rate_fallback: false,
  })
}

#[tauri::command]
async fn update_card_database(
  app: tauri::AppHandle,
  existing_card_ids: Vec<String>,
) -> Result<String, String> {
  tauri::async_runtime::spawn_blocking(move || update_card_database_blocking(app, existing_card_ids))
    .await
    .map_err(|error| format!("Card database update worker failed: {}", error))?
}

fn update_card_database_blocking(
  app: tauri::AppHandle,
  existing_card_ids: Vec<String>,
) -> Result<String, String> {
  emit_card_database_progress(
    &app,
    "starting",
    "Preparing the card database update...".to_string(),
    0,
    0,
    0.02,
  );

  let client = Client::builder()
    .timeout(Duration::from_secs(30))
    .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
    .build()
    .map_err(|error| format!("Failed to initialize HTTP client: {}", error))?;

  let project_dirs = ProjectDirs::from("com", "Teme1999", "RiftboundScanner")
    .ok_or_else(|| "Failed to resolve the application data directory.".to_string())?;
  let cards_cache_dir = project_dirs.data_local_dir().join("cards");
  fs::create_dir_all(&cards_cache_dir)
    .map_err(|error| format!("Failed to create image cache directory {}: {}", cards_cache_dir.display(), error))?;

  emit_card_database_progress(
    &app,
    "gallery",
    "Downloading the Riot card gallery...".to_string(),
    0,
    0,
    0.04,
  );

  let html = client
    .get(GALLERY_URL)
    .send()
    .and_then(|response| response.error_for_status())
    .and_then(|response| response.text())
    .map_err(|error| format!("Failed to download Riot card gallery: {}", error))?;

  let next_data = extract_next_data(&html)?;
  let raw_cards = extract_cards(&next_data)?;

  if raw_cards.is_empty() {
    return Err("No cards were found in the Riot gallery data.".to_string());
  }

  let existing_ids = existing_card_ids.into_iter()
    .map(|id| id.trim().to_string())
    .filter(|id| !id.is_empty())
    .collect::<HashSet<_>>();
  let total_gallery_cards = raw_cards.len();
  let raw_cards = missing_gallery_cards(raw_cards, &existing_ids);
  let total_cards = raw_cards.len();
  emit_card_database_progress(
    &app,
    "cards",
    if total_cards == 0 {
      format!(
        "All {} gallery cards are already covered by the local database.",
        total_gallery_cards
      )
    } else {
      format!(
        "Found {} gallery cards. Downloading {} missing cards, including additions to existing sets...",
        total_gallery_cards,
        total_cards
      )
    },
    0,
    total_cards,
    if total_cards == 0 { 0.90 } else { 0.12 },
  );

  let mut cards = Vec::new();
  let mut skipped = 0usize;

  for (index, raw_card) in raw_cards.into_iter().enumerate() {
    match normalize_card(&raw_card, &client, &cards_cache_dir) {
      Ok(Some(card)) => cards.push(card),
      Ok(None) => skipped += 1,
      Err(_) => skipped += 1,
    }

    let completed = index + 1;
    let percent = 0.12 + (completed as f32 / total_cards as f32) * 0.78;
    emit_card_database_progress(
      &app,
      "cards",
      format!("Processed {}/{} cards ({} skipped)...", completed, total_cards, skipped),
      completed,
      total_cards,
      percent,
    );
  }

  cards.sort_by(|left, right| {
    left.set
      .cmp(&right.set)
      .then(left.number.cmp(&right.number))
      .then(left.id.cmp(&right.id))
  });

  let database = CardHashesDatabase {
    grid_size: GRID_SIZE,
    cards,
    skipped_cards: skipped,
  };

  emit_card_database_progress(
    &app,
    "serializing",
    format!("Generated {} cards. Preparing the refreshed database...", database.cards.len()),
    total_cards,
    total_cards,
    0.93,
  );

  let payload = serde_json::to_string(&database)
    .map_err(|error| format!("Failed to serialize matcher database: {}", error))?;

  println!("Card database updated: {} cards ({} skipped)", database.cards.len(), skipped);
  emit_card_database_progress(
    &app,
    "complete",
    "Card database generated. Importing it into the app...".to_string(),
    total_cards,
    total_cards,
    0.95,
  );
  Ok(payload)
}

fn extract_next_data(html: &str) -> Result<Value, String> {
  let regex = Regex::new(r#"(?s)<script id="__NEXT_DATA__"[^>]*>(.*?)</script>"#)
    .map_err(|error| format!("Failed to build gallery parser: {}", error))?;

  let captures = regex
    .captures(html)
    .ok_or_else(|| "__NEXT_DATA__ not found in the Riot card gallery HTML.".to_string())?;

  let json_text = captures
    .get(1)
    .map(|capture| capture.as_str())
    .ok_or_else(|| "Could not read the gallery JSON payload.".to_string())?;

  serde_json::from_str(json_text).map_err(|error| format!("Failed to parse Riot gallery JSON: {}", error))
}

fn missing_gallery_cards(raw_cards: Vec<Value>, existing_ids: &HashSet<String>) -> Vec<Value> {
  let mut seen_ids = HashSet::new();
  raw_cards.into_iter().filter(|raw| {
    let id = value_to_string(raw.get("id")).trim().to_string();
    !id.is_empty() && !existing_ids.contains(&id) && seen_ids.insert(id)
  }).collect()
}

fn extract_cards(next_data: &Value) -> Result<Vec<Value>, String> {
  if let Some(blades) = next_data
    .pointer("/props/pageProps/blades")
    .and_then(Value::as_array)
  {
    for blade in blades {
      if let Some(cards) = blade.get("cards") {
        if let Some(items) = cards.get("items").and_then(Value::as_array) {
          return Ok(items.clone());
        }

        if let Some(values) = cards.as_array() {
          if !values.is_empty() {
            return Ok(values.clone());
          }
        }
      }
    }
  }

  find_cards_recursive(next_data, 0)
    .ok_or_else(|| "Could not locate the card list in the Riot gallery JSON.".to_string())
}

fn find_cards_recursive(value: &Value, depth: usize) -> Option<Vec<Value>> {
  if depth > 10 {
    return None;
  }

  if let Some(values) = value.as_array() {
    if values.len() > 5 {
      if let Some(first) = values.first().and_then(Value::as_object) {
        if first.contains_key("cardImage") {
          return Some(values.clone());
        }
      }
    }

    for child in values {
      if let Some(found) = find_cards_recursive(child, depth + 1) {
        return Some(found);
      }
    }
  } else if let Some(object) = value.as_object() {
    for child in object.values() {
      if let Some(found) = find_cards_recursive(child, depth + 1) {
        return Some(found);
      }
    }
  }

  None
}

fn crop_artwork(image: &DynamicImage) -> RgbImage {
  let rgb = image.to_rgb8();
  let (width, height) = rgb.dimensions();

  let start_x = ((width as f32) * ART_LEFT).round().max(0.0) as u32;
  let start_y = ((height as f32) * ART_TOP).round().max(0.0) as u32;
  let crop_width = (((width as f32) * (ART_RIGHT - ART_LEFT)).round().max(1.0) as u32).min(width.saturating_sub(start_x).max(1));
  let crop_height = (((height as f32) * (ART_BOTTOM - ART_TOP)).round().max(1.0) as u32).min(height.saturating_sub(start_y).max(1));

  imageops::crop_imm(
    &rgb,
    start_x.min(width.saturating_sub(1)),
    start_y.min(height.saturating_sub(1)),
    crop_width,
    crop_height,
  )
  .to_image()
}

fn equalize_histogram(image: &mut RgbImage) {
  let total_pixels = image.width().saturating_mul(image.height());

  for channel in 0..3 {
    let mut hist = [0u32; 256];
    for pixel in image.pixels() {
      hist[pixel[channel] as usize] += 1;
    }

    let mut cdf = [0u32; 256];
    cdf[0] = hist[0];
    for index in 1..256 {
      cdf[index] = cdf[index - 1] + hist[index];
    }

    let cdf_min = cdf.iter().copied().find(|value| *value > 0).unwrap_or(0);
    let denom = total_pixels.saturating_sub(cdf_min);
    if denom == 0 {
      continue;
    }

    for pixel in image.pixels_mut() {
      let value = pixel[channel] as usize;
      let scaled = ((cdf[value] - cdf_min) as f32 * 255.0 / denom as f32 + 0.5).floor();
      pixel[channel] = scaled.clamp(0.0, 255.0) as u8;
    }
  }
}

fn compute_color_grid(image: &DynamicImage) -> Vec<f32> {
  let mut artwork = crop_artwork(image);
  equalize_histogram(&mut artwork);

  let resized = imageops::resize(
    &artwork,
    GRID_SIZE as u32,
    GRID_SIZE as u32,
    FilterType::Triangle,
  );

  let mut features = Vec::with_capacity(GRID_SIZE * GRID_SIZE * 3);
  for pixel in resized.pixels() {
    features.push(round_feature(pixel[0] as f32 / 255.0));
    features.push(round_feature(pixel[1] as f32 / 255.0));
    features.push(round_feature(pixel[2] as f32 / 255.0));
  }

  features
}

fn round_feature(value: f32) -> f32 {
  (value * 10_000.0).round() / 10_000.0
}

fn normalize_card(raw: &Value, client: &Client, cards_cache_dir: &Path) -> Result<Option<CardHashRecord>, String> {
  let card_image_url = raw
    .get("cardImage")
    .and_then(|value| value.get("url"))
    .and_then(Value::as_str)
    .unwrap_or("")
    .trim()
    .to_string();

  if card_image_url.is_empty() {
    return Ok(None);
  }

  let domains = raw
    .get("domain")
    .and_then(|value| value.get("values"))
    .and_then(Value::as_array)
    .map(|values| {
      values
        .iter()
        .map(|entry| {
          entry
            .get("id")
            .and_then(Value::as_str)
            .map(|value| value.to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| value_to_string(Some(entry)))
        })
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
    })
    .unwrap_or_default();

  let rarity = raw
    .get("rarity")
    .and_then(|value| value.get("value"))
    .and_then(|value| value.get("id"))
    .and_then(Value::as_str)
    .unwrap_or("")
    .to_string();

  let card_type = raw
    .get("cardType")
    .and_then(|value| value.get("type"))
    .and_then(Value::as_array)
    .and_then(|values| values.first())
    .and_then(|value| value.get("id"))
    .and_then(Value::as_str)
    .unwrap_or("")
    .to_string();

  let set_value = raw.get("set").and_then(Value::as_object);
  let set_id = set_value
    .and_then(|value| value.get("value"))
    .and_then(|value| value.get("id"))
    .and_then(Value::as_str)
    .unwrap_or("")
    .to_uppercase();
  let set_name = set_value
    .and_then(|value| value.get("value"))
    .and_then(|value| value.get("label"))
    .and_then(Value::as_str)
    .unwrap_or("")
    .to_string();

  let energy = raw
    .get("energy")
    .and_then(|value| value.get("value"))
    .and_then(|value| value.get("id"))
    .map(|value| value_to_string(Some(value)))
    .unwrap_or_default();
  let might = raw
    .get("might")
    .and_then(|value| value.get("value"))
    .and_then(|value| value.get("id"))
    .map(|value| value_to_string(Some(value)))
    .unwrap_or_default();

  let tags = raw
    .get("tags")
    .and_then(|value| value.get("tags"))
    .and_then(Value::as_array)
    .map(|values| {
      values
        .iter()
        .map(|entry| value_to_string(Some(entry)))
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
    })
    .unwrap_or_default();

  let illustrator = raw
    .get("illustrator")
    .and_then(|value| value.get("values"))
    .and_then(Value::as_array)
    .and_then(|values| values.first())
    .and_then(|value| value.get("label"))
    .and_then(Value::as_str)
    .unwrap_or("")
    .to_string();

  let text = raw
    .get("text")
    .and_then(|value| value.get("richText"))
    .and_then(|value| value.get("body"))
    .and_then(Value::as_str)
    .unwrap_or("")
    .to_string();

  let orientation = raw
    .get("orientation")
    .and_then(Value::as_str)
    .unwrap_or("portrait")
    .to_string();

  let raw_image = match client
    .get(normalize_image_url(&card_image_url))
    .send()
    .and_then(|response| response.error_for_status())
    .and_then(|response| response.bytes())
  {
    Ok(bytes) => bytes,
    Err(_) => return Ok(None),
  };

  let mut image = match image::load_from_memory(&raw_image) {
    Ok(image) => image,
    Err(_) => return Ok(None),
  };

  if image.width() > image.height() {
    let rotated = imageops::rotate90(&image.to_rgba8());
    image = DynamicImage::ImageRgba8(rotated);
  }

  let image_path = cards_cache_dir.join(format!("{}.webp", raw.get("id").map(|value| value_to_string(Some(value))).unwrap_or_default()));
  image
    .save_with_format(&image_path, image::ImageFormat::WebP)
    .map_err(|error| format!("Failed to save cached card image {}: {}", image_path.display(), error))?;

  let features = compute_color_grid(&image);

  Ok(Some(CardHashRecord {
    id: raw.get("id").map(|value| value_to_string(Some(value))).unwrap_or_default(),
    name: raw.get("name").map(|value| value_to_string(Some(value))).unwrap_or_default(),
    number: raw
      .get("collectorNumber")
      .map(|value| value_to_string(Some(value)))
      .unwrap_or_default(),
    code: raw
      .get("publicCode")
      .map(|value| value_to_string(Some(value)))
      .unwrap_or_default(),
    set: set_id,
    set_name,
    domain: domains.first().cloned(),
    domains,
    rarity,
    card_type,
    energy,
    might,
    tags,
    illustrator,
    text,
    orientation,
    image_url: image_path.to_string_lossy().to_string(),
    f: features,
  }))
}

fn normalize_image_url(url: &str) -> String {
  if url.starts_with("//") {
    format!("https:{}", url)
  } else {
    url.to_string()
  }
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
  let app = tauri::Builder::default()
    .plugin(tauri_plugin_process::init())
    .plugin(tauri_plugin_updater::Builder::new().build());
  #[cfg(debug_assertions)]
  let app = app.manage(debug_recording::RecordingState::default())
    .invoke_handler(tauri::generate_handler![runtime_info, update_card_database, fetch_exchange_rates, open_external_url, open_storage_folder,
      diagnostic_exports::save_native_frame, diagnostic_exports::save_debug_scan,
      debug_recording::start_debug_recording, debug_recording::append_debug_recording, debug_recording::record_debug_events, debug_recording::finish_debug_recording]);
  #[cfg(not(debug_assertions))]
  let app = app.invoke_handler(tauri::generate_handler![runtime_info, update_card_database, fetch_exchange_rates, open_external_url, open_storage_folder]);
  app.run(tauri::generate_context!())
    .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  fn gallery_card(id: &str) -> Value {
    json!({"id": id, "set": {"value": {"id": "RAD"}}})
  }

  #[test]
  fn downloads_later_reveals_from_an_existing_set() {
    let known = HashSet::from([String::from("rad-001")]);
    let missing = missing_gallery_cards(vec![gallery_card("rad-001"), gallery_card("rad-002")], &known);
    assert_eq!(missing.len(), 1);
    assert_eq!(missing[0]["id"], "rad-002");
  }

  #[test]
  fn retries_cards_that_failed_in_an_earlier_update() {
    let gallery = vec![gallery_card("rad-001"), gallery_card("rad-002"), gallery_card("rad-003")];
    let known = HashSet::from([String::from("rad-001"), String::from("rad-003")]);
    let retry = missing_gallery_cards(gallery.clone(), &known);
    assert_eq!(retry, vec![gallery_card("rad-002")]);
    let complete = HashSet::from([String::from("rad-001"), String::from("rad-002"), String::from("rad-003")]);
    assert!(missing_gallery_cards(gallery, &complete).is_empty());
  }

  #[test]
  fn ignores_empty_ids_and_duplicate_gallery_rows() {
    let missing = missing_gallery_cards(vec![json!({}), gallery_card(""), gallery_card("rad-001"), gallery_card("rad-001")], &HashSet::new());
    assert_eq!(missing, vec![gallery_card("rad-001")]);
  }

}
