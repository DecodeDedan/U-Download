//! The v4 commands: link classification, link inspection (playlists and the
//! format list), media search, engine tuning and queue housekeeping.

use crate::engine;
use crate::jobs::SharedJobs;
use crate::router::{self, LinkKind};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Runtime, State};

/// How hard the engines push. Read by every new job.
pub struct EngineSettings {
    pub connections: AtomicU32,
    /// Bytes per second across all downloads; 0 is unlimited.
    pub rate_limit: AtomicU64,
    #[cfg(not(target_os = "android"))]
    pub limiter: Arc<crate::accel::Limiter>,
    /// Desktop: the browser whose login yt-dlp borrows for previews and
    /// link lookups (downloads carry it in their own options).
    pub cookies_browser: std::sync::Mutex<Option<String>>,
}

pub type SharedEngineSettings = Arc<EngineSettings>;

pub fn new_engine_settings() -> SharedEngineSettings {
    Arc::new(EngineSettings {
        connections: AtomicU32::new(DEFAULT_CONNECTIONS),
        rate_limit: AtomicU64::new(0),
        #[cfg(not(target_os = "android"))]
        limiter: Arc::new(crate::accel::Limiter::new(0)),
        cookies_browser: std::sync::Mutex::new(None),
    })
}

pub const DEFAULT_CONNECTIONS: u32 = 16;
pub const MAX_CONNECTIONS: u32 = 64;
/// Most search results asked of yt-dlp at once.
const SEARCH_RESULTS: u32 = 15;
const MAX_QUERY_CHARS: usize = 200;
/// Playlist entries returned to the interface; the rest are counted.
const MAX_ENTRIES: usize = 500;

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct EngineSettingsView {
    pub connections: u32,
    pub speed_limit_kbps: u64,
}

#[tauri::command]
pub fn get_engine_settings(settings: State<'_, SharedEngineSettings>) -> EngineSettingsView {
    EngineSettingsView {
        connections: settings.connections.load(Ordering::Relaxed),
        speed_limit_kbps: settings.rate_limit.load(Ordering::Relaxed) / 1024,
    }
}

#[tauri::command]
pub fn set_engine_settings(
    settings: State<'_, SharedEngineSettings>,
    connections: u32,
    speed_limit_kbps: u64,
    cookies_browser: Option<String>,
) -> Result<EngineSettingsView, String> {
    if !(1..=MAX_CONNECTIONS).contains(&connections) {
        return Err(format!("Connections must be between 1 and {MAX_CONNECTIONS}"));
    }
    // The same whitelist downloads are held to.
    let browser = crate::ytdlp::MediaOptions { cookies_browser, ..Default::default() }
        .validated()?
        .cookies_browser;
    if let Ok(mut slot) = settings.cookies_browser.lock() {
        *slot = browser;
    }
    // 10 GB/s is no limit at all; anything above is a typo.
    let rate = speed_limit_kbps.min(10 * 1024 * 1024) * 1024;
    settings.connections.store(connections, Ordering::Relaxed);
    settings.rate_limit.store(rate, Ordering::Relaxed);
    #[cfg(not(target_os = "android"))]
    settings.limiter.set_rate(rate);
    Ok(get_engine_settings(settings))
}

#[tauri::command]
pub fn classify_link(text: String) -> LinkKind {
    router::classify(&text)
}

