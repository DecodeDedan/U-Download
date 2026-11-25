//! U-Download's own segmented downloader for direct file links (what Motrix
//! hands to aria2): many ranged connections per file, idle connections
//! stealing the back half of the slowest range, a resume file so a pause
//! keeps its bytes, retries with backoff, and one shared speed limit.
//!
//! Media pages (YouTube, TikTok, ...) do not come here: they need yt-dlp to
//! find the real stream first. See `router`.

pub mod limiter;
pub mod plan;
mod resume;

pub use limiter::Limiter;
use plan::Plan;
use reqwest::header::{ACCEPT_ENCODING, CONTENT_DISPOSITION, CONTENT_RANGE, RANGE};
use reqwest::StatusCode;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

pub const DEFAULT_CONNECTIONS: u32 = 16;
/// Motrix's ceiling for connections per server.
pub const MAX_CONNECTIONS: u32 = 64;
/// aria2's `--min-split-size` default: no range is cut smaller than this.
pub const MIN_SPLIT: u64 = 1024 * 1024;
/// A connection that delivers nothing for this long is dropped and retried.
const STALL_TIMEOUT: Duration = Duration::from_secs(20);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// Consecutive failures without progress before a range gives up.
const MAX_ATTEMPTS: u32 = 6;
const BACKOFF_BASE: Duration = Duration::from_millis(400);
const BACKOFF_CAP: Duration = Duration::from_secs(8);
const TELEMETRY_INTERVAL: Duration = Duration::from_millis(500);
/// Resume file written every this many telemetry ticks (two seconds).
const CHECKPOINT_TICKS: u32 = 4;
/// Cells in the piece map the interface draws.
pub const PIECE_CELLS: usize = 64;
/// Weight of the newest sample in the speed average.
const SPEED_SMOOTHING: f64 = 0.3;
const USER_AGENT: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) U-Download/4.0";

#[derive(Debug, Clone)]
pub struct Settings {
    pub connections: u32,
    pub min_split: u64,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { connections: DEFAULT_CONNECTIONS, min_split: MIN_SPLIT }
    }
}

/// One progress report, sent twice a second.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Telemetry {
    pub file_name: String,
    pub downloaded: u64,
    pub total: Option<u64>,
    pub speed: u64,
    pub eta: Option<u64>,
    pub connections: u32,
    pub pieces: Vec<u8>,
}

#[derive(Debug, PartialEq)]
pub enum Outcome {
    Done(PathBuf),
    /// Stopped by the caller; a ranged download keeps its partial file and
    /// resume file, so the next run carries on.
    Cancelled,
}

pub type Cancel = Arc<AtomicBool>;

/// One client for every download: connections to the same server are reused.
pub(crate) fn client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .user_agent(USER_AGENT)
                .connect_timeout(CONNECT_TIMEOUT)
                .pool_max_idle_per_host(MAX_CONNECTIONS as usize)
                .tcp_nodelay(true)
                .build()
                .map_err(|e| format!("Could not start the download engine: {e}"))
        })
        .as_ref()
        .map_err(Clone::clone)
}

fn backoff(failures: u32) -> Duration {
    BACKOFF_BASE.saturating_mul(1 << failures.min(5)).min(BACKOFF_CAP)
}

/// What the first request learned about the file.
#[derive(Debug)]
struct Probe {
    total: Option<u64>,
    ranged: bool,
    file_name: String,
}

/// `Content-Range: bytes 0-0/12345` → 12345.
fn total_from_content_range(value: &str) -> Option<u64> {
    value.rsplit_once('/')?.1.trim().parse().ok()
}

