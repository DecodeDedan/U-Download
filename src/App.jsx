import { useState, useEffect, useRef, useCallback } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { downloadDir, videoDir, join, dirname } from "@tauri-apps/api/path";
import { isPermissionGranted as notifGranted, requestPermission as notifRequest, sendNotification } from "@tauri-apps/plugin-notification";
import { useJobs } from "./hooks/useJobs";
import { useSpeedHistory } from "./hooks/useSpeedHistory";
import { useAppUpdate } from "./hooks/useAppUpdate";
import TrimWorkbench from "./components/TrimWorkbench";
import QueueItem from "./components/QueueItem";
import Splash from "./components/Splash";
import { formatTime } from "./lib/time";
import soundNotifications from "./SoundNotifications";
import {
  IconChevronDown,
  IconDownload,
  IconFolder,
  IconMoon,
  IconQueue,
  IconScissors,
  IconMenu,
  IconSun,
} from "./components/icons";
import Sidebar, { openExternal } from "./components/Sidebar";
import { AboutPage, GuidePage, SettingsPage } from "./components/MobilePages";
import { useMobileUpdate } from "./hooks/useMobileUpdate";
import { APK_DOWNLOAD_URL } from "./lib/mobileRelease";
import "./App.css";

// yt-dlp supports 1000+ sites; the extractor decides what is downloadable, and
// reports back through the normal job error path. This only rejects input that
// is not a URL at all.
const ENGINE_UPDATE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