#[tauri::command]
pub fn clear_finished<R: Runtime>(
    window: tauri::Window<R>,
    registry: State<'_, SharedJobs>,
) -> Vec<String> {
    use tauri::Emitter;
    let gone = { registry.lock().unwrap().clear_finished() };
    let _ = window.emit("jobs-cleared", &gone);
    gone
}

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct FormatInfo {
    pub format_id: String,
    pub ext: String,
    pub width: Option<u64>,
    pub height: Option<u64>,
    pub fps: Option<f64>,
    pub vcodec: String,
    pub acodec: String,
    pub filesize: Option<u64>,
    pub note: String,
    pub watermarked: bool,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct EntryInfo {
    pub title: String,
    pub url: String,
    pub duration: Option<f64>,
    pub uploader: String,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct LinkInfo {
    pub kind: LinkKind,
    pub title: String,
    pub thumbnail: String,
    pub uploader: String,
    pub site: String,
    pub duration: Option<f64>,
    pub is_playlist: bool,
    pub entry_count: usize,
    pub entries: Vec<EntryInfo>,
    pub formats: Vec<FormatInfo>,
}

fn text(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn best_thumbnail(v: &Value) -> String {
    let direct = text(v, "thumbnail");
    if !direct.is_empty() {
        return direct;
    }
    v.get("thumbnails")
        .and_then(Value::as_array)
        .and_then(|t| t.iter().rev().find_map(|t| t.get("url").and_then(Value::as_str)))
        .unwrap_or_default()
        .to_string()
}

/// Turns yt-dlp's `-J --flat-playlist` output into what the interface shows.
pub fn link_info_from_json(v: &Value) -> LinkInfo {
    let is_playlist = v.get("_type").and_then(Value::as_str) == Some("playlist");
    let raw_entries = v.get("entries").and_then(Value::as_array).cloned().unwrap_or_default();
    let entries = raw_entries
        .iter()
        .take(MAX_ENTRIES)
        .map(|e| EntryInfo {
            title: text(e, "title"),
            url: [text(e, "url"), text(e, "webpage_url")]
                .into_iter()
                .find(|u| u.starts_with("http"))
                .unwrap_or_default(),
            duration: e.get("duration").and_then(Value::as_f64),
            uploader: text(e, "uploader"),
        })
        .collect();
    let formats = v
        .get("formats")
        .and_then(Value::as_array)
        .map(|fs| {
            fs.iter()
                .filter(|f| {
                    let proto = text(f, "protocol");
                    !proto.starts_with("mhtml") && !text(f, "format_id").is_empty()
                })
                .map(|f| {
                    let note = text(f, "format_note");
                    FormatInfo {
                        format_id: text(f, "format_id"),
                        ext: text(f, "ext"),
                        width: f.get("width").and_then(Value::as_u64),
                        height: f.get("height").and_then(Value::as_u64),
                        fps: f.get("fps").and_then(Value::as_f64),
                        vcodec: text(f, "vcodec"),
                        acodec: text(f, "acodec"),
                        filesize: f
                            .get("filesize")
                            .and_then(Value::as_u64)
                            .or_else(|| f.get("filesize_approx").and_then(Value::as_u64)),
                        watermarked: note.to_ascii_lowercase().contains("watermark"),
                        note,
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    let uploader = [text(v, "uploader"), text(v, "channel"), text(v, "creator")]
        .into_iter()
        .find(|s| !s.is_empty())
        .unwrap_or_default();
    LinkInfo {
        kind: LinkKind::Media,
        title: text(v, "title"),
        thumbnail: best_thumbnail(v),
        uploader,
        site: text(v, "extractor_key"),
        duration: v.get("duration").and_then(Value::as_f64),
        is_playlist,
        entry_count: v
            .get("playlist_count")
            .and_then(Value::as_u64)
            .map(|n| n as usize)
            .unwrap_or(raw_entries.len()),
        entries,
        formats,
    }
}

async fn ytdlp_json<R: Runtime>(app: &AppHandle<R>, args: Vec<String>) -> Result<Value, String> {
    let app = app.clone();
    let out = tokio::task::spawn_blocking(move || engine::capture(&app, &args, false))
        .await
        .map_err(|e| format!("Link lookup failed to run: {e}"))??;
    serde_json::from_str(out.trim()).map_err(|e| format!("Could not read the site's answer: {e}"))
}

/// What a link holds: a video and its formats, or a playlist and its items.
/// Direct files and torrents are reported by kind only; there is nothing to
/// look up before downloading them.
#[tauri::command]
pub async fn inspect_link<R: Runtime>(app: AppHandle<R>, url: String) -> Result<LinkInfo, String> {
    let url = url.trim().to_string();
    let kind = router::classify(&url);
    if kind != LinkKind::Media {
        return Ok(LinkInfo {
            kind,
            title: String::new(),
            thumbnail: String::new(),
            uploader: String::new(),
            site: String::new(),
            duration: None,
            is_playlist: false,
            entry_count: 0,
            entries: Vec::new(),
            formats: Vec::new(),
        });
    }
    let args = vec![
        "-J".into(),
        "--flat-playlist".into(),
        "--no-warnings".into(),
        "--socket-timeout".into(),
        "15".into(),
        "--".into(),
        url,
    ];
    let json = ytdlp_json(&app, args).await?;
    Ok(link_info_from_json(&json))
}

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct SearchHit {
    pub title: String,
    pub url: String,
    pub uploader: String,
    pub duration: Option<f64>,
    pub thumbnail: String,
    pub views: Option<u64>,
}

pub fn search_hits_from_json(v: &Value) -> Vec<SearchHit> {
    v.get("entries")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|e| {
                    let url = [text(e, "url"), text(e, "webpage_url")]
                        .into_iter()
                        .find(|u| u.starts_with("http"))?;
                    Some(SearchHit {
                        title: text(e, "title"),
                        url,
                        uploader: [text(e, "uploader"), text(e, "channel")]
                            .into_iter()
                            .find(|s| !s.is_empty())
                            .unwrap_or_default(),
                        duration: e.get("duration").and_then(Value::as_f64),
                        thumbnail: best_thumbnail(e),
                        views: e.get("view_count").and_then(Value::as_u64),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Stacher-style search: words in, a list of videos out.
#[tauri::command]
pub async fn search_media<R: Runtime>(
    app: AppHandle<R>,
    query: String,
    source: Option<String>,
) -> Result<Vec<SearchHit>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    if query.chars().count() > MAX_QUERY_CHARS {
        return Err(format!("Searches are limited to {MAX_QUERY_CHARS} characters"));
    }
    let prefix = match source.as_deref().unwrap_or("youtube") {
        "youtube" => "ytsearch",
        "soundcloud" => "scsearch",
        other => return Err(format!("Unknown search source: {other}")),
    };
    // The query rides inside one `ytsearchN:` argument, so it can never be
    // read as an option.
    let args = vec![
        "-J".into(),
        "--flat-playlist".into(),
        "--no-warnings".into(),
        "--socket-timeout".into(),
        "15".into(),
        format!("{prefix}{SEARCH_RESULTS}:{query}"),
    ];
    let json = ytdlp_json(&app, args).await?;
    Ok(search_hits_from_json(&json))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_a_video_and_flags_watermarked_formats() {
        let info = link_info_from_json(&json!({
            "title": "Clip", "uploader": "someone", "extractor_key": "TikTok", "duration": 12.5,
            "thumbnails": [{"url": "https://t/1.jpg"}, {"url": "https://t/2.jpg"}],
            "formats": [
                {"format_id": "download", "ext": "mp4", "height": 1280, "format_note": "Download video, watermarked", "protocol": "https"},
                {"format_id": "play", "ext": "mp4", "height": 1024, "filesize_approx": 900, "protocol": "https"},
                {"format_id": "sb0", "ext": "mhtml", "protocol": "mhtml"}
            ]
        }));
        assert_eq!(info.title, "Clip");
        assert_eq!(info.thumbnail, "https://t/2.jpg");
        assert!(!info.is_playlist);
        assert_eq!(info.formats.len(), 2);
        assert!(info.formats[0].watermarked);
        assert!(!info.formats[1].watermarked);
        assert_eq!(info.formats[1].filesize, Some(900));
    }

    #[test]
    fn reads_a_playlist_and_its_items() {
        let info = link_info_from_json(&json!({
            "_type": "playlist", "title": "Mix", "playlist_count": 2,
            "entries": [
                {"title": "One", "url": "https://www.youtube.com/watch?v=1", "duration": 60},
                {"title": "Two", "id": "2", "webpage_url": "https://www.youtube.com/watch?v=2"}
            ]
        }));
        assert!(info.is_playlist);
        assert_eq!(info.entry_count, 2);
        assert_eq!(info.entries[1].url, "https://www.youtube.com/watch?v=2");
        assert_eq!(info.entries[0].duration, Some(60.0));
    }

    #[test]
    fn search_results_without_a_link_are_dropped() {
        let hits = search_hits_from_json(&json!({"entries": [
            {"title": "A", "url": "https://www.youtube.com/watch?v=a", "channel": "C", "view_count": 5},
            {"title": "B", "id": "b"}
        ]}));
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].uploader, "C");
        assert_eq!(hits[0].views, Some(5));
    }
}