/// Makes a server-supplied name safe to create in the download folder.
pub fn sanitize_file_name(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| if c.is_control() || "/\\:*?\"<>|".contains(c) { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_start_matches('.').trim_end_matches(['.', ' ']);
    let mut name = trimmed.to_string();
    const MAX_NAME_BYTES: usize = 180;
    if name.len() > MAX_NAME_BYTES {
        let mut cut = MAX_NAME_BYTES;
        while !name.is_char_boundary(cut) {
            cut -= 1;
        }
        name.truncate(cut);
    }
    if name.is_empty() {
        "download".to_string()
    } else {
        name
    }
}

/// The file name from a `Content-Disposition` header, preferring the
/// RFC 6266 `filename*=UTF-8''...` form when both are present.
pub fn name_from_disposition(value: &str) -> Option<String> {
    let mut plain = None;
    for part in value.split(';').map(str::trim) {
        let Some((key, val)) = part.split_once('=') else { continue };
        let key = key.trim().to_ascii_lowercase();
        let val = val.trim();
        if key == "filename*" {
            let encoded = val.split_once("''").map(|(_, rest)| rest).unwrap_or(val);
            let decoded = percent_encoding::percent_decode_str(encoded.trim_matches('"'))
                .decode_utf8_lossy()
                .into_owned();
            if !decoded.is_empty() {
                return Some(decoded);
            }
        } else if key == "filename" {
            plain = Some(val.trim_matches('"').to_string()).filter(|v| !v.is_empty());
        }
    }
    plain
}

fn name_from_url(url: &reqwest::Url) -> Option<String> {
    let last = url.path_segments()?.rev().find(|s| !s.is_empty())?;
    let decoded = percent_encoding::percent_decode_str(last).decode_utf8_lossy().into_owned();
    (!decoded.is_empty()).then_some(decoded)
}

/// `folder/name`, or `folder/name (1).ext`, `(2)`... if that is taken.
pub fn unique_path(folder: &Path, name: &str) -> PathBuf {
    let first = folder.join(name);
    if !first.exists() {
        return first;
    }
    let path = Path::new(name);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or(name);
    let ext = path.extension().and_then(|s| s.to_str());
    (1..)
        .map(|n| match ext {
            Some(ext) => folder.join(format!("{stem} ({n}).{ext}")),
            None => folder.join(format!("{stem} ({n})")),
        })
        .find(|candidate| !candidate.exists())
        .unwrap_or(first)
}

async fn probe(url: &reqwest::Url, cancel: &Cancel) -> Result<Probe, String> {
    let client = client()?;
    let mut failures = 0;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        let sent = tokio::time::timeout(
            STALL_TIMEOUT,
            client
                .get(url.clone())
                .header(RANGE, "bytes=0-0")
                .header(ACCEPT_ENCODING, "identity")
                .send(),
        )
        .await;
        let response = match sent {
            Ok(Ok(r)) => r,
            Ok(Err(e)) if failures + 1 < MAX_ATTEMPTS => {
                eprintln!("accel: probe of {url} failed ({e}), retrying");
                failures += 1;
                tokio::time::sleep(backoff(failures)).await;
                continue;
            }
            Ok(Err(e)) => return Err(format!("Could not reach the server: {e}")),
            Err(_) if failures + 1 < MAX_ATTEMPTS => {
                failures += 1;
                continue;
            }
            Err(_) => return Err("The server did not answer".into()),
        };

        let status = response.status();
        if (status.is_server_error() || status == StatusCode::TOO_MANY_REQUESTS)
            && failures + 1 < MAX_ATTEMPTS
        {
            failures += 1;
            tokio::time::sleep(backoff(failures)).await;
            continue;
        }
        let file_name = response
            .headers()
            .get(CONTENT_DISPOSITION)
            .and_then(|v| v.to_str().ok())
            .and_then(name_from_disposition)
            .or_else(|| name_from_url(response.url()))
            .map(|n| sanitize_file_name(&n))
            .unwrap_or_else(|| "download".to_string());

        return match status {
            StatusCode::PARTIAL_CONTENT => {
                let total = response
                    .headers()
                    .get(CONTENT_RANGE)
                    .and_then(|v| v.to_str().ok())
                    .and_then(total_from_content_range);
                Ok(Probe { ranged: total.is_some(), total, file_name })
            }
            StatusCode::OK => Ok(Probe { total: response.content_length(), ranged: false, file_name }),
            other => Err(format!("The server refused the file ({other})")),
        };
    }
}

/// Writes `data` at `offset` without moving a shared cursor, so every
/// connection can write into one open file at once.
fn write_at(file: &std::fs::File, data: &[u8], offset: u64) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileExt;
        file.write_all_at(data, offset)
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileExt;
        let mut written = 0;
        while written < data.len() {
            let n = file.seek_write(&data[written..], offset + written as u64)?;
            if n == 0 {
                return Err(std::io::ErrorKind::WriteZero.into());
            }
            written += n;
        }
        Ok(())
    }
}

