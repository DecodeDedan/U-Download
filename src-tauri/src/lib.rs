use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
#[cfg(not(target_os = "android"))]
use std::process::Command;
#[cfg(not(target_os = "android"))]
use tauri::menu::{Menu, MenuItem};
#[cfg(not(target_os = "android"))]
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Runtime, State, Window};
#[cfg(not(target_os = "android"))]
use tauri_plugin_dialog::DialogExt;

// Bundled desktop binaries; Android's engine ships its own.
#[cfg(not(target_os = "android"))]
mod binary_manager;
mod engine;
mod jobs;
mod metadata_cache;
mod probe;
mod proc;
mod queue;
mod runner;
mod ytdlp;

/// A link another app shared to U-Download before the webview was listening.
/// Links shared while the app is open arrive as the `shared-url` event.
#[tauri::command]
async fn get_shared_url<R: Runtime>(app_handle: AppHandle<R>) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        engine::on_engine(&app_handle, |engine| engine.take_shared_url())
            .await?
            .ok_or_else(|| "empty".to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app_handle;
        Err("unsupported".into())
    }
}

/// `Download/U-Download` on shared storage, where Android downloads land.
#[tauri::command]
async fn get_android_videos_dir<R: Runtime>(app_handle: AppHandle<R>) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        Ok(engine::on_engine(&app_handle, |engine| engine.info()).await??.default_output_dir)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app_handle;
        Err("unsupported".into())
    }
}

/// Updates yt-dlp inside the Android engine. Extractors break whenever a site
/// changes, and an APK cannot replace itself, so this is how Android keeps
/// working between releases.
#[cfg(target_os = "android")]
#[tauri::command]
async fn update_engine<R: Runtime>(app_handle: AppHandle<R>) -> Result<String, String> {
    engine::on_engine(&app_handle, |engine| engine.update_ytdlp()).await?
}

#[tauri::command]
async fn check_ffmpeg<R: Runtime>(app_handle: AppHandle<R>) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        // ffmpeg ships inside the engine; it is usable once the engine is.
        engine::on_engine(&app_handle, |engine| engine.info()).await??;
        Ok("✅ FFmpeg: bundled with the download engine".to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let paths = binary_manager::resolve_paths(&app_handle)?;
        binary_manager::ensure_executable(&paths)?;

        match Command::new(&paths.ffmpeg).arg("-version").output() {
            Ok(output) => {
                let version = String::from_utf8_lossy(&output.stdout);
                Ok(format!(
                    "✅ FFmpeg: {}",
                    version.lines().next().unwrap_or("unknown")
                ))
            }
            Err(e) => Err(format!("❌ FFmpeg: Bundled binary not found or not executable ({})", e)),
        }
    }
}

#[tauri::command]
async fn select_output_folder<R: Runtime>(app_handle: AppHandle<R>) -> Result<String, String> {
    // yt-dlp writes through file paths, and the Android folder picker only
    // hands out content:// URIs, so Android downloads always go to the one
    // shared folder the engine can write to.
    #[cfg(target_os = "android")]
    {
        Ok(engine::on_engine(&app_handle, |engine| engine.info()).await??.default_output_dir)
    }
    #[cfg(not(target_os = "android"))]
    {
        use tauri_plugin_dialog::DialogExt;
        // Use blocking approach for folder selection
        let (tx, rx) = std::sync::mpsc::channel();
        app_handle.dialog().file().pick_folder(move |folder_path| {
            let _ = tx.send(folder_path);
        });
        // Wait for the dialog result with timeout
        match rx.recv_timeout(std::time::Duration::from_secs(30)) {
            Ok(Some(path)) => Ok(path.to_string()),
            Ok(None) => Err("No folder selected".to_string()),
            Err(_) => Err("Dialog timeout".to_string()),
        }
    }
}

