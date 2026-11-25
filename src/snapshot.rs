//! `--screenshot <file.png>`: the window's picture, taken by the webview
//! itself so no Screen Recording permission is needed and nothing has to be
//! in front of the person's other windows.

use std::path::PathBuf;
use tauri::{Runtime, WebviewWindow};

/// Takes the picture and calls `done` with the outcome, on the main thread.
#[cfg(target_os = "macos")]
pub fn capture<R: Runtime, F>(window: &WebviewWindow<R>, out: PathBuf, done: F) -> Result<(), String>
where
    F: FnOnce(Result<(), String>) + Send + 'static,
{
    use block2::RcBlock;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_foundation::{NSDictionary, NSError};
    use objc2_web_kit::WKWebView;
    use std::sync::Mutex;

    let done = Mutex::new(Some(done));
    window
        .with_webview(move |platform| {
            let finish = move |result: Result<(), String>| {
                if let Some(f) = done.lock().ok().and_then(|mut d| d.take()) {
                    f(result);
                }
            };
            // SAFETY: Tauri hands this closure the live WKWebView of this
            // window, on the main thread, for the duration of the call; the
            // snapshot request below is made inside that call.
            let webview: &WKWebView = unsafe { &*(platform.inner() as *const WKWebView) };
            let block = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
                if image.is_null() {
                    // SAFETY: WebKit passes either an image or an error, and
                    // the error, when present, is valid for this callback.
                    let reason = unsafe { error.as_ref() }
                        .map(|e| e.localizedDescription().to_string())
                        .unwrap_or_else(|| "no picture".to_string());
                    finish(Err(format!("The window could not be photographed: {reason}")));
                    return;
                }
                // SAFETY: non-null and valid for the callback, per WebKit.
                let image = unsafe { &*image };
                let png = image
                    .TIFFRepresentation()
                    .and_then(|tiff| NSBitmapImageRep::imageRepWithData(&tiff))
                    .and_then(|rep| {
                        let props = NSDictionary::new();
                        // SAFETY: an empty property dictionary is valid for
                        // every file type.
                        unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &props) }
                    });
                finish(match png {
                    Some(data) => std::fs::write(&out, data.to_vec())
                        .map_err(|e| format!("Could not save {}: {e}", out.display())),
                    None => Err("The picture could not be turned into a PNG".to_string()),
                });
            });
            // SAFETY: `None` asks for the whole visible view; the block lives
            // until WebKit drops it after the single callback.
            unsafe { webview.takeSnapshotWithConfiguration_completionHandler(None, &block) };
        })
        .map_err(|e| format!("Could not reach the window: {e}"))
}

#[cfg(not(target_os = "macos"))]
pub fn capture<R: Runtime, F>(_window: &WebviewWindow<R>, _out: PathBuf, done: F) -> Result<(), String>
where
    F: FnOnce(Result<(), String>) + Send + 'static,
{
    done(Err("--screenshot is only built for macOS in this version".to_string()));
    Ok(())
}