/// State shared by every connection of one ranged download.
struct Ranged {
    url: reqwest::Url,
    plan: Mutex<Plan>,
    file: std::fs::File,
    min_split: u64,
    limiter: Arc<Limiter>,
    cancel: Cancel,
    /// Connections currently holding a range.
    working: AtomicU32,
}

enum RangeEnd {
    Finished,
    /// The server pushed back (429/503) while other connections are still
    /// working: this one bows out instead of hammering it.
    Throttled,
}

impl Ranged {
    fn lock(&self) -> std::sync::MutexGuard<'_, Plan> {
        self.plan.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn window(&self, start: u64) -> Option<(usize, u64, u64)> {
        let plan = self.lock();
        let index = plan.index_of(start)?;
        let (pos, end) = plan.window(index)?;
        Some((index, pos, end))
    }

    async fn connection(self: Arc<Self>) -> Result<(), String> {
        loop {
            if self.cancel.load(Ordering::Relaxed) {
                return Ok(());
            }
            let start = {
                let mut plan = self.lock();
                match plan.claim(self.min_split) {
                    Some(i) => plan.segments[i].start,
                    None => return Ok(()),
                }
            };
            self.working.fetch_add(1, Ordering::Relaxed);
            let ended = self.fetch(start).await;
            self.working.fetch_sub(1, Ordering::Relaxed);
            {
                let mut plan = self.lock();
                if let Some(i) = plan.index_of(start) {
                    plan.release(i);
                }
            }
            match ended {
                Ok(RangeEnd::Finished) => continue,
                Ok(RangeEnd::Throttled) => return Ok(()),
                Err(e) => return Err(e),
            }
        }
    }

    /// Downloads one range until it is finished, shortened away by a steal,
    /// cancelled, or out of attempts.
    async fn fetch(&self, start: u64) -> Result<RangeEnd, String> {
        let client = client()?;
        let mut failures = 0u32;
        loop {
            if self.cancel.load(Ordering::Relaxed) {
                return Ok(RangeEnd::Finished);
            }
            let Some((_, from, to)) = self.window(start) else {
                return Ok(RangeEnd::Finished);
            };
            if from > to {
                return Ok(RangeEnd::Finished);
            }
            if failures >= MAX_ATTEMPTS {
                return Err(format!("A part of the file kept failing after {MAX_ATTEMPTS} tries"));
            }

            let sent = tokio::time::timeout(
                STALL_TIMEOUT,
                client
                    .get(self.url.clone())
                    .header(RANGE, format!("bytes={from}-{to}"))
                    .header(ACCEPT_ENCODING, "identity")
                    .send(),
            )
            .await;
            let mut response = match sent {
                Ok(Ok(r)) => r,
                Ok(Err(e)) => {
                    eprintln!("accel: range {from}-{to} request failed: {e}");
                    failures += 1;
                    tokio::time::sleep(backoff(failures)).await;
                    continue;
                }
                Err(_) => {
                    failures += 1;
                    continue;
                }
            };

            match response.status() {
                StatusCode::PARTIAL_CONTENT => {}
                StatusCode::TOO_MANY_REQUESTS | StatusCode::SERVICE_UNAVAILABLE => {
                    failures += 1;
                    if failures >= 2 && self.working.load(Ordering::Relaxed) > 1 {
                        return Ok(RangeEnd::Throttled);
                    }
                    tokio::time::sleep(backoff(failures)).await;
                    continue;
                }
                s if s.is_server_error() => {
                    failures += 1;
                    tokio::time::sleep(backoff(failures)).await;
                    continue;
                }
                StatusCode::OK => {
                    return Err("The server stopped accepting split downloads".into());
                }
                other => return Err(format!("The server refused part of the file ({other})")),
            }

            let mut cursor = from;
            loop {
                let chunk = match tokio::time::timeout(STALL_TIMEOUT, response.chunk()).await {
                    Ok(Ok(Some(bytes))) => bytes,
                    // Ended early: re-request what is left.
                    Ok(Ok(None)) => break,
                    Ok(Err(e)) => {
                        eprintln!("accel: range {cursor}-{to} broke off: {e}");
                        break;
                    }
                    Err(_) => {
                        eprintln!("accel: range {cursor}-{to} stalled");
                        break;
                    }
                };
                if self.cancel.load(Ordering::Relaxed) {
                    return Ok(RangeEnd::Finished);
                }
                let Some((_, pos, end)) = self.window(start) else {
                    return Ok(RangeEnd::Finished);
                };
                if pos != cursor || pos > end {
                    return Ok(RangeEnd::Finished);
                }
                let usable = (chunk.len() as u64).min(end - pos + 1) as usize;
                // ponytail: positional writes run on the async worker; they
                // land in the page cache in microseconds. Move them to a
                // writer thread if a slow disk ever shows up in profiles.
                write_at(&self.file, &chunk[..usable], cursor)
                    .map_err(|e| format!("Could not write to disk: {e}"))?;
                let advanced = {
                    let mut plan = self.lock();
                    match plan.index_of(start) {
                        Some(i) => plan.advance(i, cursor, usable as u64),
                        None => 0,
                    }
                };
                cursor += advanced;
                failures = 0;
                self.limiter.pay(advanced).await;
                if advanced < chunk.len() as u64 {
                    // A steal shortened this range; the rest belongs to
                    // another connection.
                    return Ok(RangeEnd::Finished);
                }
            }
            failures += 1;
        }
    }
}

