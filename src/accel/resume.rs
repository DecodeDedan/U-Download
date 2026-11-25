//! The `.udl` file beside a partial download, which lets a paused or
//! interrupted download carry on from the bytes it already has.
//!
//! Shape: `{"url": "...", "total": 1048576, "segments": [{"start": 0,
//! "end": 524287, "pos": 1024}, ...]}`. It is written only after the partial
//! file has been flushed, so it never claims bytes that are not on disk.

use super::plan::{Plan, Segment};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize, Deserialize)]
struct ResumeFile {
    url: String,
    total: u64,
    segments: Vec<Segment>,
}

pub fn sidecar_for(part: &Path) -> PathBuf {
    let mut name = part.as_os_str().to_owned();
    name.push(".udl");
    PathBuf::from(name)
}

/// The saved plan, if it is for this URL and this exact size. Anything else
/// (missing, corrupt, a different file) means start from zero.
pub fn load(sidecar: &Path, url: &str, total: u64) -> Option<Plan> {
    let text = std::fs::read_to_string(sidecar).ok()?;
    let saved: ResumeFile = serde_json::from_str(&text).ok()?;
    if saved.url != url || saved.total != total {
        return None;
    }
    Plan::restored(total, saved.segments)
}

/// Writes the plan atomically: a crash mid-write leaves the previous one.
pub fn save(sidecar: &Path, url: &str, plan: &Plan) -> std::io::Result<()> {
    let body = ResumeFile { url: url.to_string(), total: plan.total, segments: plan.segments.clone() };
    let json = serde_json::to_vec(&body).map_err(std::io::Error::other)?;
    let tmp = sidecar.with_extension("udl.tmp");
    std::fs::write(&tmp, json)?;
    std::fs::rename(tmp, sidecar)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("udl-resume-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn round_trips_a_partly_written_plan() {
        let dir = temp_dir("roundtrip");
        let sidecar = sidecar_for(&dir.join("f.part"));
        let mut plan = Plan::new(4096, 4, 1024);
        let i = plan.claim(1024).unwrap();
        plan.advance(i, 0, 100);
        save(&sidecar, "https://x/f", &plan).unwrap();

        let loaded = load(&sidecar, "https://x/f", 4096).unwrap();
        assert_eq!(loaded.segments, plan.segments);
        assert_eq!(loaded.written(), 100);
    }

    #[test]
    fn refuses_a_plan_for_another_url_or_size() {
        let dir = temp_dir("mismatch");
        let sidecar = sidecar_for(&dir.join("f.part"));
        save(&sidecar, "https://x/f", &Plan::new(4096, 4, 1024)).unwrap();
        assert!(load(&sidecar, "https://x/other", 4096).is_none());
        assert!(load(&sidecar, "https://x/f", 4097).is_none());
    }

    #[test]
    fn treats_a_corrupt_file_as_no_resume() {
        let dir = temp_dir("corrupt");
        let sidecar = sidecar_for(&dir.join("f.part"));
        std::fs::write(&sidecar, b"{not json").unwrap();
        assert!(load(&sidecar, "https://x/f", 10).is_none());
    }
}
