import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { downloadDir, videoDir } from "@tauri-apps/api/path";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  isPermissionGranted as notifGranted,
  requestPermission as notifRequest,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { useJobs } from "./hooks/useJobs";
import { useAppUpdate } from "./hooks/useAppUpdate";
import { useMobileUpdate } from "./hooks/useMobileUpdate";
import Splash from "./components/Splash";
import CommandBar from "./components/CommandBar";
import { itemsSpec } from "./components/LinkPreview";
import Studio from "./components/Studio";
import ThroughputCore from "./components/ThroughputCore";
import TaskList from "./components/TaskList";
import SearchView from "./components/SearchView";
import SettingsView from "./components/SettingsView";
import { IconDownload, IconSearch, IconSettings } from "./components/icons";
import soundNotifications from "./SoundNotifications";
import { APK_DOWNLOAD_URL } from "./lib/mobileRelease";
import { formatChoice, loadSettings, saveSettings } from "./lib/settings";
import { runSelfTestIfRequested } from "./lib/selftest";
import { rise } from "./lib/motion";

const ENGINE_UPDATE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const CLASSIFY_DELAY_MS = 120;
const INSPECT_DELAY_MS = 650;
const NOTICE_MS = 4000;
const LIVE = ["downloading", "processing"];
const WORKING = ["queued", "probing", "downloading", "processing"];
const isAndroid = typeof navigator !== "undefined" && /android/i.test(navigator.userAgent);