/// Downloads `url` into `folder` and returns where the file ended up.
pub async fn download<F>(
    url: &str,
    folder: &Path,
    settings: &Settings,
    limiter: Arc<Limiter>,
    cancel: Cancel,
    on_progress: F,
) -> Result<Outcome, String>
where
    F: Fn(Telemetry) + Send + Sync,
{
    let url = reqwest::Url::parse(url).map_err(|e| format!("Not a valid link: {e}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Only http and https links can be downloaded directly".into());
    }
    std::fs::create_dir_all(folder).map_err(|e| format!("Could not open the folder: {e}"))?;

    let probe = match probe(&url, &cancel).await {
        Err(_) if cancel.load(Ordering::Relaxed) => return Ok(Outcome::Cancelled),
        other => other?,
    };
    let part = folder.join(format!("{}.part", probe.file_name));
    let sidecar = resume::sidecar_for(&part);

    let result = match (probe.ranged, probe.total) {
        (true, Some(total)) if total > 0 => {
            ranged(&url, &part, &sidecar, total, &probe.file_name, settings, limiter, &cancel, &on_progress)
                .await
        }
        _ => single(&url, &part, probe.total, &probe.file_name, limiter, &cancel, &on_progress).await,
    }?;

    match result {
        Outcome::Done(_) => {
            let final_path = unique_path(folder, &probe.file_name);
            std::fs::rename(&part, &final_path)
                .map_err(|e| format!("Could not finish the file: {e}"))?;
            Ok(Outcome::Done(final_path))
        }
        Outcome::Cancelled => Ok(Outcome::Cancelled),
    }
}

/// Deletes what a cancelled ranged download left behind: the partial file
/// and its resume file.
pub fn discard_partial(folder: &Path, file_name: &str) {
    let part = folder.join(format!("{file_name}.part"));
    for path in [resume::sidecar_for(&part), part] {
        if let Err(e) = std::fs::remove_file(&path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                eprintln!("accel: could not remove {}: {e}", path.display());
            }
        }
    }
}

/// Smooths per-tick speed and turns it into telemetry.
struct Meter {
    last_bytes: u64,
    last_at: Instant,
    speed: Option<f64>,
}

impl Meter {
    fn new(start_bytes: u64) -> Self {
        Meter { last_bytes: start_bytes, last_at: Instant::now(), speed: None }
    }

    fn sample(&mut self, bytes: u64) -> u64 {
        let now = Instant::now();
        let dt = now.duration_since(self.last_at).as_secs_f64().max(1e-3);
        let instant = bytes.saturating_sub(self.last_bytes) as f64 / dt;
        let smoothed = match self.speed {
            Some(s) => SPEED_SMOOTHING * instant + (1.0 - SPEED_SMOOTHING) * s,
            None => instant,
        };
        self.speed = Some(smoothed);
        self.last_bytes = bytes;
        self.last_at = now;
        smoothed as u64
    }
}

fn eta(total: Option<u64>, downloaded: u64, speed: u64) -> Option<u64> {
    let total = total?;
    (speed > 0).then(|| total.saturating_sub(downloaded) / speed)
}

