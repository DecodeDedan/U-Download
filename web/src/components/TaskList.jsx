import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { formatEta, formatSpeed } from "../lib/format";
import { formatBytes } from "./ThroughputCore";
import { flash, slideIn } from "../lib/motion";
import {
  IconClose,
  IconFile,
  IconFolder,
  IconMagnet,
  IconPause,
  IconPlay,
  IconRetry,
  IconVideo,
} from "./icons";

const ACTIVE = ["queued", "probing", "downloading", "processing", "paused"];
const FILTERS = [
  { id: "active", label: "Active", match: (j) => ACTIVE.includes(j.status) },
  { id: "done", label: "Done", match: (j) => j.status === "done" },
  { id: "stopped", label: "Stopped", match: (j) => j.status === "failed" || j.status === "cancelled" },
];

const STATUS_WORDS = {
  queued: "Waiting",
  probing: "Starting",
  downloading: "Downloading",
  processing: "Finishing",
  paused: "Paused",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

const KIND = {
  media: { label: "Video", Icon: IconVideo },
  file: { label: "File", Icon: IconFile },
  torrent: { label: "Torrent", Icon: IconMagnet },
  search: { label: "Video", Icon: IconVideo },
};

function host(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.startsWith("magnet:") ? "magnet link" : "";
  }
}

function PieceMap({ pieces }) {
  return (
    <div className="pieces" aria-hidden="true">
      {pieces.map((p, i) => (
        <span
          // Cells are positional: cell i is always the same slice of the file.
          // eslint-disable-next-line react/no-array-index-key
          key={i}
          className="pieces__cell"
          style={{ "--fill": p / 100 }}
        />
      ))}
    </div>
  );
}

function TaskRow({ job, onPause, onResume, onCancel, onRetry }) {
  const p = job.progress || {};
  const kind = KIND[job.kind] || KIND.media;
  const status = STATUS_WORDS[job.status] || job.status;
  const live = job.status === "downloading" || job.status === "processing";
  const speed = live ? formatSpeed(p.speed_bytes_per_sec) : null;
  const eta = live ? formatEta(p.eta_seconds) : null;
  const pct = Math.max(0, Math.min(100, Number(p.percentage) || 0));
  const size = p.total_bytes > 0 ? formatBytes(p.total_bytes) : null;
  const title = job.title || job.url;
  const hasPieces = Array.isArray(p.pieces) && p.pieces.length > 0;
  const keepsBytes = job.kind === "file";
  const rowRef = useRef(null);
  const flashRef = useRef(null);
  const previous = useRef(job.status);

  useLayoutEffect(() => {
    const t = slideIn(rowRef.current);
    return () => t?.kill();
  }, []);
  useEffect(() => {
    if (job.status === "done" && previous.current !== "done") flash(flashRef.current);
    previous.current = job.status;
  }, [job.status]);

  const reveal = async () => {
    try {
      await revealItemInDir(job.output_path);
    } catch (error) {
      console.error("Could not show the file:", error);
    }
  };

  return (
    <li ref={rowRef} className={`task task--${job.status}`} data-testid="task" data-status={job.status}>
      <span className="task__flash" ref={flashRef} aria-hidden="true" />
      <div className="task__kind" title={kind.label}>
        <kind.Icon size={18} />
        <span className="task__kind-label">{kind.label}</span>
      </div>
      <div className="task__body">
        <p className="task__title" title={title}>{title}</p>
        <p className="task__meta">
          <span className={`badge badge--${job.status}`}>{status}</span>
          {host(job.url) && <span>{host(job.url)}</span>}
          {size && <span className="num">{size}</span>}
          {live && p.connections > 0 && <span className="num">{p.connections} connections</span>}
        </p>
        {job.status === "failed" && job.error && (
          <p className="task__error" role="alert">{job.error}</p>
        )}
        {job.status !== "done" && job.status !== "cancelled" && (
          <div
            className="task__progress"
            role="progressbar"
            aria-label={`${title} progress`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(pct)}
          >
            {hasPieces ? <PieceMap pieces={p.pieces} /> : (
              <div className="bar"><span className="bar__fill" style={{ "--fill": pct / 100 }} /></div>
            )}
          </div>
        )}
      </div>
      <div className="task__numbers num">
        {live && <span className="task__pct">{pct.toFixed(pct < 10 ? 1 : 0)}%</span>}
        {speed && <span className="task__speed">{speed}</span>}
        {eta && <span className="task__eta">{eta}</span>}
      </div>
      <div className="task__actions">
        {(live || job.status === "probing" || job.status === "queued") && (
          <button
            type="button"
            className="icon-btn"
            onClick={() => onPause(job.id)}
            aria-label={keepsBytes ? "Pause" : "Pause (video restarts when resumed)"}
            title={keepsBytes ? "Pause" : "Pause — videos restart when resumed"}
          >
            <IconPause size={18} />
          </button>
        )}
        {job.status === "paused" && (
          <button type="button" className="icon-btn" onClick={() => onResume(job.id)} aria-label="Resume" title="Resume">
            <IconPlay size={18} />
          </button>
        )}
        {(job.status === "failed" || job.status === "cancelled") && (
          <button type="button" className="icon-btn" onClick={() => onRetry(job)} aria-label="Try again" title="Try again">
            <IconRetry size={18} />
          </button>
        )}
        {job.status === "done" && job.output_path && (
          <button type="button" className="icon-btn" onClick={reveal} aria-label="Show in folder" title="Show in folder">
            <IconFolder size={18} />
          </button>
        )}
        {!["done", "failed", "cancelled"].includes(job.status) && (
          <button type="button" className="icon-btn" onClick={() => onCancel(job.id)} aria-label="Cancel" title="Cancel">
            <IconClose size={18} />
          </button>
        )}
      </div>
    </li>
  );
}

