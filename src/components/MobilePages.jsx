import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openExternal } from "./Sidebar";
import { IconChevronDown } from "./icons";
import { APK_DOWNLOAD_URL, DEVELOPER_URL, SOURCE_URL } from "../lib/mobileRelease";

/** The secondary pages the mobile sidebar opens. */

function Page({ title, children }) {
  return (
    <div className="mx-auto w-full max-w-xl px-5 py-6">
      <h2 className="text-[1.375rem] font-semibold tracking-[-0.01em]">{title}</h2>
      <div className="mt-5 flex flex-col gap-6">{children}</div>
    </div>
  );
}

function Select({ label, value, onChange, children }) {
  return (
    <div className="relative">
      <select value={value} onChange={(e) => onChange(e.target.value)} className="field w-full pr-9" aria-label={label}>
        {children}
      </select>
      <IconChevronDown size={16} className="pointer-events-none absolute right-2.5 top-1/2 -mt-2 text-fg-muted" />
    </div>
  );
}

function Section({ title, children }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="label-region">{title}</h3>
      {children}
    </section>
  );
}

const MAX_PARALLEL = 3;

export function SettingsPage({
  downloadType,
  onDownloadType,
  quality,
  onQuality,
  concurrency,
  onConcurrency,
  isDarkMode,
  onDarkMode,
}) {
  return (
    <Page title="Settings">
      <Section title="Default format">
        <Select label="Default format" value={downloadType} onChange={onDownloadType}>
          <option value="mp4">MP4 video</option>
          <option value="mp3">MP3 audio only</option>
        </Select>
      </Section>

      <Section title="Default quality">
        <Select label="Default quality" value={quality} onChange={onQuality}>
          <option value="360">360p (smallest)</option>
          <option value="480">480p</option>
          <option value="720">720p</option>
          <option value="1080">1080p</option>
          <option value="best">Best available</option>
        </Select>
        <p className="text-meta text-fg-muted">Lower qualities save mobile data.</p>
      </Section>

      <Section title="Downloads at once">
        <div role="radiogroup" aria-label="Downloads at once" className="flex gap-2">
          {Array.from({ length: MAX_PARALLEL }, (_, i) => i + 1).map((n) => (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={concurrency === n}
              onClick={() => onConcurrency(n)}
              className={`btn flex-1 ${concurrency === n ? "btn-primary" : "btn-secondary"}`}
            >
              {n}
            </button>
          ))}
        </div>
        <p className="text-meta text-fg-muted">Each download already uses many connections; more at once mostly splits your bandwidth.</p>
      </Section>

      <Section title="Theme">
        <div role="radiogroup" aria-label="Theme" className="flex gap-2">
          {[
            ["Light", false],
            ["Dark", true],
          ].map(([label, dark]) => (
            <button
              key={label}
              type="button"
              role="radio"
              aria-checked={isDarkMode === dark}
              onClick={() => onDarkMode(dark)}
              className={`btn flex-1 ${isDarkMode === dark ? "btn-primary" : "btn-secondary"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </Section>

      <Section title="Save location">
        <p className="text-ui">Download/U-Download</p>
        <p className="text-meta text-fg-muted">Find your files in the Files app under Downloads, or in your gallery and music apps.</p>
      </Section>
    </Page>
  );
}

const STEPS = [
  ["Open a video in YouTube", "Or any of the 1,000+ sites yt-dlp supports."],
  ["Tap Share, then U-Download", "Not in the list? Tap More. Long-press U-Download there to pin it to the front."],
  ["Pick a format and tap Download", "The link is already filled in for you."],
  ["Keep watching", "Downloads continue in the background, with progress in your notifications."],
];

export function GuidePage() {
  return (
    <Page title="How to use">
      <ol className="flex flex-col gap-4">
        {STEPS.map(([title, detail], i) => (
          <li key={title} className="flex gap-4">
            <span className="tnum flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-ui font-semibold text-fg">
              {i + 1}
            </span>
            <div>
              <p className="text-ui font-semibold">{title}</p>
              <p className="text-meta text-fg-muted">{detail}</p>
            </div>
          </li>
        ))}
      </ol>
      <Section title="Other ways">
        <p className="text-meta text-fg-muted">
          Paste a link into the box on the Download screen. Open the preview to cut a clip: drag the playhead and mark the
          start and end.
        </p>
      </Section>
      <Section title="If a download fails">
        <p className="text-meta text-fg-muted">
          Sites change often. Open the menu and tap “Update download engine”, then try again.
        </p>
      </Section>
    </Page>
  );
}

const COMPONENTS = [
  ["yt-dlp", "Unlicense"],
  ["youtubedl-android", "GPL-3.0"],
  ["FFmpeg", "GPL-3.0"],
  ["aria2", "GPL-2.0-or-later"],
  ["Python", "PSF License"],
  ["QuickJS", "MIT"],
  ["Tauri", "MIT / Apache-2.0"],
  ["React", "MIT"],
  ["GSAP", "GSAP Standard License"],
];

export function AboutPage({ appVersion }) {
  const [engine, setEngine] = useState(null);

  useEffect(() => {
    invoke("test_dependencies")
      .then(setEngine)
      .catch((error) => setEngine(`Download engine unavailable: ${error}`));
  }, []);

  return (
    <Page title="About">
      <div className="flex items-center gap-4">
        <img src="/logo.png" alt="" className="h-16 w-16 object-contain" />
        <div>
          <p className="text-ui font-semibold">U-Download for Android</p>
          <p className="tnum text-meta text-fg-muted">Version {appVersion || "dev"}</p>
        </div>
      </div>

      <Section title="Developer">
        <p className="text-ui">
          Developed by <span className="font-semibold">OkwareTech</span>
        </p>
        <button type="button" onClick={() => openExternal(DEVELOPER_URL)} className="btn btn-secondary self-start">
          okwaretech.com
        </button>
      </Section>

      <Section title="Share the app">
        <p className="text-meta text-fg-muted">The latest Android version is always at:</p>
        <p className="break-all text-meta">{APK_DOWNLOAD_URL}</p>
      </Section>

      <Section title="Privacy">
        <p className="text-meta text-fg-muted">
          No account, no ads, no tracking. Videos travel straight from the site to your phone; U-Download only contacts
          GitHub to check for app and engine updates.
        </p>
      </Section>

      <Section title="Fair use">
        <p className="text-meta text-fg-muted">
          Download only what you have the right to keep, and respect each site’s terms and the creators who made it.
        </p>
      </Section>

      <Section title="Download engine">
        <pre className="whitespace-pre-wrap break-all rounded-[3px] bg-sunken p-3 text-micro text-fg-muted">{engine ?? "Checking…"}</pre>
      </Section>

      <Section title="Open source">
        <p className="text-meta text-fg-muted">
          U-Download is free software. Because it includes GPL-licensed components, the app as a whole is distributed under
          the GPL-3.0, and its full source code is public.
        </p>
        <ul className="flex flex-col divide-y divide-hair rounded-[3px] border border-hair">
          {COMPONENTS.map(([name, license]) => (
            <li key={name} className="flex justify-between px-3 py-2 text-meta">
              <span>{name}</span>
              <span className="text-fg-muted">{license}</span>
            </li>
          ))}
        </ul>
        <button type="button" onClick={() => openExternal(SOURCE_URL)} className="btn btn-secondary self-start">
          Source code on GitHub
        </button>
      </Section>
    </Page>
  );
}