#[allow(clippy::too_many_arguments)] // One call site; a struct would only rename these.
async fn ranged<F>(
    url: &reqwest::Url,
    part: &Path,
    sidecar: &Path,
    total: u64,
    file_name: &str,
    settings: &Settings,
    limiter: Arc<Limiter>,
    cancel: &Cancel,
    on_progress: &F,
) -> Result<Outcome, String>
where
    F: Fn(Telemetry) + Send + Sync,
{
    let min_split = settings.min_split.max(64 * 1024);
    let connections = settings.connections.clamp(1, MAX_CONNECTIONS);
    let existing = std::fs::metadata(part).map(|m| m.len()).ok();
    let restored = (existing == Some(total))
        .then(|| resume::load(sidecar, url.as_str(), total))
        .flatten();
    let resumed = restored.is_some();
    let plan = restored.unwrap_or_else(|| Plan::new(total, connections, min_split));

    let file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(!resumed)
        .open(part)
        .map_err(|e| format!("Could not create the file: {e}"))?;
    file.set_len(total).map_err(|e| format!("Not enough room for the file: {e}"))?;
    if resumed {
        eprintln!("accel: resuming {file_name} at {} of {total} bytes", plan.written());
    }

    let shared = Arc::new(Ranged {
        url: url.clone(),
        plan: Mutex::new(plan),
        file,
        min_split,
        limiter,
        cancel: cancel.clone(),
        working: AtomicU32::new(0),
    });

    let mut workers = tokio::task::JoinSet::new();
    for _ in 0..connections {
        workers.spawn(shared.clone().connection());
    }

    let checkpoint = |shared: &Ranged| -> Result<(), String> {
        shared.file.sync_data().map_err(|e| format!("Could not save progress: {e}"))?;
        let plan = shared.lock().clone();
        resume::save(sidecar, url.as_str(), &plan).map_err(|e| format!("Could not save progress: {e}"))
    };
    let report = |shared: &Ranged, speed: u64| {
        let plan = shared.lock();
        let downloaded = plan.written();
        on_progress(Telemetry {
            file_name: file_name.to_string(),
            downloaded,
            total: Some(total),
            speed,
            eta: eta(Some(total), downloaded, speed),
            connections: plan.active(),
            pieces: plan.piece_map(PIECE_CELLS),
        });
    };

    let mut meter = Meter::new(shared.lock().written());
    let mut ticks = 0u32;
    let mut first_error = None;
    let mut ticker = tokio::time::interval(TELEMETRY_INTERVAL);
    ticker.tick().await;
    loop {
        tokio::select! {
            joined = workers.join_next() => match joined {
                None => break,
                Some(Ok(Ok(()))) => {}
                Some(Ok(Err(e))) => { first_error.get_or_insert(e); }
                Some(Err(e)) => { first_error.get_or_insert(format!("A connection crashed: {e}")); }
            },
            _ = ticker.tick() => {
                let speed = meter.sample(shared.lock().written());
                report(&shared, speed);
                ticks += 1;
                if ticks.is_multiple_of(CHECKPOINT_TICKS) {
                    if let Err(e) = checkpoint(&shared) {
                        eprintln!("accel: {e}");
                    }
                }
            }
        }
    }

    if shared.lock().is_complete() {
        shared.file.sync_all().map_err(|e| format!("Could not finish the file: {e}"))?;
        report(&shared, 0);
        if let Err(e) = std::fs::remove_file(sidecar) {
            if e.kind() != std::io::ErrorKind::NotFound {
                eprintln!("accel: could not remove {}: {e}", sidecar.display());
            }
        }
        return Ok(Outcome::Done(part.to_path_buf()));
    }

    // Stopped or failed part-way: keep what we have for next time.
    checkpoint(&shared)?;
    if cancel.load(Ordering::Relaxed) {
        return Ok(Outcome::Cancelled);
    }
    Err(first_error.unwrap_or_else(|| "The download stopped before the file was complete".into()))
}

