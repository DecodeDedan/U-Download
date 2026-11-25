//! The one place that knows how a short, capture-the-output yt-dlp call is
//! made on this platform: a bundled binary on desktop, the youtubedl-android
//! engine on Android. Downloads, which stream progress, live in `runner`.

use tauri::{AppHandle, Manager, Runtime};

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
        // The app updates yt-dlp itself; yt-dlp's own "older than 90 days"
        // nag would otherwise lead every error message.
        full.push("--no-update".to_string());
        let browser = app
            .try_state::<crate::commands::SharedEngineSettings>()
            .and_then(|s| s.cookies_browser.lock().ok().and_then(|b| b.clone()));
        if let Some(browser) = browser {
            full.push("--cookies-from-browser".to_string());
            full.push(browser);
        }
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
            return Err(concise_error(&String::from_utf8_lossy(&output.stderr)));
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }
}

/// The part of yt-dlp's stderr a person should read: its `ERROR:` lines, or
/// failing that the last line that is not a warning.
#[cfg_attr(target_os = "android", allow(dead_code))] // Desktop captures only.
pub fn concise_error(stderr: &str) -> String {
    let errors: Vec<&str> = stderr
        .lines()
        .map(str::trim)
        .filter(|l| l.starts_with("ERROR:"))
        .map(|l| l.trim_start_matches("ERROR:").trim())
        .collect();
    if !errors.is_empty() {
        return errors.join(" ");
    }
    stderr
        .lines()
        .map(str::trim)
        .rev()
        .find(|l| !l.is_empty() && !l.starts_with("WARNING:"))
        .unwrap_or_else(|| stderr.trim())
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::concise_error;

    #[test]
    fn keeps_only_the_error_lines() {
        let stderr = "WARNING: Your yt-dlp version is older than 90 days!\n\
                      ERROR: [vimeo] 56015672: Unable to download webpage: HTTP Error 404\n";
        assert_eq!(concise_error(stderr), "[vimeo] 56015672: Unable to download webpage: HTTP Error 404");
    }

    #[test]
    fn falls_back_to_the_last_plain_line() {
        assert_eq!(concise_error("WARNING: a\nsomething broke\n"), "something broke");
        assert_eq!(concise_error("WARNING: only a warning"), "WARNING: only a warning");
    }
}
