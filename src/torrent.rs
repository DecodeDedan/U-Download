//! Torrents, magnets and FTP, run through the bundled aria2c (Motrix's
//! engine). The runner spawns it like yt-dlp and reads the same `[#...]`
//! console readout through `ytdlp::parse_progress_line`.

/// Arguments for one aria2c job saving into `folder`.
///
/// `--seed-time=0` stops as soon as the files are complete: U-Download is a
/// downloader, and seeding indefinitely from a laptop or phone was never asked
/// for. DHT, peer exchange and local peer discovery stay on, which is what
/// makes magnets with no tracker resolve at all.
pub fn build_args(uri: &str, folder: &str, ca_bundle: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = [
        "--seed-time=0",
        "--bt-save-metadata=false",
        "--follow-torrent=mem",
        "--enable-dht=true",
        "--bt-enable-lpd=true",
        "--enable-peer-exchange=true",
        "--bt-max-peers=128",
        "--split=16",
        "--max-connection-per-server=16",
        "--min-split-size=1M",
        "--file-allocation=none",
        "--continue=true",
        "--auto-file-renaming=true",
        "--summary-interval=1",
        "--show-console-readout=true",
        "--console-log-level=warn",
        "--download-result=default",
        "--max-tries=5",
        "--retry-wait=5",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    args.push(format!("--dir={folder}"));
    if let Some(ca) = ca_bundle {
        args.push(format!("--ca-certificate={ca}"));
    }
    // `--` so a link can never be read as an option.
    args.push("--".into());
    args.push(uri.to_string());
    args
}

/// aria2c's result table names each finished file as
/// `bba73d|OK  |   1.2MiB/s|/path/to/file`; the path is the last column.
pub fn completed_path(line: &str) -> Option<String> {
    let mut cols = line.split('|');
    let _gid = cols.next()?;
    let status = cols.next()?.trim();
    if status != "OK" {
        return None;
    }
    let path = cols.next_back()?.trim();
    (path.starts_with('/') || path.contains(":\\")).then(|| path.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stops_seeding_and_saves_into_the_folder() {
        let args = build_args("magnet:?xt=urn:btih:abc", "/out", Some("/ca.pem"));
        assert!(args.contains(&"--seed-time=0".to_string()));
        assert!(args.contains(&"--dir=/out".to_string()));
        assert!(args.contains(&"--ca-certificate=/ca.pem".to_string()));
        assert_eq!(args[args.len() - 2], "--");
        assert_eq!(args.last().unwrap(), "magnet:?xt=urn:btih:abc");
    }

    #[test]
    fn a_link_that_looks_like_an_option_stays_a_link() {
        let args = build_args("--on-download-complete=/bin/sh", "/out", None);
        let dash = args.iter().position(|a| a == "--").unwrap();
        assert_eq!(args[dash + 1], "--on-download-complete=/bin/sh");
    }

    #[test]
    fn reads_finished_files_from_the_result_table() {
        assert_eq!(
            completed_path("bba73d|OK  |   1.2MiB/s|/Users/me/Downloads/debian.iso"),
            Some("/Users/me/Downloads/debian.iso".into())
        );
        assert_eq!(completed_path("bba73d|ERR |       0B/s|/x/y"), None);
        assert_eq!(completed_path("gid   |stat|avg speed  |path/URI"), None);
    }
}
