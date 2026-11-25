//! The Rust half of the bridge to `EnginePlugin.kt`.
//!
//! Kotlin commands run on Android's main thread and the Rust side waits on
//! them, so nothing here may be called from the main thread — every caller is
//! a job thread or a `spawn_blocking` task. Plugin setup only spawns.

use crate::{extract_url, to_outcome, EngineInfo, ExecuteResponse, Message, Outcome, Tail};
use std::collections::HashMap;
use std::sync::{mpsc, Arc, Mutex};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::plugin::PluginHandle;
use tauri::{AppHandle, Emitter, Runtime};

enum Event {
    Line(String),
    Finished(Result<ExecuteResponse, String>),
}

type Sinks = Arc<Mutex<HashMap<String, mpsc::Sender<Event>>>>;

pub struct Engine<R: Runtime> {
    handle: PluginHandle<R>,
    sinks: Sinks,
    /// Cached only on success: a failed unpack (full disk) is retried on the
    /// next call instead of disabling downloads until the app restarts.
    info: Mutex<Option<EngineInfo>>,
}

impl<R: Runtime> Engine<R> {
    pub(crate) fn new(app: AppHandle<R>, handle: PluginHandle<R>) -> Self {
        let sinks: Sinks = Arc::default();
        let channel = {
            let sinks = sinks.clone();
            Channel::<serde_json::Value>::new(move |body| {
                if let InvokeResponseBody::Json(json) = body {
                    route(&app, &sinks, &json);
                }
                Ok(())
            })
        };
        // Off the setup thread: `run_mobile_plugin` waits on the main thread,
        // which is the thread running setup.
        let subscriber = handle.clone();
        std::thread::spawn(move || {
            let payload = serde_json::json!({ "channel": channel });
            if let Err(e) = subscriber.run_mobile_plugin::<serde_json::Value>("subscribe", payload) {
                eprintln!("[udl-engine] subscribe failed: {e}");
            }
        });
        Self { handle, sinks, info: Mutex::new(None) }
    }

    /// Waits for the one-time unpacking of Python and yt-dlp (seconds on the
    /// first launch, instant afterwards) and returns what it produced.
    pub fn info(&self) -> Result<EngineInfo, String> {
        if let Some(info) = self.info.lock().unwrap().clone() {
            return Ok(info);
        }
        let info: EngineInfo = self
            .handle
            .run_mobile_plugin("initialize", ())
            .map_err(|e| format!("Download engine failed to start: {e}"))?;
        *self.info.lock().unwrap() = Some(info.clone());
        Ok(info)
    }

    /// Runs yt-dlp with `args`, calling `on_line` for every output record
    /// until it exits. `merge_stderr` must be false when stdout is parsed as
    /// data (`--dump-single-json`), and true for downloads so ffmpeg's
    /// progress on stderr reaches `on_line`.
    pub fn execute(
        &self,
        job_id: &str,
        args: &[String],
        merge_stderr: bool,
        mut on_line: impl FnMut(&str),
    ) -> Outcome {
        let (tx, rx) = mpsc::channel();
        self.sinks.lock().unwrap().insert(job_id.to_string(), tx.clone());

        let handle = self.handle.clone();
        let payload = serde_json::json!({
            "jobId": job_id,
            "args": args,
            "mergeStderr": merge_stderr,
        });
        std::thread::spawn(move || {
            let response = handle
                .run_mobile_plugin::<ExecuteResponse>("execute", payload)
                .map_err(|e| e.to_string());
            let _ = tx.send(Event::Finished(response));
        });

        // Lines are delivered synchronously from Kotlin's reader thread before
        // it resolves, so `Finished` is always the last event for this job.
        let mut tail = Tail::default();
        let outcome = loop {
            match rx.recv() {
                Ok(Event::Line(line)) => {
                    tail.push(&line);
                    on_line(&line);
                }
                Ok(Event::Finished(response)) => break to_outcome(response, &tail),
                Err(_) => {
                    break Outcome::Failed { message: "Download engine stopped responding".into() }
                }
            }
        };
        self.sinks.lock().unwrap().remove(job_id);
        outcome
    }

    /// Stops a running job, or makes one that has not started yet exit as
    /// soon as it does — Kotlin remembers the id for that window.
    pub fn cancel(&self, job_id: &str) {
        let payload = serde_json::json!({ "jobId": job_id });
        if let Err(e) = self.handle.run_mobile_plugin::<serde_json::Value>("cancel", payload) {
            eprintln!("[udl-engine] cancel {job_id} failed: {e}");
        }
    }

    /// Makes a finished file visible to the gallery and music apps.
    pub fn scan_media(&self, path: &str) {
        let payload = serde_json::json!({ "path": path });
        if let Err(e) = self.handle.run_mobile_plugin::<serde_json::Value>("scanMedia", payload) {
            eprintln!("[udl-engine] media scan of {path} failed: {e}");
        }
    }

    /// Updates yt-dlp in place; returns the version now installed. Extractors
    /// break whenever YouTube changes, so this is how the app keeps working
    /// between releases — the same mechanism Seal relies on.
    pub fn update_ytdlp(&self) -> Result<String, String> {
        #[derive(serde::Deserialize)]
        struct Updated {
            version: String,
        }
        let updated: Updated = self
            .handle
            .run_mobile_plugin("updateYtdlp", ())
            .map_err(|e| format!("yt-dlp update failed: {e}"))?;
        if let Some(info) = self.info.lock().unwrap().as_mut() {
            info.ytdlp_version = updated.version.clone();
        }
        Ok(updated.version)
    }

    /// A link shared to the app before the webview was listening, if any.
    pub fn take_shared_url(&self) -> Option<String> {
        #[derive(serde::Deserialize)]
        struct Pending {
            text: Option<String>,
        }
        self.handle
            .run_mobile_plugin::<Pending>("takeSharedText", ())
            .ok()
            .and_then(|p| p.text)
            .and_then(|text| extract_url(&text))
    }
}

fn route<R: Runtime>(app: &AppHandle<R>, sinks: &Sinks, json: &str) {
    match serde_json::from_str::<Message>(json) {
        Ok(Message::Line { job_id, line }) => {
            let sink = { sinks.lock().unwrap().get(&job_id).cloned() };
            if let Some(sink) = sink {
                let _ = sink.send(Event::Line(line));
            }
        }
        Ok(Message::Share { text }) => match extract_url(&text) {
            Some(url) => {
                let _ = app.emit("shared-url", url);
            }
            None => eprintln!("[udl-engine] shared text had no link: {text:?}"),
        },
        Err(e) => eprintln!("[udl-engine] unreadable engine message ({e}): {json}"),
    }
}