#[cfg(target_os = "android")]
#[tauri::command]
async fn test_dependencies<R: Runtime>(app_handle: AppHandle<R>) -> Result<String, String> {
    let info = engine::on_engine(&app_handle, |engine| engine.info()).await??;
    // youtubedl-android only records a version after its first self-update;
    // until then, yt-dlp is asked directly.
    let version = if info.ytdlp_version == "unknown" {
        let app = app_handle.clone();
        tokio::task::spawn_blocking(move || engine::capture(&app, &["--version".to_string()], false))
            .await
            .map_err(|e| format!("Version check failed: {e}"))?
            .map(|out| out.trim().to_string())
            .unwrap_or_else(|e| format!("unknown ({e})"))
    } else {
        info.ytdlp_version
    };
    Ok([
        format!("✅ yt-dlp: {version}"),
        "✅ aria2c, ffmpeg, QuickJS: bundled with the download engine".to_string(),
        "✅ Saving to: Download/U-Download".to_string(),
    ]
    .join("\n"))
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
async fn test_dependencies<R: Runtime>(app_handle: AppHandle<R>) -> Result<String, String> {
    let paths = binary_manager::resolve_paths(&app_handle)?;
    binary_manager::ensure_executable(&paths)?;
    let mut results = Vec::new();

    // Test yt-dlp (bundled)
    match Command::new(&paths.yt_dlp).arg("--version").output() {
        Ok(output) => {
            let version = String::from_utf8_lossy(&output.stdout);
            results.push(format!("✅ yt-dlp: {}", version.trim()));
        }
        Err(e) => {
            results.push(format!("❌ yt-dlp: Bundled binary error ({})", e));
        }
    }

    // Test aria2c (bundled)
    match Command::new(&paths.aria2c).arg("--version").output() {
        Ok(output) => {
            let version = String::from_utf8_lossy(&output.stdout);
            results.push(format!(
                "✅ aria2c: {}",
                version.lines().next().unwrap_or("unknown")
            ));
        }
        Err(e) => {
            results.push(format!("❌ aria2c: Bundled binary error ({})", e));
        }
    }

    // Reported because its absence is silent until a download fails: the
    // bundled ffmpeg is built against OpenSSL with no trust store of its own,
    // so with no CA bundle every HTTPS fetch it makes — including every
    // trimmed download, which yt-dlp routes through ffmpeg — dies with
    // "certificate verify failed".
    match &paths.ca_cert {
        Some(ca) => results.push(format!("✅ CA bundle: {}", ca.display())),
        None => results.push(
            "⚠️ CA bundle: none found — HTTPS fetches made by ffmpeg may fail certificate verification"
                .to_string(),
        ),
    }

    // Reported because it is optional and its absence is silent otherwise: with
    // no JS runtime, recent yt-dlp finds no usable YouTube format at all.
    match binary_manager::resolve_js_runtime(&paths) {
        Some(rt) => results.push(format!("✅ JS runtime: {} ({})", rt.name, rt.path.display())),
        None => results.push(
            "⚠️ JS runtime: none found — YouTube extraction may return no usable formats"
                .to_string(),
        ),
    }

    Ok(results.join("\n"))
}

/// The concurrency the UI last asked for.
///
/// Only `enqueue_job` carries a concurrency argument, but cancelling, pausing
/// and resuming all change how many slots are free and therefore all need to
/// re-run the scheduler. They read the last requested value from here rather
/// than guessing a default that could under-dispatch.
type ConcurrencyState = Arc<AtomicU32>;

const DEFAULT_CONCURRENCY: u32 = 2;

async fn runner_context<R: Runtime>(
    window: &Window<R>,
    concurrency: u32,
) -> Result<runner::RunnerContext, String> {
    #[cfg(target_os = "android")]
    {
        // Waits out the engine's first-launch unpack, so a job is never
        // queued against an engine that cannot start.
        let info = engine::on_engine(window.app_handle(), |engine| engine.info()).await??;
        Ok(runner::RunnerContext {
            toolchain: ytdlp::Toolchain::Android {
                ca_bundle: info.ca_bundle,
                temp_dir: info.temp_dir,
            },
            concurrency: concurrency.max(1),
        })
    }
    #[cfg(not(target_os = "android"))]
    {
        let paths = binary_manager::resolve_paths(window.app_handle())?;
        binary_manager::ensure_executable(&paths)?;
        let js_runtime = binary_manager::resolve_js_runtime(&paths);
        Ok(runner::RunnerContext {
            toolchain: ytdlp::Toolchain::Desktop {
                ffmpeg: paths.ffmpeg.to_string_lossy().into_owned(),
                js_runtime: js_runtime.map(|rt| rt.flag_value()),
            },
            yt_dlp: paths.yt_dlp,
            binaries_dir: paths.dir,
            concurrency: concurrency.max(1),
        })
    }
}

#[tauri::command]
async fn enqueue_job<R: Runtime>(
    window: Window<R>,
    registry: State<'_, jobs::SharedJobs>,
    concurrency_state: State<'_, ConcurrencyState>,
    metadata_cache: State<'_, metadata_cache::SharedMetadataCache>,
    url: String,
    format: ytdlp::FormatChoice,
    trim: Option<ytdlp::TrimRange>,
    output_folder: String,
    concurrency: Option<u32>,
) -> Result<jobs::JobId, String> {
    // Resolved before the job is inserted, so a missing binary is reported to
    // the caller instead of leaving a job queued that can never start.
    let ctx = runner_context(&window, concurrency.unwrap_or(DEFAULT_CONCURRENCY)).await?;
    concurrency_state.store(ctx.concurrency, Ordering::Relaxed);

    // Lock scope: one insert.
    let id = {
        let mut reg = registry.lock().unwrap();
        reg.insert(jobs::Job::new(url.clone(), format, trim, output_folder))
    };

    // Announced before dispatch, because `pump` emits only for the jobs it can
    // actually claim. The frontend populates its map from `list_jobs` once at
    // mount and from events thereafter, so an enqueue beyond the concurrency
    // limit would otherwise not appear in the UI at all until a slot freed up.
    runner::emit_job(&window, registry.inner(), &id);

    runner::pump(window.clone(), registry.inner().clone(), ctx);

    // Deliberately not awaited: fetching title/thumbnail is a network round
    // trip through yt-dlp (`--dump-single-json`) that can take several
    // seconds, and `enqueue_job` must return immediately so the job appears
    // in the queue right away rather than the UI waiting on it. This task
    // runs entirely off that path, on the async runtime rather than the
    // caller's turn, and reports back via its own `job-updated` emit once it
    // lands — same pattern as every progress update the runner emits.
    //
    // A probe failure (age-gated video, offline, unsupported site, ...) must
    // not fail the job: it is logged and nothing is written, leaving the job
    // exactly as usable as it was — the frontend falls back to the raw URL
    // and no thumbnail. See `probe::fetch_job_metadata` and
    // `jobs::JobRegistry::set_metadata` for the empty-means-unknown contract
    // that makes this safe regardless of whether the download's own
    // filename-stem guess (`set_output_path`) landed first.
    {
        let window = window.clone();
        let registry = registry.inner().clone();
        // The same cache `resolve_preview` reads, cloned out of managed state
        // like `registry` above. If the trim panel already probed this URL the
        // fetch below returns immediately; if that probe is still running, this
        // waits on it instead of starting a second one.
        let cache = metadata_cache.inner().clone();
        let app_handle = window.app_handle().clone();
        let id = id.clone();
        tokio::spawn(async move {
            match probe::fetch_job_metadata(&app_handle, &cache, &url).await {
                Ok(meta) => {
                    // Lock scope: two conditional string writes, no I/O.
                    {
                        registry.lock().unwrap().set_metadata(&id, &meta.title, &meta.thumbnail);
                    }
                    runner::emit_job(&window, &registry, &id);
                }
                Err(e) => {
                    eprintln!("Metadata probe failed for job {id}: {e}");
                }
            }
        });
    }

    Ok(id)
}

#[tauri::command]
fn list_jobs(registry: State<'_, jobs::SharedJobs>) -> Vec<jobs::Job> {
    // Lock scope: one snapshot of the registry.
    registry.lock().unwrap().list()
}

#[tauri::command]
async fn cancel_job<R: Runtime>(
    window: Window<R>,
    registry: State<'_, jobs::SharedJobs>,
    concurrency_state: State<'_, ConcurrencyState>,
    job_id: jobs::JobId,
) -> Result<(), String> {
    let was_running = {
        // Lock scope: map writes only — `cancel` hands the kill and the reap
        // to a detached thread precisely so this does not block.
        let mut reg = registry.lock().unwrap();
        let was_running = is_running(&reg, &job_id);
        reg.cancel(&job_id);
        was_running
    };
    stop_engine_job(&window, &job_id, was_running).await;
    runner::emit_job(&window, registry.inner(), &job_id);
    repump(&window, &registry, &concurrency_state).await;
    Ok(())
}

#[tauri::command]
async fn pause_job<R: Runtime>(
    window: Window<R>,
    registry: State<'_, jobs::SharedJobs>,
    concurrency_state: State<'_, ConcurrencyState>,
    job_id: jobs::JobId,
) -> Result<(), String> {
    let was_running = {
        // Lock scope: map writes only. Pausing an in-flight job goes through
        // the same non-blocking `cancel` as above.
        let mut reg = registry.lock().unwrap();
        let was_running = is_running(&reg, &job_id);
        queue::pause(&mut reg, &job_id);
        was_running
    };
    stop_engine_job(&window, &job_id, was_running).await;
    runner::emit_job(&window, registry.inner(), &job_id);
    repump(&window, &registry, &concurrency_state).await;
    Ok(())
}

#[tauri::command]
async fn resume_job<R: Runtime>(
    window: Window<R>,
    registry: State<'_, jobs::SharedJobs>,
    concurrency_state: State<'_, ConcurrencyState>,
    job_id: jobs::JobId,
) -> Result<(), String> {
    {
        // Lock scope: one status write.
        let mut reg = registry.lock().unwrap();
        queue::resume(&mut reg, &job_id);
    }
    runner::emit_job(&window, registry.inner(), &job_id);
    // Without this the resumed job would sit in `Queued` until some unrelated
    // job finished or another was enqueued.
    repump(&window, &registry, &concurrency_state).await;
    Ok(())
}

/// Whether a job has a yt-dlp invocation that a cancel or pause must stop.
fn is_running(reg: &jobs::JobRegistry, id: &jobs::JobId) -> bool {
    reg.get(id).is_some_and(|job| job.status.is_active())
}

/// Stops the engine's process for a job the registry just cancelled or paused.
///
/// Desktop needs nothing here: the registry owns the child and kills it. On
/// Android the process belongs to the engine, so it is told separately — and
/// only for running jobs, since a cancel id it never sees again would stay in
/// its pending-cancel set for the life of the process.
async fn stop_engine_job<R: Runtime>(window: &Window<R>, id: &jobs::JobId, was_running: bool) {
    #[cfg(target_os = "android")]
    if was_running {
        let id = id.clone();
        if let Err(e) = engine::on_engine(window.app_handle(), move |engine| engine.cancel(&id)).await {
            eprintln!("Could not stop engine job: {e}");
        }
    }
    #[cfg(not(target_os = "android"))]
    let _ = (window, id, was_running);
}

/// Re-runs the scheduler after a command changed how many slots are free.
///
/// A binary that cannot be resolved must not turn a successful cancel, pause
/// or resume into an error — the state change already happened — so a failed
/// context simply means nothing is dispatched.
async fn repump<R: Runtime>(
    window: &Window<R>,
    registry: &State<'_, jobs::SharedJobs>,
    concurrency_state: &State<'_, ConcurrencyState>,
) {
    if let Ok(ctx) = runner_context(window, concurrency_state.load(Ordering::Relaxed)).await {
        runner::pump(window.clone(), registry.inner().clone(), ctx);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let job_registry: jobs::SharedJobs = Arc::new(Mutex::new(jobs::JobRegistry::new()));
    let concurrency_state: ConcurrencyState = Arc::new(AtomicU32::new(DEFAULT_CONCURRENCY));
    // One cache for the whole session, shared by the trim panel's preview probe
    // and the job queue's metadata fetch — the two callers that used to make the
    // same 35-second `yt-dlp --dump-single-json` call separately.
    let metadata_cache: metadata_cache::SharedMetadataCache = metadata_cache::new_shared();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(job_registry)
        .manage(concurrency_state)
        .manage(metadata_cache);

    // Self-update, verified against the minisign public key in tauri.conf.json.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    // The two command lists are spelled out separately because
    // `generate_handler!` cannot take a `#[cfg]` on an individual entry.
    #[cfg(target_os = "android")]
    let builder = builder
        .plugin(tauri_plugin_udl_engine::init())
        .invoke_handler(tauri::generate_handler![
            select_output_folder,
            test_dependencies,
            check_ffmpeg,
            get_shared_url,
            get_android_videos_dir,
            update_engine,
            enqueue_job,
            list_jobs,
            cancel_job,
            pause_job,
            resume_job,
            probe::resolve_preview,
            probe::fetch_preview_proxy
        ]);

    #[cfg(not(target_os = "android"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        select_output_folder,
        test_dependencies,
        check_ffmpeg,
        get_shared_url,
        get_android_videos_dir,
        enqueue_job,
        list_jobs,
        cancel_job,
        pause_job,
        resume_job,
        probe::resolve_preview,
        probe::fetch_preview_proxy
    ]);

    builder
        .setup(move |_app| {
            #[cfg(not(target_os = "android"))]
            let app = _app;
            #[cfg(not(target_os = "android"))]
            {
                let show_item = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
                let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

                let _tray = TrayIconBuilder::new()
                    .icon(app.default_window_icon().unwrap().clone())
                    .menu(&menu)
                    .tooltip("U-Download")
                    .on_menu_event(|app, event| {
                        if event.id.as_ref() == "show" {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        } else if event.id.as_ref() == "quit" {
                            let app_handle = app.clone();
                            app.dialog()
                                .message("Are you sure you want to quit U-Download?")
                                .title("Quit Confirmation")
                                .kind(tauri_plugin_dialog::MessageDialogKind::Info)
                                .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancelCustom(
                                    "Yes".to_owned(),
                                    "No".to_owned(),
                                ))
                                .show(move |answer| {
                                    if answer {
                                        std::thread::spawn(move || {
                                            app_handle.exit(0);
                                        });
                                    }
                                });
                        }
                    })
                    .build(app)?;
            }
            Ok(())
        })
        .on_window_event(|_window, event| match event {
            tauri::WindowEvent::CloseRequested { .. } => {
                #[cfg(not(target_os = "android"))]
                {
                    let _ = _window.hide();
                }
                #[cfg(target_os = "android")]
                {
                    // Let Android handle back/close normally
                }
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
