//! `--self-test <file.json>`: the app drives its own interface the way a
//! person would (switches views, pastes a link, presses Download), downloads
//! a real file from a local server through the whole pipeline, checks every
//! byte, writes the results and exits.
//!
//! The driver half lives in the webview (`web/src/lib/selftest.js`); it asks
//! `selftest_config` whether a test is running and reports to
//! `selftest_finish`.

use crate::loopback::{self, Loopback, ServeOptions};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Runtime, State};

/// Big enough that the download is visibly in flight for a second or two.
const FILE_SIZE: u64 = 24 * 1024 * 1024;
/// Each connection capped like a CDN would, so many connections matter.
const PER_CONNECTION_BPS: u64 = 1024 * 1024;
const FILE_NAME: &str = "udl-selftest.bin";
/// The whole test gives up after this long and reports what it saw.
const WATCHDOG: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, PartialEq)]
pub enum Mode {
    Normal,
    Screenshot(PathBuf),
    SelfTest(PathBuf),
}

pub fn mode_from_args(args: &[String]) -> Mode {
    let value_after = |flag: &str| {
        args.iter()
            .position(|a| a == flag)
            .and_then(|i| args.get(i + 1))
            .map(PathBuf::from)
    };
    if let Some(path) = value_after("--screenshot") {
        return Mode::Screenshot(path);
    }
    if let Some(path) = value_after("--self-test") {
        return Mode::SelfTest(path);
    }
    Mode::Normal
}

#[cfg_attr(not(desktop), allow(dead_code))] // Desktop windows only.
/// `--window-size 390x844`: opens the window at that size, to check the
/// phone layout on a desktop.
pub fn window_size_from_args(args: &[String]) -> Option<(f64, f64)> {
    let value = args.iter().position(|a| a == "--window-size").and_then(|i| args.get(i + 1))?;
    let (w, h) = value.split_once('x')?;
    let (w, h): (f64, f64) = (w.parse().ok()?, h.parse().ok()?);
    ((320.0..=3840.0).contains(&w) && (480.0..=2400.0).contains(&h)).then_some((w, h))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Step {
    pub step: String,
    pub passed: bool,
    pub detail: String,
}

#[derive(Serialize)]
struct Report<'a> {
    version: u32,
    steps: &'a [Step],
}

pub struct SelfTest {
    out: PathBuf,
    folder: PathBuf,
    /// Kept alive for the length of the test.
    server: Loopback,
    finished: AtomicBool,
}

pub type SharedSelfTest = Arc<Mutex<Option<Arc<SelfTest>>>>;

#[derive(Serialize)]
pub struct Config {
    pub url: String,
    pub folder: String,
    pub file_name: String,
    /// Set by `UDL_SELFTEST_SHOT=<file.png>`: a picture of the window taken
    /// mid-download, for looking at the live state.
    pub snapshot: Option<String>,
}

pub fn start<R: Runtime>(app: &AppHandle<R>, out: PathBuf) -> Result<Arc<SelfTest>, String> {
    let folder = std::env::temp_dir().join(format!("udl-selftest-{}", std::process::id()));
    if folder.exists() {
        std::fs::remove_dir_all(&folder).map_err(|e| format!("Could not clear {}: {e}", folder.display()))?;
    }
    std::fs::create_dir_all(&folder).map_err(|e| format!("Could not create {}: {e}", folder.display()))?;
    let server = loopback::serve(ServeOptions {
        size: FILE_SIZE,
        per_connection_bps: PER_CONNECTION_BPS,
        file_name: FILE_NAME.to_string(),
        ..Default::default()
    })
    .map_err(|e| format!("Could not start the test server: {e}"))?;
    let test = Arc::new(SelfTest { out, folder, server, finished: AtomicBool::new(false) });

    let (app, watched) = (app.clone(), test.clone());
    std::thread::spawn(move || {
        std::thread::sleep(WATCHDOG);
        let steps = ["move", "act", "hud"].map(|s| Step {
            step: s.to_string(),
            passed: false,
            detail: format!("the interface did not finish the test within {}s", WATCHDOG.as_secs()),
        });
        finish(&app, &watched, steps.to_vec());
    });
    Ok(test)
}

