# Android app — how it works and how to ship it

Supersedes `2026-08-25-android-status.md` (Option A from that note, done).

## Shape

One codebase. The React UI, the Rust job queue, the progress parser and the
trim logic are shared with desktop; only "run yt-dlp" differs per platform.

| Piece | Where |
|---|---|
| Engine: Python + yt-dlp, ffmpeg, aria2c, QuickJS (youtubedl-android 0.18.1, the Seal engine) | `src-tauri/crates/tauri-plugin-udl-engine/android/` (Kotlin) |
| Rust bridge: blocking `execute` streaming yt-dlp's output lines over one long-lived channel | `crates/tauri-plugin-udl-engine/src/android.rs` |
| Platform seam for args | `ytdlp::Toolchain` (`Desktop` / `Android`) |
| Download executor | `runner::execute` (cfg-split; finish logic shared) |
| Short capture calls (probe, preview proxy) | `src/engine.rs::capture` |
| Share sheet entry ("Download with U-Download") | `gen/android/app/src/main/AndroidManifest.xml` + `EnginePlugin.handleShare` |
| Background survival | `DownloadService` (dataSync foreground service, ref-counted) |

## Behaviour worth knowing

- **Share flow.** A share that launches the app is held until the frontend
  pulls it (`get_shared_url`); shares while running arrive as `shared-url`.
- **Speed.** Non-YouTube downloads go through aria2c with the Motrix profile
  (16 connections); YouTube stays on yt-dlp's chunked downloader, as on
  desktop. The `aria2c:` downloader-args value repeats the CA bundle because
  yt-dlp keeps only the last value per key.
- **Storage.** Work happens in `cacheDir/downloads/<job id>` (`-P temp:`),
  and yt-dlp moves only the finished file to `Download/U-Download`; the
  runner reads the final path from the `[MoveFiles]` line and media-scans it.
  The per-job directory is deleted however the job ends.
- **Codecs.** Android adds `-S res,vcodec:h264,acodec:m4a`: same resolution,
  but H.264/AAC beat AV1/Opus, which many phone players cannot play.
- **Updates.** An APK cannot replace itself; the sidebar offers an in-place
  yt-dlp update (`update_engine`).

## Releasing (separate from desktop)

Android is versioned on its own line in `src-tauri/tauri.android.conf.json`
(1.0.0 → versionCode 1000000; `app/build.gradle.kts` derives both from that
file, because this Tauri CLI never writes `tauri.properties`).

1. Bump `version` in `src-tauri/tauri.android.conf.json`, commit, push.
2. `npm run release:android` tags `android-vX.Y.Z` and pushes the tag.
3. `.github/workflows/release-android.yml` builds signed APKs (universal +
   per-ABI), publishes release `android-vX.Y.Z`, and refreshes the fixed
   `android-latest` release, whose `U-Download-Android.apk` is the permanent
   download link.

Neither Android release is ever marked "latest": desktop auto-update and the
macOS installer read `releases/latest`.

In the app, `useMobileUpdate` compares against the highest `android-v*` tag and
offers the download; yt-dlp updates itself weekly in the background (an
update waits for running downloads; see the read/write lock in `EnginePlugin`).

## Build

```bash
export ANDROID_HOME=~/Library/Android/sdk NDK_HOME=$ANDROID_HOME/ndk/28.2.13676358
npx tauri android build --apk --split-per-abi
```

Release signing reads `gen/android/key.properties` (git-ignored) or the
`ANDROID_KEYSTORE_PATH` / `ANDROID_KEYSTORE_PASSWORD` / `ANDROID_KEY_ALIAS` /
`ANDROID_KEY_PASSWORD` environment. CI (`release-android.yml`) needs
the secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`,
`ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`, and fails without them.

## Verified on the emulator (API 36, arm64)

Cold and warm shares; full YouTube download with merged audio; trimmed
download; MP3 extraction; 14 MB direct file through aria2c with live
progress; cancel kills the engine process and stops the service; minified
release build passes R8.

## Not verified

- Tapping Share inside the YouTube app itself (the emulator's YouTube needs
  first-run setup); the intent it sends is the one tested.
- A physical phone, Android 9 and older (legacy storage permission path),
  and the Android 15 dataSync six-hour limit.
- iOS: out of scope (no in-app yt-dlp, App Store guideline 5.2.3).