const isValidUrl = (value) => {
  try {
    const parsed = new URL(String(value).trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
};

function App() {
  const isAndroid = typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent);
  // The mobile app opens on a splash; desktop launches straight into work.
  const [showSplash, setShowSplash] = useState(isAndroid);
  const hideSplash = useCallback(() => setShowSplash(false), []);

  // Mobile navigation: the sidebar and the page it opened. Each is a history
  // entry, so Android's Back button closes them instead of leaving the app.
  const [menuOpen, setMenuOpen] = useState(false);
  const [view, setView] = useState("home");
  useEffect(() => {
    if (!isAndroid) return undefined;
    const onPop = (event) => {
      setMenuOpen(false);
      setView(event.state?.udl === "page" ? event.state.view : "home");
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [isAndroid]);
  const openMenu = () => {
    window.history.pushState({ udl: "menu" }, "");
    setMenuOpen(true);
  };
  const closeMenu = useCallback(() => window.history.back(), []);
  // The menu's own history entry becomes the page's, so Back from a page
  // returns to wherever the menu was opened from.
  const navigate = (id) => {
    window.history.replaceState(id === "home" ? null : { udl: "page", view: id }, "");
    setMenuOpen(false);
    setView(id);
  };

  const [concurrency, setConcurrency] = useState(() => {
    const saved = Number(localStorage.getItem("concurrency"));
    return Number.isInteger(saved) && saved >= 1 && saved <= 3 ? saved : 2;
  });
  useEffect(() => {
    localStorage.setItem("concurrency", String(concurrency));
  }, [concurrency]);
  // Set when the Android download engine fails to start, so the UI says so
  // instead of waiting on "Preparing…" forever.
  const [engineError, setEngineError] = useState(null);
  const [url, setUrl] = useState("");
  const [downloadType, setDownloadType] = useState("mp4");
  const [quality, setQuality] = useState("best");
  const [outputFolder, setOutputFolder] = useState("");
  const [isSelectingFolder, setIsSelectingFolder] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(() => {
    const saved = localStorage.getItem("isDarkMode");
    return saved ? JSON.parse(saved) : false;
  });
  const [appVersion, setAppVersion] = useState("");

  // Trim selection: { start, end } | null. `showTrim` only controls panel
  // visibility, so it can never desync from whether a selection exists.
  const [trim, setTrim] = useState(null);
  const [showTrim, setShowTrim] = useState(false);

  // A trim range is meaningful only for the video it was drawn against.
  // Changing the URL must invalidate it, or the old range is silently applied
  // to a different video.
  useEffect(() => { setTrim(null); }, [url]);

  const handleJobDone = useCallback(({ title, output_path }) => {
    soundNotifications.playDownloadComplete();
    try {
      sendNotification({ title: 'Download Complete', body: title || output_path || 'Your download is ready.' });
    } catch {}
  }, []);

  const { jobs, error: jobsError, enqueue, cancel } = useJobs({ onDone: handleJobDone });

  // Throughput history is not stored anywhere but here: it is accumulated from
  // the progress events the queue already re-renders on, and it dies with the
  // window. See useSpeedHistory for the window size and the pruning.
  const speedHistory = useSpeedHistory(jobs);

  // Play a failure sound / notification the first time a job transitions into
  // "failed", mirroring the old failed-download handling without popping an
  // alert per job (multiple jobs can fail independently in the queue model).
  const prevStatusesRef = useRef({});
  useEffect(() => {
    jobs.forEach((job) => {
      const { status: jobStatus } = job;
      const prevStatus = prevStatusesRef.current[job.id];
      if (jobStatus === 'failed' && prevStatus !== 'failed') {
        soundNotifications.playDownloadError();
        try {
          sendNotification({ title: 'Download Failed', body: job.error || job.title || job.url });
        } catch {}
      }
      prevStatusesRef.current[job.id] = jobStatus;
    });
  }, [jobs]);

  useEffect(() => {
    if (jobsError) {
      console.error("Failed to load jobs:", jobsError);
    }
  }, [jobsError]);

  useEffect(() => {
    localStorage.setItem("isDarkMode", JSON.stringify(isDarkMode));
  }, [isDarkMode]);

  // The palette lives on the document element so the page background, the
  // native form controls and the scrollbars all switch with it — not just the
  // subtree React happens to own.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', isDarkMode ? 'dark' : 'light');
  }, [isDarkMode]);

  // Load app version from Tauri (fallback to dev if unavailable)
  useEffect(() => {
    (async () => {
      try {
        const v = await getVersion();
        setAppVersion(v);
      } catch (e) {
        // Fallback for non-tauri contexts
        try {
          // Optional: embed package.json version via Vite define if present
          // eslint-disable-next-line no-undef
          const envVersion = import.meta?.env?.VITE_APP_VERSION;
          setAppVersion(envVersion || "dev");
        } catch (_) {
          setAppVersion("dev");
        }
      }
    })();
  }, []);

  // Android: links shared from YouTube (or any app) land in the link field.
  // A share that launched the app is pulled once; shares that arrive while
  // it is open come in as `shared-url` events.
  useEffect(() => {
    if (!isAndroid) return undefined;
    let unlisten = null;
    let disposed = false;
    const acceptShared = (shared) => {
      if (isValidUrl(shared)) setUrl(shared);
    };

    listen('shared-url', (event) => acceptShared(event.payload))
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((error) => console.error('Could not listen for shared links:', error));

    invoke('get_shared_url')
      .then(acceptShared)
      .catch(() => { /* "empty": nothing was shared at launch */ });

    // The yt-dlp bundled in the APK ages from the day it ships, and YouTube
    // breaks old versions within weeks, so it is refreshed in the background
    // once a week. Failure is harmless: the next launch tries again.
    const lastEngineUpdate = Number(localStorage.getItem("engineUpdatedAt")) || 0;
    if (Date.now() - lastEngineUpdate > ENGINE_UPDATE_INTERVAL_MS) {
      invoke('update_engine')
        .then(() => localStorage.setItem("engineUpdatedAt", String(Date.now())))
        .catch((error) => console.error('Background yt-dlp update failed:', error));
    }

    // Every Android download lands in the one shared folder the engine can
    // write to; a folder remembered from an older build is replaced.
    invoke('get_android_videos_dir')
      .then((dir) => {
        setEngineError(null);
        setOutputFolder(dir);
      })
      .catch((error) => {
        console.error('Download engine did not start:', error);
        setEngineError(String(error));
      });

    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Desktop: default to the system Videos folder until the user picks one.
  useEffect(() => {
    if (isAndroid || localStorage.getItem("outputFolder")) return;
    (async () => {
      try {
        setOutputFolder(await videoDir());
      } catch {
        try {
          setOutputFolder(await join(await dirname(await downloadDir()), 'Movies'));
        } catch (error) {
          console.error('No default download folder:', error);
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const savedFolder = localStorage.getItem("outputFolder");
    const savedType = localStorage.getItem("downloadType");
    const savedQuality = localStorage.getItem("quality");

    if (savedFolder && !isAndroid) setOutputFolder(savedFolder);
    if (savedType) setDownloadType(savedType);
    if (savedQuality) setQuality(savedQuality);
  }, []);

  useEffect(() => {
    localStorage.setItem("outputFolder", outputFolder);
    localStorage.setItem("downloadType", downloadType);
    localStorage.setItem("quality", quality);
  }, [outputFolder, downloadType, quality]);

  const selectOutputFolder = async () => {
    if (isAndroid) {
      alert('On Android, downloads are saved to Download/U-Download.');
      return;
    }
    setIsSelectingFolder(true);
    try {
      const folder = await invoke("select_output_folder");
      if (folder && folder.length > 0) {
        setOutputFolder(folder);
        console.log("Selected folder:", folder);
      }
    } catch (error) {
      console.error("Failed to select folder:", error);
      // Show user-friendly error message
      if (error.includes("timeout")) {
        alert("Dialog timed out. Please try again.");
      } else if (error.includes("No folder selected")) {
        console.log("User cancelled folder selection");
      } else {
        alert("Failed to open folder dialog. Please try again.");
      }
    } finally {
      setIsSelectingFolder(false);
    }
  };

  const toggleTrim = () => {
    if (!isValidUrl(url)) {
      alert("Please enter a valid URL first");
      return;
    }
    setShowTrim((prev) => !prev);
  };

  const startDownload = async () => {
    if (!isValidUrl(url)) {
      alert("Please enter a valid URL");
      return;
    }

    let folder = outputFolder;
    if (!folder) {
      if (isAndroid) {
        try {
          folder = await invoke('get_android_videos_dir');
          setOutputFolder(folder);
        } catch (error) {
          alert(`The download engine is not ready: ${error}`);
          return;
        }
      }
      if (!folder) {
        alert("Please select an output folder");
        return;
      }
    }

    // Check if FFmpeg is available when trimming is enabled
    if (trim) {
      try {
        await invoke("check_ffmpeg");
      } catch (error) {
        alert(`FFmpeg (bundled) is required for video trimming but was not found.\n\nThis indicates a damaged or incomplete installation.\nPlease reinstall U-Download or download the full installer.\n\nDetails: ${error}`);
        return;
      }

      if (trim.start !== null && trim.end !== null && trim.start >= trim.end) {
        alert("Start time must be before end time");
        return;
      }
    }

    // Asked at the first download, where the reason is obvious, rather than
    // over the launch splash. A refusal only loses the progress notification.
    if (isAndroid) {
      try {
        if (!(await notifGranted())) await notifRequest();
      } catch (error) {
        console.error('Notification permission check failed:', error);
      }
    }

    try {
      await enqueue({
        url,
        format: downloadType === 'mp3'
          ? { mode: 'quick', kind: 'mp3', height: null }
          : { mode: 'quick', kind: 'mp4', height: quality === 'best' ? null : Number(quality) },
        trim,
        outputFolder: folder,
        concurrency,
      });
    } catch (error) {
      console.error("Could not queue download:", error);

      let errorMessage = "Could not queue download: " + error;
      if (String(error).includes("FFmpeg")) {
        errorMessage = "Trimming failed. Please ensure FFmpeg is properly installed.\n\nError: " + error;
      } else if (String(error).includes("aria2c")) {
        errorMessage = "Download accelerator failed. The download will continue without acceleration.\n\nError: " + error;
      } else if (String(error).includes("yt-dlp")) {
        errorMessage = "Downloader failed. Please check your internet connection and try again.\n\nError: " + error;
      }

      alert(errorMessage);
    }
  };

  const toggleTheme = () => {
    setIsDarkMode(!isDarkMode);
  };

  const testDependencies = async () => {
    try {
      const result = await invoke("test_dependencies");

      // Also check FFmpeg
      let ffmpegResult = "";
      try {
        const ffmpeg = await invoke("check_ffmpeg");
        ffmpegResult = `\n\n${ffmpeg}`;
      } catch (error) {
        ffmpegResult = `\n\nFFmpeg: bundled binary not found (${error})`;
      }

      alert(`Dependencies Check:\n\n${result}${ffmpegResult}`);
    } catch (error) {
      alert(`Dependencies Check Failed:\n\n${error}`);
    }
  };

  const urlIsValid = isValidUrl(url);
  const urlIsBad = Boolean(url) && !urlIsValid;
  const canDownload = urlIsValid && Boolean(outputFolder);

  // One sentence that names what is missing and what to do about it, in place
  // of a checklist of ticks.
  // A broken engine outranks everything else: no link can fix it.
  const blockingHint = isAndroid && engineError
    ? `The download engine could not start: ${engineError}. Restart the app, or report this from the menu.`
    : !url
      ? "Paste a video link to begin."
      : !urlIsValid
        ? "The link must start with http:// or https://."
        : !outputFolder
          ? (isAndroid
            ? "Preparing the download engine. This takes a few seconds on first launch."
            : "Choose a folder to save into.")
          : null;

  const activeCount = jobs.filter((j) => !['done', 'failed', 'cancelled'].includes(j.status)).length;
  const update = useAppUpdate({ enabled: !isAndroid && !import.meta.env.DEV, busy: activeCount > 0 });
  const mobileUpdate = useMobileUpdate({ enabled: isAndroid && !import.meta.env.DEV, currentVersion: appVersion });

  return (
    <div className="flex h-full flex-col bg-canvas font-sans text-fg antialiased">
      {showSplash && <Splash onDone={hideSplash} />}
      {isAndroid && (
        <Sidebar
          open={menuOpen}
          onClose={closeMenu}
          view={view}
          onNavigate={navigate}
          appVersion={appVersion}
          update={mobileUpdate}
        />
      )}
      <header className="flex h-11 shrink-0 items-center gap-2.5 border-b border-hair px-4">
        {isAndroid && (
          <button
            type="button"
            onClick={openMenu}
            className="icon-btn -ml-2"
            aria-label="Open menu"
            aria-expanded={menuOpen}
          >
            <IconMenu size={20} />
          </button>
        )}
        <img src="/logo.png" alt="" className="h-5 w-5 shrink-0 object-contain" />
        <h1 className="text-ui font-semibold tracking-[-0.01em]">U-Download</h1>
        <span className="tnum text-micro text-fg-muted">{appVersion || 'dev'}</span>

        <div className="ml-auto flex items-center gap-1">
          {/* Android shows the same report under About. */}
          {!isAndroid && (
            <button type="button" onClick={testDependencies} className="btn btn-sm btn-quiet">
              Diagnostics
            </button>
          )}
          <button
            type="button"
            onClick={toggleTheme}
            className="icon-btn"
            aria-label={isDarkMode ? 'Switch to light theme' : 'Switch to dark theme'}
            title={isDarkMode ? 'Switch to light theme' : 'Switch to dark theme'}
          >
            {isDarkMode ? <IconSun size={18} /> : <IconMoon size={18} />}
          </button>
        </div>
      </header>

      {update.phase !== 'idle' && (
        <div role="status" className="flex shrink-0 items-center gap-3 border-b border-hair px-4 py-1.5 text-meta">
          <span className="min-w-0 flex-1 truncate">
            {update.phase === 'downloading' &&
              `Downloading U-Download ${update.version}${update.percent === null ? '' : ` (${update.percent}%)`}`}
            {update.phase === 'ready' &&
              `U-Download ${update.version} is ready. It installs when your downloads finish.`}
            {update.phase === 'installing' && `Installing U-Download ${update.version}. The app restarts by itself.`}
          </span>
          {update.phase === 'ready' && (
            <button type="button" onClick={update.installNow} className="btn btn-sm btn-secondary">
              Restart now
            </button>
          )}
        </div>
      )}
      {mobileUpdate.status === 'available' && mobileUpdate.latest && (
        <div role="status" className="flex shrink-0 items-center gap-3 border-b border-hair px-4 py-1.5 text-meta">
          <span className="min-w-0 flex-1 truncate">U-Download {mobileUpdate.latest.version} is available.</span>
          <button type="button" onClick={() => openExternal(APK_DOWNLOAD_URL)} className="btn btn-sm btn-secondary">
            Download
          </button>
        </div>
      )}
      {update.error && (
        <div role="alert" className="flex shrink-0 items-center gap-3 border-b border-hair px-4 py-1.5 text-meta text-danger">
          <span className="min-w-0 flex-1 truncate">{update.error} It will retry at the next check.</span>
          <button type="button" onClick={update.dismissError} className="btn btn-sm btn-quiet">
            Dismiss
          </button>
        </div>
      )}

      {isAndroid && view !== 'home' && (
        <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {view === 'settings' && (
            <SettingsPage
              downloadType={downloadType}
              onDownloadType={setDownloadType}
              quality={quality}
              onQuality={setQuality}
              concurrency={concurrency}
              onConcurrency={setConcurrency}
              isDarkMode={isDarkMode}
              onDarkMode={setIsDarkMode}
            />
          )}
          {view === 'guide' && <GuidePage />}
          {view === 'about' && <AboutPage appVersion={appVersion} />}
        </main>
      )}
      {/* Hidden rather than unmounted while another page shows, so a link and
          an open preview survive a trip to Settings. */}
      <main className={`${view === 'home' ? 'grid' : 'hidden'} min-h-0 flex-1 auto-rows-max grid-cols-1 overflow-y-auto overscroll-contain md:grid-cols-[minmax(0,1fr)_24rem] md:grid-rows-1 md:overflow-hidden`}>
        {/* ---- Left: everything that describes the download ---------------- */}
        {/* Shrink-to-fit only in the two-pane layout; stacked on a phone, each
            section takes its content height and the page scrolls. */}
        <section className="flex min-w-0 flex-col md:min-h-0">
          <div className="px-5 pb-4 pt-4">
            <label htmlFor="video-url" className="label-region">Video link</label>
            <input
              id="video-url"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://www.youtube.com/watch?v=..."
              spellCheck="false"
              autoComplete="off"
              className={`field mt-1.5 w-full text-body ${urlIsBad ? 'field-invalid' : ''}`}
            />
            {urlIsBad && (
              <p className="mt-1.5 text-meta text-danger">
                That is not a valid link. It must start with http:// or https://.
              </p>
            )}
          </div>

          {showTrim ? (
            <TrimWorkbench url={url} onChange={setTrim} onClose={() => setShowTrim(false)} />
          ) : (
            <div className="flex flex-1 flex-col md:min-h-0">
              <div className="flex items-center gap-3 px-5 pb-2">
                <span className="label-region shrink-0">Preview</span>
                <p className="min-w-0 flex-1 truncate text-meta text-fg-muted">Not open</p>
              </div>
              <div className="flex min-h-[6rem] flex-1 flex-col items-center justify-center gap-3 border-y border-hair bg-stage px-6 text-center">
                <IconScissors size={22} className="text-white/45" />
                <p className="max-w-xs text-body text-white/70">
                  Open the preview to scrub the video and place exact start and end points.
                </p>
                <button type="button" onClick={toggleTrim} className="btn btn-secondary">
                  Open preview
                </button>
              </div>
            </div>
          )}

          <div className="grid shrink-0 grid-cols-2 gap-4 px-5 pt-4">
            <div>
              <label htmlFor="format" className="label-region">Format</label>
              <div className="relative mt-1.5">
                <select
                  id="format"
                  value={downloadType}
                  onChange={(e) => setDownloadType(e.target.value)}
                  className="field w-full text-body"
                >
                  <option value="mp4">MP4 video</option>
                  <option value="mp3">MP3 audio only</option>
                </select>
                <IconChevronDown size={16} className="pointer-events-none absolute right-2.5 top-1/2 -mt-2 text-fg-muted" />
              </div>
            </div>

            <div>
              <label htmlFor="quality" className="label-region">Quality</label>
              <div className="relative mt-1.5">
                <select
                  id="quality"
                  value={quality}
                  onChange={(e) => setQuality(e.target.value)}
                  className="field w-full text-body"
                >
                  <option value="360">360p</option>
                  <option value="480">480p</option>
                  <option value="720">720p</option>
                  <option value="1080">1080p</option>
                  <option value="best">Best available</option>
                </select>
                <IconChevronDown size={16} className="pointer-events-none absolute right-2.5 top-1/2 -mt-2 text-fg-muted" />
              </div>
            </div>
          </div>

          <div className="shrink-0 px-5 pt-4">
            <label className="label-region" id="save-to-label">Save to</label>
            <div className="mt-1.5 flex items-center gap-2">
              <div
                className="flex min-w-0 flex-1 items-center gap-2 rounded-field border border-hair-strong bg-panel px-2.5 py-[7px]"
                aria-labelledby="save-to-label"
                title={outputFolder || undefined}
              >
                <IconFolder size={16} className="shrink-0 text-fg-muted" />
                <span className={`truncate text-ui ${outputFolder ? '' : 'text-fg-muted'}`}>
                  {isAndroid
                    ? (outputFolder ? 'Download/U-Download' : 'Preparing the download engine…')
                    : outputFolder || 'No folder chosen yet'}
                </span>
              </div>
              {/* Android's folder picker returns content:// URIs that yt-dlp cannot write to. */}
              {!isAndroid && (
                <button
                  type="button"
                  onClick={selectOutputFolder}
                  disabled={isSelectingFolder}
                  className="btn btn-secondary shrink-0"
                >
                  {isSelectingFolder ? 'Opening' : outputFolder ? 'Change' : 'Choose'}
                </button>
              )}
            </div>
          </div>

          <div className="mt-4 shrink-0 border-t border-hair px-5 py-4">
            <button
              type="button"
              onClick={startDownload}
              disabled={!canDownload}
              className="btn btn-primary w-full py-2.5 text-body"
            >
              <IconDownload size={18} />
              {trim ? 'Trim and download' : 'Download'}
            </button>
            <p role="status" className="mt-2 min-h-[1.125rem] text-meta text-fg-muted">
              {blockingHint || (trim
                ? <>Clip <span className="tnum text-fg">{formatTime(trim.start)}</span> to <span className="tnum text-fg">{formatTime(trim.end)}</span>, re-encoded with FFmpeg.</>
                : 'The whole video is downloaded unless a clip is set in the preview.')}
            </p>
          </div>
        </section>

        {/* ---- Right: the queue, the only region that scrolls -------------- */}
        <aside className="flex flex-col border-t border-hair md:min-h-0 md:border-l md:border-t-0">
          <div className="flex h-10 shrink-0 items-center gap-3 border-b border-hair px-4">
            <span className="label-region">Queue</span>
            {jobs.length > 0 && (
              <span className="tnum ml-auto text-meta text-fg-muted">
                {activeCount > 0 ? `${activeCount} active of ${jobs.length}` : `${jobs.length} finished`}
              </span>
            )}
          </div>

          <div className="scroll-quiet flex-1 md:min-h-0 md:overflow-y-auto">
            {jobs.length === 0 ? (
              <div className="flex h-full min-h-[12rem] flex-col items-center justify-center gap-2.5 px-8 text-center">
                <IconQueue size={22} className="text-fg-muted" />
                <p className="text-body font-medium">Nothing queued</p>
                <p className="max-w-[16rem] text-meta text-fg-muted">
                  Downloads appear here with their thumbnail, a trace of the speed
                  they are running at, and the time remaining. Several can run at
                  once, and finished files stay listed until you quit.
                </p>
              </div>
            ) : (
              jobs.map((job) => (
                <QueueItem
                  key={job.id}
                  job={job}
                  samples={speedHistory[job.id]}
                  onCancel={cancel}
                />
              ))
            )}
          </div>
        </aside>
      </main>
    </div>
  );
}

export default App;