/// Every byte of the downloaded file against what the server sent.
fn verify_file(folder: &Path) -> Result<u64, String> {
    let path = folder.join(FILE_NAME);
    let bytes = std::fs::read(&path).map_err(|e| format!("{} is missing: {e}", path.display()))?;
    if bytes.len() as u64 != FILE_SIZE {
        return Err(format!("file is {} bytes, expected {FILE_SIZE}", bytes.len()));
    }
    match (0..FILE_SIZE).find(|&i| bytes[i as usize] != loopback::byte_at(i)) {
        Some(i) => Err(format!("byte {i} differs from what the server sent")),
        None => Ok(FILE_SIZE),
    }
}

fn finish<R: Runtime>(app: &AppHandle<R>, test: &SelfTest, mut steps: Vec<Step>) {
    if test.finished.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Some(act) = steps.iter_mut().find(|s| s.step == "act") {
        match verify_file(&test.folder) {
            Ok(n) => act.detail = format!("{}; every one of {n} bytes on disk matches", act.detail),
            Err(e) => {
                act.passed = false;
                act.detail = format!("{}; {e}", act.detail);
            }
        }
        let peak = test.server.peak_connections.load(Ordering::Relaxed);
        let requests = test.server.requests.load(Ordering::Relaxed);
        act.detail = format!(
            "{} (server saw {requests} requests, up to {peak} connections at once)",
            act.detail
        );
    }
    let all_passed = steps.iter().all(|s| s.passed);
    let written = serde_json::to_vec_pretty(&Report { version: 1, steps: &steps })
        .map_err(|e| e.to_string())
        .and_then(|json| std::fs::write(&test.out, json).map_err(|e| e.to_string()));
    if let Err(e) = written {
        eprintln!("self-test: could not write {}: {e}", test.out.display());
    }
    if let Err(e) = std::fs::remove_dir_all(&test.folder) {
        eprintln!("self-test: could not clear {}: {e}", test.folder.display());
    }
    eprintln!("self-test: {}", if all_passed { "passed" } else { "FAILED" });
    app.exit(if all_passed { 0 } else { 1 });
}

#[tauri::command]
pub fn selftest_config(state: State<'_, SharedSelfTest>) -> Option<Config> {
    let test = state.lock().ok()?.clone()?;
    Some(Config {
        url: test.server.url.clone(),
        folder: test.folder.to_string_lossy().into_owned(),
        file_name: FILE_NAME.to_string(),
        snapshot: std::env::var("UDL_SELFTEST_SHOT").ok().filter(|p| !p.is_empty()),
    })
}

#[tauri::command]
pub fn selftest_snapshot<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    use tauri::Manager;
    let out = std::env::var("UDL_SELFTEST_SHOT").map_err(|_| "UDL_SELFTEST_SHOT is not set".to_string())?;
    let window = app.get_webview_window("main").ok_or("no main window")?;
    crate::snapshot::capture(&window, PathBuf::from(out), |result| {
        if let Err(e) = result {
            eprintln!("self-test: mid-download picture failed: {e}");
        }
    })
}

#[tauri::command]
pub fn selftest_finish<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, SharedSelfTest>,
    steps: Vec<Step>,
) -> Result<(), String> {
    let test = state
        .lock()
        .map_err(|_| "self-test state is unavailable".to_string())?
        .clone()
        .ok_or("no self-test is running")?;
    finish(&app, &test, steps);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn reads_the_two_check_options() {
        assert_eq!(mode_from_args(&args(&["app"])), Mode::Normal);
        assert_eq!(
            mode_from_args(&args(&["app", "--screenshot", "/tmp/a.png"])),
            Mode::Screenshot(PathBuf::from("/tmp/a.png"))
        );
        assert_eq!(
            mode_from_args(&args(&["app", "--self-test", "r.json"])),
            Mode::SelfTest(PathBuf::from("r.json"))
        );
        // A flag with no file after it is ignored, not a crash.
        assert_eq!(mode_from_args(&args(&["app", "--screenshot"])), Mode::Normal);
        assert_eq!(window_size_from_args(&args(&["app", "--window-size", "390x844"])), Some((390.0, 844.0)));
        assert_eq!(window_size_from_args(&args(&["app", "--window-size", "10x10"])), None);
    }
}
