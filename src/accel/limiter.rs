//! One speed limit shared by every connection of every download.
//!
//! A token bucket in "debt" form: each chunk is paid for after it arrives, and
//! a connection that overdraws sleeps the deficit off. That keeps the long-run
//! rate at the limit without ever splitting a chunk the server already sent.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub struct Limiter {
    /// Bytes per second; 0 means unlimited.
    rate: AtomicU64,
    bucket: Mutex<Bucket>,
}

struct Bucket {
    tokens: f64,
    refilled: Instant,
}

impl Limiter {
    pub fn new(rate: u64) -> Self {
        Limiter {
            rate: AtomicU64::new(rate),
            bucket: Mutex::new(Bucket { tokens: rate as f64, refilled: Instant::now() }),
        }
    }

    pub fn set_rate(&self, rate: u64) {
        self.rate.store(rate, Ordering::Relaxed);
    }

    pub fn rate(&self) -> u64 {
        self.rate.load(Ordering::Relaxed)
    }

    /// How long the caller must wait after receiving `bytes`.
    fn charge(&self, bytes: u64) -> Duration {
        let rate = self.rate();
        if rate == 0 {
            return Duration::ZERO;
        }
        let rate = rate as f64;
        // Lock scope: arithmetic only; the sleep happens after it is released.
        let mut bucket = self.bucket.lock().unwrap_or_else(|p| p.into_inner());
        let now = Instant::now();
        let elapsed = now.duration_since(bucket.refilled).as_secs_f64();
        // One second of burst, so a limit change takes effect within a second.
        bucket.tokens = (bucket.tokens + elapsed * rate).min(rate);
        bucket.refilled = now;
        bucket.tokens -= bytes as f64;
        if bucket.tokens >= 0.0 {
            Duration::ZERO
        } else {
            Duration::from_secs_f64(-bucket.tokens / rate)
        }
    }

    pub async fn pay(&self, bytes: u64) {
        let wait = self.charge(bytes);
        if !wait.is_zero() {
            tokio::time::sleep(wait).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unlimited_never_waits() {
        let limiter = Limiter::new(0);
        assert_eq!(limiter.charge(u64::MAX / 2), Duration::ZERO);
    }

    #[test]
    fn the_first_second_of_traffic_is_free_and_the_rest_is_paced() {
        let limiter = Limiter::new(1000);
        assert_eq!(limiter.charge(1000), Duration::ZERO);
        let wait = limiter.charge(500);
        assert!(
            wait >= Duration::from_millis(490) && wait <= Duration::from_millis(510),
            "{wait:?}"
        );
    }

    #[tokio::test]
    async fn holds_throughput_near_the_limit() {
        let limiter = Limiter::new(200_000);
        let started = Instant::now();
        for _ in 0..10 {
            limiter.pay(40_000).await;
        }
        // 400 kB at 200 kB/s with a 200 kB burst: about one second.
        let took = started.elapsed();
        assert!(took >= Duration::from_millis(900), "{took:?}");
        assert!(took < Duration::from_millis(1600), "{took:?}");
    }
}
