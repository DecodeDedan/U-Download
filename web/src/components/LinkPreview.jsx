import { formatTime } from "../lib/time";
import { formatBytes } from "./ThroughputCore";

/** Selected 1-based item numbers as yt-dlp's `-I` spec: [1,2,3,7] → "1-3,7". */
export function itemsSpec(numbers) {
  const sorted = [...new Set(numbers)].filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b);
  const parts = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j += 1;
    parts.push(i === j ? `${sorted[i]}` : `${sorted[i]}-${sorted[j]}`);
    i = j + 1;
  }
  return parts.join(",");
}

const MAX_FORMATS = 12;

/** Distinct video heights, best first, plus the best audio-only stream. */
export function pickFormats(formats) {
  const seen = new Set();
  const video = formats
    .filter((f) => f.vcodec && f.vcodec !== "none" && f.height)
    .sort((a, b) => (b.height - a.height) || ((b.filesize || 0) - (a.filesize || 0)))
    .filter((f) => {
      const key = `${f.height}-${f.watermarked}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return video.slice(0, MAX_FORMATS);
}

function shortSide(f) {
  return f.width && f.height ? Math.min(f.width, f.height) : f.height;
}

/** "720p60 mp4 · 12.4 MB · watermarked" */
export function formatLabel(f) {
  return `${shortSide(f)}p${f.fps && f.fps > 30 ? Math.round(f.fps) : ""} ${f.ext}`
    + (f.filesize ? ` · ${formatBytes(f.filesize)}` : "")
    + (f.watermarked ? " · watermarked" : "");
}

export default function LinkPreview({ state, selection, onSelection }) {
  if (!state) return null;
  if (state.loading) {
    return (
      <div className="preview preview--loading" aria-busy="true" aria-live="polite">
        <div className="preview__thumb skeleton" />
        <div className="preview__lines">
          <span className="skeleton skeleton--line" />
          <span className="skeleton skeleton--line skeleton--short" />
        </div>
        <span className="sr-only">Reading the link…</span>
      </div>
    );
  }
  if (state.error) {
    return (
      <p className="notice notice--warning" role="status">
        Could not read this link ahead of time ({state.error}). You can still download it; the engine will try again.
      </p>
    );
  }
  const info = state.info;
  if (!info || info.kind !== "media") return null;

  if (info.is_playlist) {
    const chosen = new Set(selection.items ?? info.entries.map((_, i) => i + 1));
    const toggle = (n) => {
      const next = new Set(chosen);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      onSelection({ ...selection, items: [...next] });
    };
    const all = chosen.size === info.entries.length;
    return (
      <div className="preview preview--playlist">
        <div className="preview__lines">
          <p className="preview__title">{info.title || "Playlist"}</p>
          <p className="preview__meta">
            <span className="num">{info.entry_count}</span> items
            {info.uploader && <span> · {info.uploader}</span>}
            {info.entry_count > info.entries.length && (
              <span> · showing the first {info.entries.length}</span>
            )}
          </p>
        </div>
        <div className="preview__controls">
          <button
            type="button"
            className="btn btn-sm btn-quiet"
            onClick={() => onSelection({ ...selection, items: all ? [] : info.entries.map((_, i) => i + 1) })}
          >
            {all ? "Select none" : "Select all"}
          </button>
          <span className="preview__meta num">{chosen.size} selected</span>
        </div>
        <ol className="playlist">
          {info.entries.map((entry, i) => (
            <li key={`${i}-${entry.url}`}>
              <label className="playlist__item">
                <input type="checkbox" checked={chosen.has(i + 1)} onChange={() => toggle(i + 1)} />
                <span className="playlist__n num">{i + 1}</span>
                <span className="playlist__title">{entry.title || entry.url || `Item ${i + 1}`}</span>
                {entry.duration ? <span className="num playlist__dur">{formatTime(entry.duration)}</span> : null}
              </label>
            </li>
          ))}
        </ol>
      </div>
    );
  }

  const formats = pickFormats(info.formats || []);
  const anyWatermarked = (info.formats || []).some((f) => f.watermarked);
  return (
    <div className="preview">
      {info.thumbnail ? (
        <img className="preview__thumb" src={info.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" />
      ) : (
        <div className="preview__thumb preview__thumb--blank" aria-hidden="true" />
      )}
      <div className="preview__lines">
        <p className="preview__title">{info.title || "Untitled"}</p>
        <p className="preview__meta">
          {[info.site, info.uploader, info.duration ? formatTime(info.duration) : null].filter(Boolean).join(" · ")}
        </p>
        {anyWatermarked && (
          <p className="preview__note">Watermarked copies found; U-Download picks the clean one.</p>
        )}
      </div>
      {formats.length > 0 && (
        <label className="preview__format">
          <span className="field-label">Format</span>
          <select
            className="select"
            value={selection.formatId || ""}
            onChange={(e) => onSelection({ ...selection, formatId: e.target.value || null })}
          >
            <option value="">Automatic (uses quality setting)</option>
            {formats.map((f) => (
              <option key={f.format_id} value={f.format_id}>{formatLabel(f)}</option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