const isHttpUrl = (value) => {
  try {
    const u = new URL(String(value).trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
};

function notify(title, body) {
  try {
    sendNotification({ title, body });
  } catch (error) {
    console.error("Notification failed:", error);
  }
}

const firstLine = (error) => String(error).split("\n")[0].slice(0, 240);

const NAV = [
  { id: "downloads", label: "Downloads", Icon: IconDownload },
  { id: "search", label: "Search", Icon: IconSearch },
  { id: "settings", label: "Settings", Icon: IconSettings },
];

export default function App() {
  const [showSplash, setShowSplash] = useState(isAndroid);
  const [settings, setSettings] = useState(loadSettings);
  const [view, setView] = useState("downloads");
  const [text, setText] = useState("");
  const [kind, setKind] = useState("search");
  const [preview, setPreview] = useState(null);
  const [selection, setSelection] = useState({ formatId: null, items: null });
  const [trim, setTrim] = useState(null);
  const [pulseKey, setPulseKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [engineError, setEngineError] = useState(null);
  const [engineReport, setEngineReport] = useState("");
  const [appVersion, setAppVersion] = useState("");
  const [search, setSearch] = useState({ status: "idle", hits: [], query: "", error: "" });
  const [searchSource, setSearchSource] = useState("youtube");
  const soundRef = useRef(settings.sound);
  soundRef.current = settings.sound;

  const onDone = useCallback(({ title, output_path }) => {
    setPulseKey((k) => k + 1);
    if (soundRef.current) soundNotifications.playDownloadComplete();
    notify("Download complete", title || output_path || "Your download is ready.");
  }, []);
  const { jobs, error: jobsError, enqueue, cancel, pause, resume, clearFinished } = useJobs({ onDone });

  // Settings: saved, applied to the document, and handed to the engines.
  useEffect(() => {
    saveSettings(settings);
    document.documentElement.setAttribute("data-theme", settings.theme);
    localStorage.setItem("isDarkMode", JSON.stringify(settings.theme === "dark"));
  }, [settings]);
  useEffect(() => {
    invoke("set_engine_settings", {
      connections: settings.connections,
      speedLimitKbps: settings.speedLimitKbps,
      cookiesBrowser: isAndroid ? null : settings.options.cookies_browser,
    }).catch((error) => console.error("Engine settings were refused:", error));
  }, [settings.connections, settings.speedLimitKbps, settings.options.cookies_browser]);

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => setAppVersion("dev"));
  }, []);

  // First failure of each job: one chime and one notification.
  const seenStatus = useRef({});
  useEffect(() => {
    for (const job of jobs) {
      if (job.status === "failed" && seenStatus.current[job.id] !== "failed") {
        if (soundRef.current) soundNotifications.playDownloadError();
        notify("Download failed", job.error || job.title || job.url);
      }
      seenStatus.current[job.id] = job.status;
    }
  }, [jobs]);

  const setOutputFolder = useCallback((folder) => {
    setSettings((s) => ({ ...s, outputFolder: folder }));
  }, []);

  // Default save folder: the phone's shared Download/U-Download, or the
  // desktop's Videos folder until one is picked.
  useEffect(() => {
    if (isAndroid) {
      invoke("get_android_videos_dir")
        .then((dir) => {
          setEngineError(null);
          setOutputFolder(dir);
        })
        .catch((error) => setEngineError(firstLine(error)));
      return;
    }
    if (settings.outputFolder) return;
    videoDir()
      .catch(() => downloadDir())
      .then(setOutputFolder)
      .catch((error) => console.error("No default download folder:", error));
    // Runs once at start: later changes are the person's own choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A link handed over at launch: Android's share sheet, or the desktop
  // command line / "Open with".
  useEffect(() => {
    invoke("get_shared_url")
      .then((shared) => {
        if (typeof shared === "string" && shared.trim()) setText(shared.trim());
      })
      .catch(() => {
        // "empty": nothing was handed over at launch.
      });
  }, []);

  // Android: links shared while the app is open, and a weekly engine refresh.
  useEffect(() => {
    if (!isAndroid) return undefined;
    let unlisten = null;
    let disposed = false;
    const accept = (shared) => {
      if (typeof shared === "string" && shared.trim()) {
        setText(shared.trim());
        setView("downloads");
      }
    };
    listen("shared-url", (event) => accept(event.payload))
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((error) => console.error("Could not listen for shared links:", error));
    const last = Number(localStorage.getItem("engineUpdatedAt")) || 0;
    if (Date.now() - last > ENGINE_UPDATE_INTERVAL_MS) {
      invoke("update_engine")
        .then(() => localStorage.setItem("engineUpdatedAt", String(Date.now())))
        .catch((error) => console.error("Background yt-dlp update failed:", error));
    }
    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, []);

  const folderRef = useRef(settings.outputFolder);
  folderRef.current = settings.outputFolder;
  useEffect(() => {
    runSelfTestIfRequested({ setOutputFolder, currentFolder: () => folderRef.current });
  }, [setOutputFolder]);

  // What the bar holds decides the engine. The backend's own router answers,
  // so the chip never disagrees with what actually happens.
  useEffect(() => {
    setTrim(null);
    setSelection({ formatId: null, items: null });
    setPreview(null);
    const value = text.trim();
    if (!value) {
      setKind("search");
      return undefined;
    }
    const timer = setTimeout(() => {
      invoke("classify_link", { text: value })
        .then(setKind)
        .catch((error) => console.error("Could not classify the link:", error));
    }, CLASSIFY_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text]);

  // Media links are read ahead: title, picture, formats or playlist items.
  useEffect(() => {
    const value = text.trim();
    if (kind !== "media" || !isHttpUrl(value)) return undefined;
    let stale = false;
    const timer = setTimeout(() => {
      setPreview({ loading: true });
      invoke("inspect_link", { url: value })
        .then((info) => {
          if (!stale) setPreview({ info });
        })
        .catch((error) => {
          if (!stale) setPreview({ error: firstLine(error) });
        });
    }, INSPECT_DELAY_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [text, kind]);

  useEffect(() => {
    if (!notice || notice.tone === "danger") return undefined;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const runSearch = useCallback(async (query, source) => {
    setView("search");
    setSearch({ status: "loading", hits: [], query, error: "" });
    try {
      const hits = await invoke("search_media", { query, source });
      setSearch({ status: "done", hits, query, error: "" });
    } catch (error) {
      setSearch({ status: "error", hits: [], query, error: firstLine(error) });
    }
  }, []);

  const queue = useCallback(async ({ url, linkKind, format, trimRange, options }) => {
    if (!settings.outputFolder) {
      setNotice({ tone: "danger", text: "Choose a folder to save into first." });
      return false;
    }
    if (isAndroid) {
      try {
        if (!(await notifGranted())) await notifRequest();
      } catch (error) {
        console.error("Notification permission check failed:", error);
      }
    }
    try {
      await enqueue({
        url,
        kind: linkKind,
        format,
        trim: trimRange,
        outputFolder: settings.outputFolder,
        concurrency: settings.concurrency,
        options,
      });
      return true;
    } catch (error) {
      setNotice({ tone: "danger", text: `Could not add the download: ${firstLine(error)}` });
      return false;
    }
  }, [enqueue, settings.outputFolder, settings.concurrency]);

  const submit = async () => {
    const value = text.trim();
    if (kind === "search") {
      runSearch(value, searchSource);
      return;
    }
    if (kind === "torrent" && isAndroid) {
      setNotice({ tone: "warning", text: "Torrents and magnet links download in the desktop app." });
      return;
    }
    if (trim && trim.start !== null && trim.end !== null && trim.start >= trim.end) {
      setNotice({ tone: "danger", text: "The trim start must come before its end." });
      return;
    }
    const info = preview?.info;
    const playlist = Boolean(info?.is_playlist);
    const items = playlist && selection.items ? itemsSpec(selection.items) : null;
    if (playlist && selection.items && !items) {
      setNotice({ tone: "danger", text: "Select at least one playlist item." });
      return;
    }
    setBusy(true);
    const ok = await queue({
      url: value,
      linkKind: kind,
      format: formatChoice(settings.mediaKind, settings.quality, playlist ? null : selection.formatId),
      trimRange: trim,
      options: { ...settings.options, playlist, playlist_items: items },
    });
    setBusy(false);
    if (ok) {
      setText("");
      setView("downloads");
      setNotice({ tone: "success", text: "Added. It starts as soon as a slot is free." });
    }
  };

  const downloadHit = async (hit) => {
    const ok = await queue({
      url: hit.url,
      linkKind: "media",
      format: formatChoice(settings.mediaKind, settings.quality, null),
      trimRange: null,
      options: { ...settings.options, playlist: false, playlist_items: null },
    });
    if (ok) setNotice({ tone: "success", text: `Added “${hit.title}”.` });
  };

  const retry = (job) => queue({
    url: job.url,
    linkKind: job.kind,
    format: job.format,
    trimRange: job.trim,
    options: job.options,
  });

  const pickFolder = async () => {
    try {
      const folder = await invoke("select_output_folder");
      if (folder) setOutputFolder(folder);
    } catch (error) {
      if (!String(error).includes("No folder selected")) {
        setNotice({ tone: "danger", text: `The folder dialog failed: ${firstLine(error)}` });
      }
    }
  };

  const checkEngine = async () => {
    setEngineReport("Checking…");
    try {
      const deps = await invoke("test_dependencies");
      const ffmpeg = await invoke("check_ffmpeg").catch((e) => `❌ FFmpeg: ${e}`);
      setEngineReport(`${deps}\n${ffmpeg}`);
    } catch (error) {
      setEngineReport(`The check failed: ${error}`);
    }
  };

  // The shell powers on in order: navigation, command bar, core, list.
  const shellRef = useRef(null);
  useLayoutEffect(() => {
    const t = rise(shellRef.current?.querySelectorAll(".navrail__item, .command, .core, .view"), { stagger: 0.07 });
    return () => t?.kill();
  }, []);

  const report = (action) => (id) => action(id).catch((e) => setNotice({ tone: "danger", text: firstLine(e) }));

  // Readouts for the throughput core, all from the engines' own reports.
  // Only the native engine reports its connections; other jobs count as one.
  const core = useMemo(() => {
    const lanes = jobs
      .filter((j) => LIVE.includes(j.status))
      .map((j) => ({
        id: j.id,
        speed: j.progress?.speed_bytes_per_sec || 0,
        connections: j.kind === "file" ? Math.max(1, j.progress?.connections || 1) : 1,
      }));
    return {
      lanes,
      speed: lanes.reduce((s, l) => s + l.speed, 0),
      connections: lanes.reduce((s, l) => s + l.connections, 0),
      active: jobs.filter((j) => WORKING.includes(j.status)).length,
      bytes: jobs.reduce((s, j) => s + (j.progress?.bytes_downloaded || 0), 0),
    };
  }, [jobs]);

  const activeCount = jobs.filter((j) => !["done", "failed", "cancelled"].includes(j.status)).length;
  const update = useAppUpdate({ enabled: !isAndroid && !import.meta.env.DEV, busy: activeCount > 0 });
  const mobileUpdate = useMobileUpdate({ enabled: isAndroid && !import.meta.env.DEV, currentVersion: appVersion });

  const kindHint = {
    file: { text: `Direct file: ${settings.connections} connections at once, resumable.` },
    torrent: isAndroid
      ? { tone: "warning", text: "Torrents and magnet links download in the desktop app." }
      : { text: "Torrent, magnet or FTP: handed to aria2, stops when complete." },
  };
  const hint = engineError
    ? { tone: "danger", text: `The download engine could not start: ${engineError}` }
    : notice ?? (text.trim() ? kindHint[kind] ?? null : null);

  const folderLabel = settings.outputFolder
    ? settings.outputFolder.split(/[\\/]/).filter(Boolean).slice(-2).join("/")
    : "";
  const shownKind = text.trim() ? kind : "search";
  const studioOpen = shownKind === "media" && isHttpUrl(text);

  return (
    <div className="app" ref={shellRef}>
      {showSplash && <Splash onDone={() => setShowSplash(false)} />}
      <nav className="navrail" aria-label="Main">
        <div className="navrail__brand">
          <img src="/logo.png" alt="" className="navrail__logo" />
          <span className="navrail__name">U-Download</span>
          <span className="navrail__ver num">{appVersion}</span>
        </div>
        {NAV.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            className="navrail__item"
            aria-current={view === id ? "page" : undefined}
            onClick={() => setView(id)}
            data-testid={`nav-${id}`}
          >
            <Icon size={20} />
            <span>{label}</span>
            {id === "downloads" && activeCount > 0 && <span className="navrail__count num">{activeCount}</span>}
          </button>
        ))}
      </nav>

      <main className="main">
        {update.phase !== "idle" && (
          <div role="status" className="banner">
            <span>
              {update.phase === "downloading" && `Downloading U-Download ${update.version}${update.percent === null ? "" : ` (${update.percent}%)`}`}
              {update.phase === "ready" && `U-Download ${update.version} is ready. It installs when your downloads finish.`}
              {update.phase === "installing" && `Installing U-Download ${update.version}. The app restarts by itself.`}
            </span>
            {update.phase === "ready" && (
              <button type="button" className="btn btn-sm btn-secondary" onClick={update.installNow}>Restart now</button>
            )}
          </div>
        )}
        {update.error && (
          <div role="alert" className="banner banner--danger">
            <span>{update.error} It will retry at the next check.</span>
            <button type="button" className="btn btn-sm btn-quiet" onClick={update.dismissError}>Dismiss</button>
          </div>
        )}
        {mobileUpdate.status === "available" && mobileUpdate.latest && (
          <div role="status" className="banner">
            <span>U-Download {mobileUpdate.latest.version} is available.</span>
            <button type="button" className="btn btn-sm btn-secondary" onClick={() => openUrl(APK_DOWNLOAD_URL)}>Download</button>
          </div>
        )}

        <CommandBar
          value={text}
          kind={shownKind}
          busy={busy}
          hint={hint}
          folderLabel={folderLabel}
          canPickFolder={!isAndroid}
          onChange={setText}
          onSubmit={submit}
          onPickFolder={pickFolder}
        />

        {studioOpen && (
          <Studio
            url={text.trim()}
            preview={preview}
            selection={selection}
            onSelection={setSelection}
            mediaKind={settings.mediaKind}
            quality={settings.quality}
            onMediaKind={(mediaKind) => setSettings((s) => ({ ...s, mediaKind }))}
            onQuality={(quality) => setSettings((s) => ({ ...s, quality }))}
            trim={trim}
            onTrim={setTrim}
            busy={busy}
            onDownload={submit}
          />
        )}

        <ThroughputCore
          lanes={core.lanes}
          totalSpeed={core.speed}
          activeTasks={core.active}
          connections={core.connections}
          downloadedBytes={core.bytes}
          armed={kind === "file" || kind === "torrent" || studioOpen}
          pulseKey={pulseKey}
          theme={settings.theme}
        />

        <div className="view">
          {view === "downloads" && (
            <TaskList
              jobs={jobs}
              loadError={jobsError}
              onPause={report(pause)}
              onResume={report(resume)}
              onCancel={report(cancel)}
              onRetry={retry}
              onClearFinished={() => clearFinished().catch((e) => setNotice({ tone: "danger", text: firstLine(e) }))}
            />
          )}
          {view === "search" && (
            <SearchView
              state={search}
              source={searchSource}
              onSource={(source) => {
                setSearchSource(source);
                if (search.query) runSearch(search.query, source);
              }}
              onDownload={downloadHit}
              onRetry={() => runSearch(search.query, searchSource)}
            />
          )}
          {view === "settings" && (
            <SettingsView
              settings={settings}
              onChange={setSettings}
              isAndroid={isAndroid}
              appVersion={appVersion}
              onCheckEngine={checkEngine}
              engineReport={engineReport}
            />
          )}
        </div>
      </main>
    </div>
  );
}