export default function TaskList({ jobs, onPause, onResume, onCancel, onRetry, onClearFinished, loadError }) {
  const [filter, setFilter] = useState("active");
  const counts = Object.fromEntries(FILTERS.map((f) => [f.id, jobs.filter(f.match).length]));
  const current = FILTERS.find((f) => f.id === filter) || FILTERS[0];
  const shown = jobs.filter(current.match).slice().reverse();
  const finished = counts.done + counts.stopped;

  return (
    <section className="tasks" aria-labelledby="tasks-heading">
      <header className="tasks__head">
        <h2 id="tasks-heading" className="section-title">Downloads</h2>
        <div className="tabs" role="tablist" aria-label="Show downloads">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={filter === f.id}
              className="tab"
              onClick={() => setFilter(f.id)}
              data-testid={`tab-${f.id}`}
            >
              {f.label}
              <span className="tab__count num">{counts[f.id]}</span>
            </button>
          ))}
        </div>
        {finished > 0 && (
          <button type="button" className="btn btn-sm btn-quiet" onClick={onClearFinished}>
            Clear finished
          </button>
        )}
      </header>
      {loadError && (
        <p className="notice notice--danger" role="alert">
          The download list could not be loaded: {String(loadError)}
        </p>
      )}
      {shown.length === 0 ? (
        <div className="empty">
          <p className="empty__title">
            {filter === "active" ? "Nothing downloading" : filter === "done" ? "No finished downloads yet" : "Nothing stopped"}
          </p>
          <p className="empty__hint">
            {filter === "active"
              ? "Paste a video, file, torrent or magnet link above, or type words to search."
              : "Downloads move here as they end."}
          </p>
        </div>
      ) : (
        <ul className="tasks__list">
          {shown.map((job) => (
            <TaskRow
              key={job.id}
              job={job}
              onPause={onPause}
              onResume={onResume}
              onCancel={onCancel}
              onRetry={onRetry}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
