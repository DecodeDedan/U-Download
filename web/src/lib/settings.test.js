import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, formatChoice, sanitizeSettings } from "./settings";
import { itemsSpec, pickFormats } from "../components/LinkPreview";

describe("sanitizeSettings", () => {
  it("returns the defaults for nothing saved", () => {
    expect(sanitizeSettings(null)).toEqual(sanitizeSettings(DEFAULT_SETTINGS));
  });

  it("refuses out-of-range and unknown values", () => {
    const s = sanitizeSettings({
      connections: 500,
      concurrency: 0,
      theme: "neon",
      options: { cookies_browser: "netscape", audio_format: "exe", subtitle_langs: "en --exec x" },
    });
    expect(s.connections).toBe(16);
    expect(s.concurrency).toBe(3);
    expect(s.theme).toBe("dark");
    expect(s.options.cookies_browser).toBeNull();
    expect(s.options.audio_format).toBe("mp3");
    expect(s.options.subtitle_langs).toBe("en.*");
  });

  it("keeps valid choices", () => {
    const s = sanitizeSettings({ connections: 32, speedLimitKbps: 500, options: { cookies_browser: "firefox", no_watermark: false } });
    expect(s.connections).toBe(32);
    expect(s.speedLimitKbps).toBe(500);
    expect(s.options.cookies_browser).toBe("firefox");
    expect(s.options.no_watermark).toBe(false);
  });

  it("never keeps a self-test scratch folder", () => {
    expect(sanitizeSettings({ outputFolder: "/tmp/udl-selftest-123" }).outputFolder).toBe("");
    expect(sanitizeSettings({ outputFolder: "/Users/me/Movies" }).outputFolder).toBe("/Users/me/Movies");
  });
});

describe("formatChoice", () => {
  it("maps the quick choices and an exact format", () => {
    expect(formatChoice("mp4", "720")).toEqual({ mode: "quick", kind: "mp4", height: 720 });
    expect(formatChoice("mp4", "best")).toEqual({ mode: "quick", kind: "mp4", height: null });
    expect(formatChoice("mp3", "720")).toEqual({ mode: "quick", kind: "mp3", height: null });
    expect(formatChoice("mp4", "720", "137")).toEqual({ mode: "exact", format_id: "137" });
  });
});

describe("itemsSpec", () => {
  it("compresses runs into ranges", () => {
    expect(itemsSpec([7, 1, 2, 3])).toBe("1-3,7");
    expect(itemsSpec([5])).toBe("5");
    expect(itemsSpec([])).toBe("");
    expect(itemsSpec([2, 2, 0, -1])).toBe("2");
  });
});

describe("pickFormats", () => {
  it("keeps one entry per height, best first", () => {
    const picked = pickFormats([
      { format_id: "a", vcodec: "avc1", height: 720, filesize: 10 },
      { format_id: "b", vcodec: "avc1", height: 1080 },
      { format_id: "c", vcodec: "avc1", height: 720, filesize: 20 },
      { format_id: "d", vcodec: "none", acodec: "mp4a" },
    ]);
    expect(picked.map((f) => f.format_id)).toEqual(["b", "c"]);
  });
});
