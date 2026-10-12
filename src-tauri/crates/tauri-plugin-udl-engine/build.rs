// No commands are exposed to the webview: the app crate drives the engine from
// Rust, so the frontend never needs a permission for it.
const COMMANDS: &[&str] = &[];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