/// For servers that cannot send part of a file: one connection, no resume.
async fn single<F>(
    url: &reqwest::Url,
    part: &Path,
    total: Option<u64>,
    file_name: &str,
    limiter: Arc<Limiter>,
    cancel: &Cancel,
    on_progress: &F,
) -> Result<Outcome, String>
where
    F: Fn(Telemetry) + Send + Sync,
{
    use std::io::Write;
    let client = client()?;
    let mut response = client
        .get(url.clone())
        .header(ACCEPT_ENCODING, "identity")
        .send()
        .await
        .map_err(|e| format!("Could not reach the server: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("The server refused the file ({})", response.status()));
    }
    let mut file = std::fs::File::create(part).map_err(|e| format!("Could not create the file: {e}"))?;
    let mut downloaded = 0u64;
    let mut meter = Meter::new(0);
    let mut last_report = Instant::now();
    loop {
        if cancel.load(Ordering::Relaxed) {
            drop(file);
            if let Err(e) = std::fs::remove_file(part) {
                eprintln!("accel: could not remove {}: {e}", part.display());
            }
            return Ok(Outcome::Cancelled);
        }
        let chunk = tokio::time::timeout(STALL_TIMEOUT, response.chunk())
            .await
            .map_err(|_| "The server stopped sending".to_string())?
            .map_err(|e| format!("The download broke off: {e}"))?;
        let Some(chunk) = chunk else { break };
        file.write_all(&chunk).map_err(|e| format!("Could not write to disk: {e}"))?;
        downloaded += chunk.len() as u64;
        limiter.pay(chunk.len() as u64).await;
        if last_report.elapsed() >= TELEMETRY_INTERVAL {
            last_report = Instant::now();
            let speed = meter.sample(downloaded);
            let pieces = total
                .filter(|t| *t > 0)
                .map(|t| {
                    let mut plan = Plan::new(t, 1, t);
                    if let Some(i) = plan.claim(t) {
                        plan.advance(i, 0, downloaded.min(t));
                    }
                    plan.piece_map(PIECE_CELLS)
                })
                .unwrap_or_default();
            on_progress(Telemetry {
                file_name: file_name.to_string(),
                downloaded,
                total,
                speed,
                eta: eta(total, downloaded, speed),
                connections: 1,
                pieces,
            });
        }
    }
    if let Some(expected) = total {
        if downloaded != expected {
            return Err(format!("The file arrived incomplete ({downloaded} of {expected} bytes)"));
        }
    }
    file.sync_all().map_err(|e| format!("Could not finish the file: {e}"))?;
    Ok(Outcome::Done(part.to_path_buf()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::loopback::{byte_at, serve, ServeOptions};

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("udl-accel-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn assert_every_byte(path: &Path, size: u64) {
        let bytes = std::fs::read(path).unwrap();
        assert_eq!(bytes.len() as u64, size);
        if let Some(i) = (0..size).find(|&i| bytes[i as usize] != byte_at(i)) {
            panic!("byte {i} is wrong");
        }
    }

    fn settings(connections: u32) -> Settings {
        Settings { connections, min_split: 256 * 1024 }
    }

    async fn fetch(url: &str, dir: &Path, s: &Settings) -> (Result<Outcome, String>, Vec<Telemetry>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let cancel: Cancel = Arc::new(AtomicBool::new(false));
        let out = download(url, dir, s, Arc::new(Limiter::new(0)), cancel, move |t| {
            sink.lock().unwrap().push(t)
        })
        .await;
        let seen = seen.lock().unwrap().clone();
        (out, seen)
    }

    #[tokio::test]
    async fn downloads_every_byte_over_many_connections() {
        let size = 5 * 1024 * 1024 + 123;
        let server = serve(ServeOptions { size, ..Default::default() }).unwrap();
        let dir = temp_dir("many");
        let (out, _) = fetch(&server.url, &dir, &settings(8)).await;
        let Outcome::Done(path) = out.unwrap() else { panic!("not done") };
        assert_eq!(path.file_name().unwrap(), "sample.bin");
        assert_every_byte(&path, size);
        assert!(server.peak_connections.load(Ordering::Relaxed) > 1);
        assert!(!dir.join("sample.bin.part.udl").exists());
    }

    #[tokio::test]
    async fn many_connections_beat_one_when_the_server_caps_each() {
        let size = 3 * 1024 * 1024;
        let opts = ServeOptions { size, per_connection_bps: 1536 * 1024, ..Default::default() };
        let server = serve(opts).unwrap();

        let started = Instant::now();
        let (out, _) = fetch(&server.url, &temp_dir("one"), &settings(1)).await;
        assert!(matches!(out.unwrap(), Outcome::Done(_)));
        let one = started.elapsed();

        let started = Instant::now();
        let (out, _) = fetch(&server.url, &temp_dir("eight"), &settings(8)).await;
        assert!(matches!(out.unwrap(), Outcome::Done(_)));
        let eight = started.elapsed();
        assert!(eight * 3 < one, "8 connections took {eight:?}, 1 took {one:?}");
    }

    #[tokio::test]
    async fn a_cancelled_download_resumes_from_its_bytes() {
        let size = 4 * 1024 * 1024;
        let opts = ServeOptions { size, per_connection_bps: 512 * 1024, ..Default::default() };
        let server = serve(opts).unwrap();
        let dir = temp_dir("resume");
        let s = settings(4);

        let cancel: Cancel = Arc::new(AtomicBool::new(false));
        let stopper = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(900)).await;
            stopper.store(true, Ordering::Relaxed);
        });
        let out = download(&server.url, &dir, &s, Arc::new(Limiter::new(0)), cancel, |_| {}).await;
        assert_eq!(out.unwrap(), Outcome::Cancelled);
        assert!(dir.join("sample.bin.part.udl").exists());

        let (out, seen) = fetch(&server.url, &dir, &s).await;
        let Outcome::Done(path) = out.unwrap() else { panic!("not done") };
        assert_every_byte(&path, size);
        assert!(seen.first().map(|t| t.downloaded).unwrap_or(0) > 0, "did not resume");
    }

    #[tokio::test]
    async fn retries_through_server_errors() {
        let size = 2 * 1024 * 1024;
        let server = serve(ServeOptions { size, fail_first: 3, ..Default::default() }).unwrap();
        let dir = temp_dir("retry");
        let (out, _) = fetch(&server.url, &dir, &settings(4)).await;
        let Outcome::Done(path) = out.unwrap() else { panic!("not done") };
        assert_every_byte(&path, size);
    }

    #[tokio::test]
    async fn streams_on_one_connection_when_the_server_cannot_split() {
        let size = 1024 * 1024 + 7;
        let server = serve(ServeOptions { size, ranges: false, ..Default::default() }).unwrap();
        let dir = temp_dir("plain");
        let (out, _) = fetch(&server.url, &dir, &settings(8)).await;
        let Outcome::Done(path) = out.unwrap() else { panic!("not done") };
        assert_every_byte(&path, size);
    }

    #[tokio::test]
    async fn a_second_copy_gets_a_numbered_name() {
        let server = serve(ServeOptions { size: 4096, ..Default::default() }).unwrap();
        let dir = temp_dir("names");
        let (first, _) = fetch(&server.url, &dir, &settings(2)).await;
        let (second, _) = fetch(&server.url, &dir, &settings(2)).await;
        assert_eq!(first.unwrap(), Outcome::Done(dir.join("sample.bin")));
        assert_eq!(second.unwrap(), Outcome::Done(dir.join("sample (1).bin")));
    }

    #[tokio::test]
    async fn refuses_links_that_are_not_http() {
        let (out, _) = fetch("file:///etc/passwd", &temp_dir("scheme"), &settings(1)).await;
        assert!(out.unwrap_err().contains("http"));
    }

    #[test]
    fn reads_names_from_content_disposition() {
        assert_eq!(name_from_disposition("attachment; filename=\"a b.zip\""), Some("a b.zip".into()));
        assert_eq!(
            name_from_disposition("attachment; filename=\"x.zip\"; filename*=UTF-8''%E2%82%AC%20rates.zip"),
            Some("€ rates.zip".into())
        );
        assert_eq!(name_from_disposition("inline"), None);
    }

    #[test]
    fn sanitizes_hostile_names() {
        assert_eq!(sanitize_file_name("../../etc/passwd"), "_.._etc_passwd");
        assert_eq!(sanitize_file_name("..."), "download");
        assert_eq!(sanitize_file_name("a:b*c?.mp4"), "a_b_c_.mp4");
        assert!(sanitize_file_name(&"é".repeat(200)).len() <= 180);
    }

    #[test]
    fn reads_the_total_from_content_range() {
        assert_eq!(total_from_content_range("bytes 0-0/12345"), Some(12345));
        assert_eq!(total_from_content_range("bytes 0-0/*"), None);
    }
}
