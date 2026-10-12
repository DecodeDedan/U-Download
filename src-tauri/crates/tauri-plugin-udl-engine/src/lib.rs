//! Android download engine for U-Download.
//!
//! yt-dlp is a Python program and cannot be spawned on Android the way the
//! desktop runner spawns it. youtubedl-android (the engine Seal is built on)
//! ships Python, yt-dlp, ffmpeg, aria2c and QuickJS as native libraries; the
//! Kotlin half of this plugin wraps it, and this half exposes it to the app
//! crate as a blocking `execute` that streams yt-dlp's output line by line —
//! the same records the desktop runner reads from a child's pipes — so the
//! queue, the progress parser and the trim logic stay shared.
//!
//! Lines travel over one long-lived channel, routed by job id. A channel per
//! job would leak: Tauri's mobile channel registry never removes an entry.

use serde::Deserialize;
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(target_os = "android")]
mod android;
#[cfg(target_os = "android")]
pub use android::Engine;

/// What the Kotlin side reports once its one-time unpacking has finished.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    /// CA bundle aria2c must be pointed at; Android has no system PEM file.
    pub ca_bundle: String,
    /// `Download/U-Download` on shared storage.
    pub default_output_dir: String,
    /// App-private scratch space for in-progress downloads.
    pub temp_dir: String,
    pub ytdlp_version: String,
}

/// How one yt-dlp invocation ended.
#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    Completed { stdout: String },
    Failed { message: String },
    Cancelled,
}

/// One message on the channel the Kotlin plugin writes to.
#[derive(Debug, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum Message {
    Line {
        #[serde(rename = "jobId")]
        job_id: String,
        line: String,
    },
    Share {
        text: String,
    },
}

/// The Kotlin `execute` command's resolved value.
#[derive(Debug, Deserialize, PartialEq)]
#[serde(tag = "status", rename_all = "lowercase")]
enum ExecuteResponse {
    Completed {
        #[serde(default)]
        stdout: String,
    },
    Failed {
        #[serde(default)]
        message: String,
    },
    Cancelled,
}

/// How many trailing output lines are kept to explain a failure.
const TAIL_LINES: usize = 20;

/// The last few output lines of a run, kept to explain a failure.
///
/// Downloads run with stderr merged into stdout (ffmpeg reports a trimmed
/// job's progress on stderr), so youtubedl-android's exception carries an
/// empty message for them; the reason is only in these lines.
#[derive(Debug, Default)]
struct Tail(std::collections::VecDeque<String>);

impl Tail {
    fn push(&mut self, line: &str) {
        if self.0.len() == TAIL_LINES {
            self.0.pop_front();
        }
        self.0.push_back(line.to_string());
    }

    /// yt-dlp's own `ERROR:` line when there is one, else the last line.
    fn reason(&self) -> Option<String> {
        self.0
            .iter()
            .rev()
            .find(|l| l.starts_with("ERROR:"))
            .or_else(|| self.0.iter().rev().find(|l| !l.trim().is_empty()))
            .map(|l| l.trim().to_string())
    }
}

fn to_outcome(response: Result<ExecuteResponse, String>, tail: &Tail) -> Outcome {
    match response {
        Ok(ExecuteResponse::Completed { stdout }) => Outcome::Completed { stdout },
        Ok(ExecuteResponse::Cancelled) => Outcome::Cancelled,
        Ok(ExecuteResponse::Failed { message }) => {
            let message = if message.trim().is_empty() {
                tail.reason()
                    .unwrap_or_else(|| "yt-dlp failed without output".into())
            } else {
                message.trim().to_string()
            };
            Outcome::Failed { message }
        }
        Err(e) => Outcome::Failed {
            message: format!("Download engine unavailable: {e}"),
        },
    }
}

