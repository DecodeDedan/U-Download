//! The one place that knows how a short, capture-the-output yt-dlp call is
//! made on this platform: a bundled binary on desktop, the youtubedl-android
//! engine on Android. Downloads, which stream progress, live in `runner`.

#[cfg(target_os = "android")]
use tauri::Manager;
use tauri::{AppHandle, Runtime};

#[cfg(target_os = "android")]
pub type Engine<R> = tauri_plugin_udl_engine::Engine<R>;

/// Runs `f` against the Android engine on a blocking thread.
///
/// Every engine call waits on Android's main thread; doing that from an async
/// command would park a runtime worker for as long as the engine takes.
#[cfg(target_os = "android")]
pub async fn on_engine<R, T, F>(app: &AppHandle<R>, f: F) -> Result<T, String>
where
    R: Runtime,
    T: Send + 'static,
    F: FnOnce(&Engine<R>) -> T + Send + 'static,
{
    let app = app.clone();
    tokio::task::spawn_blocking(move || f(&app.state::<Engine<R>>()))
        .await
        .map_err(|e| format!("Download engine task failed: {e}"))
}

/// Runs yt-dlp to completion and returns its stdout. Blocking: call it from
/// `spawn_blocking`.
///
/// `needs_ffmpeg` names the bundled ffmpeg on desktop, for calls that merge
/// streams; the Android engine always passes its own.
pub fn capture<R: Runtime>(
    app: &AppHandle<R>,
    args: &[String],
    needs_ffmpeg: bool,
) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        use tauri_plugin_udl_engine::Outcome;
        let _ = needs_ffmpeg;
        // Not a job: the id only routes this call's output lines, and nothing
        // here reads them.
        let id = format!("capture-{}", uuid::Uuid::new_v4());
        match app.state::<Engine<R>>().execute(&id, args, false, |_| {}) {
            Outcome::Completed { stdout } => Ok(stdout),
            Outcome::Failed { message } => Err(message),
            Outcome::Cancelled => Err("yt-dlp was stopped".to_string()),
        }
    }
    #[cfg(not(target_os = "android"))]
    {
        use crate::binary_manager;
        let paths = binary_manager::resolve_paths(app)?;
        binary_manager::ensure_executable(&paths)?;

        let mut full: Vec<String> = Vec::new();
        binary_manager::push_js_runtime_args(
            &mut full,
            binary_manager::resolve_js_runtime(&paths).as_ref(),
        );
        if needs_ffmpeg {
            full.push("--ffmpeg-location".to_string());
            full.push(paths.ffmpeg.to_string_lossy().into_owned());
        }
        full.extend_from_slice(args);

        let mut cmd = std::process::Command::new(&paths.yt_dlp);
        // Puts the bundled tools on PATH and, crucially, SSL_CERT_FILE in the
        // environment: the bundled ffmpeg cannot verify a single HTTPS
        // certificate without it.
        binary_manager::augment_path_env(&mut cmd, &paths.dir);
        let output = cmd
            .args(&full)
            .output()
            .map_err(|e| format!("Failed to start yt-dlp: {e}"))?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }
}
