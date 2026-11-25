import { useLayoutEffect, useRef } from "react";
import TrimWorkbench from "./TrimWorkbench";
import LinkPreview, { formatLabel, pickFormats } from "./LinkPreview";
import { IconDownload, IconScissors } from "./icons";
import { QUALITIES } from "../lib/settings";
import { formatTime } from "../lib/time";
import { powerOn, rise } from "../lib/motion";

const QUALITY_LABELS = { best: "Best", 2160: "4K", 1440: "1440p", 1080: "1080p", 720: "720p", 480: "480p", 360: "360p" };

/**
 * U-Download's studio: the moment a video link is pasted, the real video
 * plays here at full size with its trim handles, beside everything that
 * decides what gets saved. Preview and trim are what set U-Download apart,
 * so they are the largest thing on screen, not an option behind a button.
 */
export default function Studio({
  url,
  preview,
  selection,
  onSelection,
  mediaKind,
  quality,
  onMediaKind,
  onQuality,
  trim,
  onTrim,
  busy,
  onDownload,
}) {
  const rootRef = useRef(null);
  const info = preview?.info;
  const isPlaylist = Boolean(info?.is_playlist);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const tweens = [
      powerOn(root.querySelector(".studio__stage")),
      rise(root.querySelectorAll(".studio__panel > *"), { delay: 0.12, stagger: 0.05 }),
    ];
    return () => tweens.forEach((t) => t?.kill());
  }, [url, isPlaylist]);

  if (isPlaylist) {
    return (
      <section className="studio studio--playlist" ref={rootRef} aria-label="Playlist">
        <div className="studio__panel studio__panel--wide">
          <LinkPreview state={preview} selection={selection} onSelection={onSelection} />
          <SaveOptions mediaKind={mediaKind} quality={quality} onMediaKind={onMediaKind} onQuality={onQuality} />
          <button type="button" className="btn btn-primary studio__go" onClick={onDownload} disabled={busy} aria-busy={busy}>
            <IconDownload size={20} />
            <span>{busy ? "Adding…" : "Download playlist"}</span>
          </button>
        </div>
      </section>
    );
  }

  const formats = pickFormats(info?.formats || []);
  const cleanFound = (info?.formats || []).some((f) => f.watermarked);
  const span = trim ? trim.end - trim.start : null;
  const action = trim ? "Download clip" : mediaKind === "mp3" ? "Download audio" : "Download video";

  return (
    <section className="studio" ref={rootRef} aria-label="Preview and trim">
      <div className="studio__stage">
        <TrimWorkbench url={url} onChange={onTrim} />
      </div>
      <aside className="studio__panel">
        <div className="studio__head">
          {preview?.loading && (
            <div className="preview__lines" aria-busy="true">
              <span className="field-label">Reading the link…</span>
              <span className="skeleton skeleton--line" />
              <span className="skeleton skeleton--line skeleton--short" />
            </div>
          )}
          {info && (
            <>
              {info.site && <span className="chip chip--media studio__site">{info.site}</span>}
              <h2 className="studio__title">{info.title || "Untitled"}</h2>
              <p className="preview__meta">
                {[info.uploader, info.duration ? formatTime(info.duration) : null].filter(Boolean).join(" · ")}
              </p>
            </>
          )}
          {preview?.error && (
            <p className="notice notice--warning" role="status">
              Could not read the details ({preview.error}). The download will still try.
            </p>
          )}
          {cleanFound && <p className="preview__note">Watermarked copies found — the clean one is used.</p>}
        </div>

        <SaveOptions mediaKind={mediaKind} quality={quality} onMediaKind={onMediaKind} onQuality={onQuality} />

        {mediaKind === "mp4" && formats.length > 0 && (
          <label className="studio__field">
            <span className="field-label">Exact format</span>
            <select
              className="select"
              value={selection.formatId || ""}
              onChange={(e) => onSelection({ ...selection, formatId: e.target.value || null })}
            >
              <option value="">Automatic (quality above)</option>
              {formats.map((f) => <option key={f.format_id} value={f.format_id}>{formatLabel(f)}</option>)}
            </select>
          </label>
        )}

        <div className={`studio__trim ${trim ? "studio__trim--set" : ""}`}>
          <IconScissors size={18} />
          <div className="studio__trim-text">
            <span className="field-label">Trim</span>
            {trim ? (
              <span className="num">{`${formatTime(trim.start)} → ${formatTime(trim.end)} · ${formatTime(span)}`}</span>
            ) : (
              <span>Whole video. Set In and Out under the picture to cut a clip.</span>
            )}
          </div>
        </div>

        <button
          type="button"
          className="btn btn-primary studio__go"
          onClick={onDownload}
          disabled={busy}
          aria-busy={busy}
          data-testid="studio-go"
        >
          <IconDownload size={20} />
          <span>{busy ? "Adding…" : action}</span>
        </button>
      </aside>
    </section>
  );
}

function SaveOptions({ mediaKind, quality, onMediaKind, onQuality }) {
  return (
    <div className="studio__options">
      <div className="segmented segmented--lg" role="radiogroup" aria-label="Save as">
        {[["mp4", "Video"], ["mp3", "Audio"]].map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={mediaKind === id}
            className="segmented__opt"
            onClick={() => onMediaKind(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {mediaKind === "mp4" && (
        <label className="inline-field">
          <span className="field-label">Quality</span>
          <select className="select" value={quality} onChange={(e) => onQuality(e.target.value)}>
            {QUALITIES.map((q) => <option key={q} value={q}>{QUALITY_LABELS[q]}</option>)}
          </select>
        </label>
      )}
    </div>
  );
}