/// Pulls the link out of what a share sheet hands over.
///
/// The YouTube app shares a bare `https://youtu.be/…` link, but other apps
/// prepend a title or append prose, so the first http(s) token is taken and
/// trailing punctuation that cannot end a URL is dropped.
pub fn extract_url(shared: &str) -> Option<String> {
    shared
        .split_whitespace()
        .find(|t| t.starts_with("https://") || t.starts_with("http://"))
        .map(|t| t.trim_end_matches(|c| matches!(c, '.' | ',' | ')' | '"' | '\'' | '!' | '?')))
        .filter(|t| t.len() > "https://".len())
        .map(str::to_string)
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("udl-engine")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                let handle = _api.register_android_plugin("com.udownload.engine", "EnginePlugin")?;
                _app.manage(Engine::new(_app.clone(), handle));
            }
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_a_bare_youtube_share() {
        assert_eq!(
            extract_url("https://youtu.be/dQw4w9WgXcQ?si=abc").as_deref(),
            Some("https://youtu.be/dQw4w9WgXcQ?si=abc")
        );
    }

    #[test]
    fn extracts_the_link_from_surrounding_prose() {
        assert_eq!(
            extract_url("Watch \"Song\" on YouTube: https://youtu.be/abc123.").as_deref(),
            Some("https://youtu.be/abc123")
        );
    }

    #[test]
    fn rejects_text_without_a_link() {
        assert_eq!(extract_url("just some words"), None);
        assert_eq!(extract_url(""), None);
        assert_eq!(extract_url("https://"), None);
        assert_eq!(extract_url("ftp://example.com/file"), None);
    }

    #[test]
    fn parses_line_and_share_messages() {
        let line: Message =
            serde_json::from_str(r#"{"kind":"line","jobId":"j1","line":"[download]  5.0%"}"#).unwrap();
        assert_eq!(
            line,
            Message::Line { job_id: "j1".into(), line: "[download]  5.0%".into() }
        );
        let share: Message = serde_json::from_str(r#"{"kind":"share","text":"x"}"#).unwrap();
        assert_eq!(share, Message::Share { text: "x".into() });
    }

    #[test]
    fn a_failure_without_a_message_reports_ytdlps_error_line() {
        let mut tail = Tail::default();
        tail.push("[youtube] abc: Downloading webpage");
        tail.push("ERROR: [youtube] abc: Video unavailable");
        tail.push("");
        let outcome = to_outcome(Ok(ExecuteResponse::Failed { message: String::new() }), &tail);
        assert_eq!(
            outcome,
            Outcome::Failed { message: "ERROR: [youtube] abc: Video unavailable".into() }
        );
    }

    #[test]
    fn a_failure_with_no_output_still_says_something() {
        let outcome =
            to_outcome(Ok(ExecuteResponse::Failed { message: " ".into() }), &Tail::default());
        assert_eq!(outcome, Outcome::Failed { message: "yt-dlp failed without output".into() });
    }

    #[test]
    fn the_tail_is_bounded() {
        let mut tail = Tail::default();
        for i in 0..100 {
            tail.push(&format!("line {i}"));
        }
        assert_eq!(tail.0.len(), TAIL_LINES);
        assert_eq!(tail.reason().as_deref(), Some("line 99"));
    }

    #[test]
    fn parses_every_execute_status() {
        let done: ExecuteResponse =
            serde_json::from_str(r#"{"status":"completed","stdout":"{}"}"#).unwrap();
        assert_eq!(done, ExecuteResponse::Completed { stdout: "{}".into() });
        let cancelled: ExecuteResponse = serde_json::from_str(r#"{"status":"cancelled"}"#).unwrap();
        assert_eq!(cancelled, ExecuteResponse::Cancelled);
    }

    #[test]
    fn an_unreachable_engine_is_a_failure_not_a_panic() {
        let outcome = to_outcome(Err("webview gone".into()), &Tail::default());
        assert!(matches!(outcome, Outcome::Failed { message } if message.contains("webview gone")));
    }
}
