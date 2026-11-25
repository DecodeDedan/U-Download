//! Decides which engine a pasted link goes to: yt-dlp for media pages,
//! U-Download's own segmented engine for direct files, aria2c for torrents,
//! magnets and FTP, and a search when the text is not a link at all.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum LinkKind {
    /// A page yt-dlp extracts the real stream from.
    #[default]
    Media,
    /// A direct link to a file, fetched over many connections.
    File,
    /// BitTorrent (magnet, .torrent) or FTP, handed to aria2c.
    Torrent,
    /// Plain words: a search, not a download.
    Search,
}

/// Sites whose pages hold media rather than being the media. Matching one
/// sends the link to yt-dlp even when the path looks like a file.
const MEDIA_HOSTS: &[&str] = &[
    "youtube.com", "youtu.be", "youtube-nocookie.com", "tiktok.com", "douyin.com",
    "instagram.com", "facebook.com", "fb.watch", "fb.com", "twitter.com", "x.com",
    "threads.net", "reddit.com", "redd.it", "vimeo.com", "dailymotion.com", "dai.ly",
    "twitch.tv", "soundcloud.com", "bandcamp.com", "bilibili.com", "b23.tv",
    "pinterest.com", "pin.it", "snapchat.com", "linkedin.com", "kuaishou.com",
    "likee.video", "triller.co", "vk.com", "ok.ru", "rumble.com", "kick.com",
    "streamable.com", "9gag.com", "imgur.com", "tumblr.com", "mixcloud.com",
];

/// Extensions that mean "this URL is the file itself".
const FILE_EXTENSIONS: &[&str] = &[
    "zip", "7z", "rar", "tar", "gz", "tgz", "xz", "bz2", "zst", "iso", "img", "dmg",
    "pkg", "exe", "msi", "deb", "rpm", "appimage", "apk", "aab", "ipa", "jar", "bin",
    "pdf", "epub", "mobi", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "csv", "json",
    "mp4", "mkv", "webm", "mov", "avi", "m4v", "ts", "mp3", "m4a", "flac", "wav", "ogg",
    "opus", "aac", "jpg", "jpeg", "png", "gif", "webp", "svg", "psd", "ttf", "otf",
    "gguf", "safetensors", "onnx", "pt", "ckpt", "parquet",
];

fn host_matches(host: &str, wanted: &str) -> bool {
    host == wanted || host.ends_with(&format!(".{wanted}"))
}

pub fn is_media_host(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    MEDIA_HOSTS.iter().any(|h| host_matches(&host, h))
}

fn extension(path: &str) -> Option<String> {
    let last = path.rsplit('/').next()?;
    let (_, ext) = last.rsplit_once('.')?;
    (!ext.is_empty() && ext.len() <= 12).then(|| ext.to_ascii_lowercase())
}

/// Classifies what the person pasted. Never fails: anything that is not a
/// usable link is treated as a search.
pub fn classify(input: &str) -> LinkKind {
    let text = input.trim();
    if text.is_empty() {
        return LinkKind::Search;
    }
    // `get` rather than slicing: a non-ASCII paste must not panic here.
    if text.get(..7).is_some_and(|p| p.eq_ignore_ascii_case("magnet:")) {
        return LinkKind::Torrent;
    }
    let Ok(url) = url::Url::parse(text) else {
        return LinkKind::Search;
    };
    match url.scheme() {
        "ftp" | "sftp" => return LinkKind::Torrent,
        "http" | "https" => {}
        _ => return LinkKind::Search,
    }
    let Some(host) = url.host_str() else {
        return LinkKind::Search;
    };
    if is_media_host(host) {
        return LinkKind::Media;
    }
    match extension(url.path()).as_deref() {
        Some("torrent") => LinkKind::Torrent,
        Some(ext) if FILE_EXTENSIONS.contains(&ext) => LinkKind::File,
        // An ordinary page: yt-dlp's generic extractor finds embedded video,
        // and plays a direct file link through untouched if that is all it is.
        _ => LinkKind::Media,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn social_video_pages_go_to_ytdlp() {
        for link in [
            "https://www.youtube.com/watch?v=abc",
            "https://youtu.be/abc",
            "https://www.tiktok.com/@user/video/123",
            "https://vm.tiktok.com/ZMabc/",
            "https://www.instagram.com/reel/xyz/",
            "https://x.com/user/status/1",
            "https://fb.watch/abc/",
            "https://www.reddit.com/r/videos/comments/abc/",
        ] {
            assert_eq!(classify(link), LinkKind::Media, "{link}");
        }
    }

    #[test]
    fn a_file_on_a_media_site_is_still_media() {
        assert_eq!(classify("https://www.youtube.com/clip.mp4"), LinkKind::Media);
    }

    #[test]
    fn direct_files_go_to_the_segmented_engine() {
        assert_eq!(classify("https://cdn.example.org/ubuntu-24.04.iso"), LinkKind::File);
        assert_eq!(classify("https://example.org/a/b/Report.PDF?sig=1"), LinkKind::File);
        assert_eq!(classify("https://cdn.example.org/clip.mp4"), LinkKind::File);
    }

    #[test]
    fn torrents_magnets_and_ftp_go_to_aria2() {
        assert_eq!(classify("magnet:?xt=urn:btih:abcdef"), LinkKind::Torrent);
        assert_eq!(classify("MAGNET:?xt=urn:btih:abcdef"), LinkKind::Torrent);
        assert_eq!(classify("https://example.org/debian.iso.torrent"), LinkKind::Torrent);
        assert_eq!(classify("ftp://ftp.example.org/pub/file.tar.gz"), LinkKind::Torrent);
    }

    #[test]
    fn words_are_a_search() {
        assert_eq!(classify("lofi hip hop radio"), LinkKind::Search);
        assert_eq!(classify("   "), LinkKind::Search);
        assert_eq!(classify("javascript:alert(1)"), LinkKind::Search);
    }

    #[test]
    fn lookalike_hosts_are_not_trusted_as_media_sites() {
        assert!(!is_media_host("notyoutube.com"));
        assert!(is_media_host("m.youtube.com"));
        assert_eq!(classify("https://youtube.com.evil.org/file.zip"), LinkKind::File);
    }

    #[test]
    fn unknown_pages_try_ytdlp() {
        assert_eq!(classify("https://news.example.org/story/123"), LinkKind::Media);
    }
}
