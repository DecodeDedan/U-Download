/**
 * The person's choices, kept in localStorage under one key.
 *
 * Everything read back is checked against the defaults' shape: a value from
 * an older build, or one edited by hand, falls back to the default instead of
 * reaching the engine.
 */

const KEY = "udl.settings";

export const BROWSERS = ["chrome", "chromium", "firefox", "safari", "edge", "brave", "opera", "vivaldi"];
export const AUDIO_FORMATS = ["mp3", "m4a", "opus", "flac", "wav"];
export const QUALITIES = ["best", "2160", "1440", "1080", "720", "480", "360"];
export const MAX_CONNECTIONS = 64;
export const MAX_CONCURRENCY = 5;

export const DEFAULT_SETTINGS = Object.freeze({
  theme: "dark",
  concurrency: 3,
  connections: 16,
  speedLimitKbps: 0,
  outputFolder: "",
  mediaKind: "mp4",
  quality: "best",
  sound: true,
  options: Object.freeze({
    no_watermark: true,
    subtitles: false,
    subtitle_langs: "en.*",
    embed_metadata: true,
    embed_thumbnail: true,
    sponsorblock: false,
    cookies_browser: null,
    audio_format: "mp3",
  }),
});

const intIn = (value, min, max, fallback) =>
  Number.isInteger(value) && value >= min && value <= max ? value : fallback;
const oneOf = (value, list, fallback) => (list.includes(value) ? value : fallback);
const bool = (value, fallback) => (typeof value === "boolean" ? value : fallback);

/** @param {unknown} raw */
export function sanitizeSettings(raw) {
  const d = DEFAULT_SETTINGS;
  const s = raw && typeof raw === "object" ? raw : {};
  const o = s.options && typeof s.options === "object" ? s.options : {};
  const langs = typeof o.subtitle_langs === "string" && /^[A-Za-z0-9.*,_-]{1,64}$/.test(o.subtitle_langs)
    ? o.subtitle_langs
    : d.options.subtitle_langs;
  return {
    theme: oneOf(s.theme, ["dark", "light"], d.theme),
    concurrency: intIn(s.concurrency, 1, MAX_CONCURRENCY, d.concurrency),
    connections: intIn(s.connections, 1, MAX_CONNECTIONS, d.connections),
    speedLimitKbps: intIn(s.speedLimitKbps, 0, 10 * 1024 * 1024, d.speedLimitKbps),
    // A self-test's scratch folder must never become the person's folder.
    outputFolder: typeof s.outputFolder === "string" && !s.outputFolder.includes("udl-selftest-")
      ? s.outputFolder
      : d.outputFolder,
    mediaKind: oneOf(s.mediaKind, ["mp4", "mp3"], d.mediaKind),
    quality: oneOf(s.quality, QUALITIES, d.quality),
    sound: bool(s.sound, d.sound),
    options: {
      no_watermark: bool(o.no_watermark, d.options.no_watermark),
      subtitles: bool(o.subtitles, d.options.subtitles),
      subtitle_langs: langs,
      embed_metadata: bool(o.embed_metadata, d.options.embed_metadata),
      embed_thumbnail: bool(o.embed_thumbnail, d.options.embed_thumbnail),
      sponsorblock: bool(o.sponsorblock, d.options.sponsorblock),
      cookies_browser: oneOf(o.cookies_browser, BROWSERS, null),
      audio_format: oneOf(o.audio_format, AUDIO_FORMATS, d.options.audio_format),
    },
  };
}

export function loadSettings() {
  try {
    return sanitizeSettings(JSON.parse(localStorage.getItem(KEY) || "null"));
  } catch {
    return sanitizeSettings(null);
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch (error) {
    console.error("Could not save settings:", error);
  }
}

/** The `format` argument `enqueue_job` expects. */
export function formatChoice(mediaKind, quality, exactFormatId) {
  if (exactFormatId) return { mode: "exact", format_id: exactFormatId };
  if (mediaKind === "mp3") return { mode: "quick", kind: "mp3", height: null };
  return { mode: "quick", kind: "mp4", height: quality === "best" ? null : Number(quality) };
}
