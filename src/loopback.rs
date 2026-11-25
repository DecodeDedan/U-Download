//! A small HTTP/1.1 file server on 127.0.0.1, used by `--self-test` and the
//! engine tests to download a real file over real sockets without touching
//! the internet.
//!
//! It can cap each connection's speed, the way most CDNs do, which is what
//! lets a test show that more connections really means a faster download.

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Debug, Clone)]
pub struct ServeOptions {
    pub size: u64,
    /// Bytes per second per connection; 0 means as fast as the socket goes.
    pub per_connection_bps: u64,
    /// Whether `Range` requests are honoured (otherwise always 200, full body).
    pub ranges: bool,
    /// Answer the first N requests with 503, to exercise retries.
    pub fail_first: u32,
    pub file_name: String,
}

impl Default for ServeOptions {
    fn default() -> Self {
        ServeOptions {
            size: 8 * 1024 * 1024,
            per_connection_bps: 0,
            ranges: true,
            fail_first: 0,
            file_name: "sample.bin".to_string(),
        }
    }
}

/// The byte the server sends at offset `i`, so a client can verify every byte
/// of what it wrote without the test holding a copy of the file.
pub fn byte_at(i: u64) -> u8 {
    ((i.wrapping_mul(31).wrapping_add(7)) % 251) as u8
}

pub struct Loopback {
    pub url: String,
    pub requests: Arc<AtomicU32>,
    pub peak_connections: Arc<AtomicU32>,
    stop: Arc<AtomicBool>,
}

impl Drop for Loopback {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

pub fn serve(opts: ServeOptions) -> std::io::Result<Loopback> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    listener.set_nonblocking(true)?;
    let port = listener.local_addr()?.port();
    let stop = Arc::new(AtomicBool::new(false));
    let requests = Arc::new(AtomicU32::new(0));
    let open = Arc::new(AtomicU32::new(0));
    let peak = Arc::new(AtomicU32::new(0));
    let file_name = opts.file_name.clone();

    {
        let (stop, requests, open, peak) = (stop.clone(), requests.clone(), open.clone(), peak.clone());
        std::thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let n = requests.fetch_add(1, Ordering::Relaxed);
                        let now_open = open.fetch_add(1, Ordering::Relaxed) + 1;
                        peak.fetch_max(now_open, Ordering::Relaxed);
                        let (opts, open) = (opts.clone(), open.clone());
                        std::thread::spawn(move || {
                            match answer(stream, &opts, n < opts.fail_first) {
                                Ok(()) => {}
                                // A client that stops reading early is normal:
                                // the engine drops a range once a steal shortens it.
                                Err(e) if matches!(
                                    e.kind(),
                                    std::io::ErrorKind::BrokenPipe
                                        | std::io::ErrorKind::ConnectionReset
                                        | std::io::ErrorKind::ConnectionAborted
                                ) => {}
                                Err(e) => eprintln!("loopback: connection failed: {e}"),
                            }
                            open.fetch_sub(1, Ordering::Relaxed);
                        });
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(2));
                    }
                    Err(e) => {
                        eprintln!("loopback: accept failed: {e}");
                        std::thread::sleep(Duration::from_millis(20));
                    }
                }
            }
        });
    }

    Ok(Loopback {
        // Every path serves the same file; the name is in the path so the
        // link reads as a direct file, and again in Content-Disposition.
        url: format!("http://127.0.0.1:{port}/files/{file_name}"),
        requests,
        peak_connections: peak,
        stop,
    })
}

/// `bytes=a-b` or `bytes=a-`, clamped to the file.
fn parse_range(value: &str, size: u64) -> Option<(u64, u64)> {
    let spec = value.trim().strip_prefix("bytes=")?;
    let (a, b) = spec.split_once('-')?;
    let start: u64 = a.trim().parse().ok()?;
    let end: u64 = if b.trim().is_empty() { size.checked_sub(1)? } else { b.trim().parse().ok()? };
    (start <= end && start < size).then(|| (start, end.min(size - 1)))
}

fn answer(stream: TcpStream, opts: &ServeOptions, fail: bool) -> std::io::Result<()> {
    stream.set_nonblocking(false)?;
    stream.set_write_timeout(Some(Duration::from_secs(10)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut range = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 || line == "\r\n" || line == "\n" {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("range") {
                range = parse_range(value, opts.size);
            }
        }
    }

    let mut out = stream;
    if fail {
        out.write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")?;
        return Ok(());
    }

    let (status, start, end) = match (opts.ranges, range) {
        (true, Some((a, b))) => ("206 Partial Content", a, b),
        _ => ("200 OK", 0, opts.size.saturating_sub(1)),
    };
    let length = if opts.size == 0 { 0 } else { end - start + 1 };
    let mut head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/octet-stream\r\nContent-Length: {length}\r\n\
         Content-Disposition: attachment; filename=\"{}\"\r\nConnection: close\r\n",
        opts.file_name
    );
    if opts.ranges {
        head.push_str("Accept-Ranges: bytes\r\n");
        if status.starts_with("206") {
            head.push_str(&format!("Content-Range: bytes {start}-{end}/{}\r\n", opts.size));
        }
    }
    head.push_str("\r\n");
    out.write_all(head.as_bytes())?;

    const CHUNK: u64 = 16 * 1024;
    let began = Instant::now();
    let mut sent = 0u64;
    let mut buf = vec![0u8; CHUNK as usize];
    while sent < length {
        let n = CHUNK.min(length - sent);
        for (k, slot) in buf.iter_mut().take(n as usize).enumerate() {
            *slot = byte_at(start + sent + k as u64);
        }
        out.write_all(&buf[..n as usize])?;
        sent += n;
        if opts.per_connection_bps > 0 {
            let due = Duration::from_secs_f64(sent as f64 / opts.per_connection_bps as f64);
            if let Some(wait) = due.checked_sub(began.elapsed()) {
                std::thread::sleep(wait);
            }
        }
    }
    out.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_closed_and_open_ranges() {
        assert_eq!(parse_range("bytes=0-0", 10), Some((0, 0)));
        assert_eq!(parse_range("bytes=4-", 10), Some((4, 9)));
        assert_eq!(parse_range("bytes=4-99", 10), Some((4, 9)));
        assert_eq!(parse_range("bytes=10-", 10), None);
        assert_eq!(parse_range("items=0-1", 10), None);
    }
}
