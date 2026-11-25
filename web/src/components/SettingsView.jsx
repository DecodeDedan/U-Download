import { useState } from "react";
import { AUDIO_FORMATS, BROWSERS, MAX_CONCURRENCY, MAX_CONNECTIONS } from "../lib/settings";

function Toggle({ label, help, checked, onChange, disabled }) {
  return (
    <label className={`setting setting--toggle ${disabled ? "setting--disabled" : ""}`}>
      <span className="setting__text">
        <span className="setting__label">{label}</span>
        {help && <span className="setting__help">{help}</span>}
      </span>
      <input
        type="checkbox"
        role="switch"
        className="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}

function Range({ label, help, value, min, max, step = 1, unit, onChange }) {
  return (
    <label className="setting">
      <span className="setting__text">
        <span className="setting__label">{label}</span>
        {help && <span className="setting__help">{help}</span>}
      </span>
      <span className="setting__range">
        <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
        <output className="num setting__value">{value}{unit ? ` ${unit}` : ""}</output>
      </span>
    </label>
  );
}

export default function SettingsView({ settings, onChange, isAndroid, appVersion, onCheckEngine, engineReport }) {
  const [limitText, setLimitText] = useState(settings.speedLimitKbps ? String(settings.speedLimitKbps) : "");
  const set = (patch) => onChange({ ...settings, ...patch });
  const setOption = (patch) => onChange({ ...settings, options: { ...settings.options, ...patch } });
  const o = settings.options;

  const commitLimit = () => {
    const n = limitText.trim() === "" ? 0 : Number(limitText);
    if (Number.isInteger(n) && n >= 0) set({ speedLimitKbps: n });
    else setLimitText(settings.speedLimitKbps ? String(settings.speedLimitKbps) : "");
  };

  return (
    <section className="settings" aria-labelledby="settings-heading">
      <header className="tasks__head">
        <h2 id="settings-heading" className="section-title">Settings</h2>
      </header>

      <div className="settings__group">
        <h3 className="group-title">Speed</h3>
        <Range
          label="Connections per file"
          help={isAndroid ? "Used by the desktop engine; the phone engine opens 16." : "How many parts of one file download at once."}
          value={settings.connections}
          min={1}
          max={MAX_CONNECTIONS}
          onChange={(v) => set({ connections: v })}
        />
        <Range
          label="Downloads at once"
          help="The rest wait their turn."
          value={settings.concurrency}
          min={1}
          max={MAX_CONCURRENCY}
          onChange={(v) => set({ concurrency: v })}
        />
        <label className="setting">
          <span className="setting__text">
            <span className="setting__label">Speed limit</span>
            <span className="setting__help">KB/s across every download. Empty means no limit.</span>
          </span>
          <input
            className="field-input num"
            inputMode="numeric"
            value={limitText}
            placeholder="No limit"
            onChange={(e) => setLimitText(e.target.value.replace(/[^0-9]/g, ""))}
            onBlur={commitLimit}
            aria-label="Speed limit in KB/s"
          />
        </label>
      </div>

      <div className="settings__group">
        <h3 className="group-title">Videos</h3>
        <Toggle
          label="No watermarks"
          help="Skips the watermarked copy TikTok and Douyin offer when a clean one exists."
          checked={o.no_watermark}
          onChange={(v) => setOption({ no_watermark: v })}
        />
        <Toggle label="Subtitles" help="Downloads and embeds them." checked={o.subtitles} onChange={(v) => setOption({ subtitles: v })} />
        {o.subtitles && (
          <label className="setting">
            <span className="setting__text">
              <span className="setting__label">Subtitle languages</span>
              <span className="setting__help">Codes separated by commas, like en.*,fr</span>
            </span>
            <input
              className="field-input"
              value={o.subtitle_langs}
              onChange={(e) => {
                const v = e.target.value;
                if (/^[A-Za-z0-9.*,_-]{0,64}$/.test(v)) setOption({ subtitle_langs: v || "en.*" });
              }}
            />
          </label>
        )}
        <Toggle label="Skip sponsors" help="Cuts sponsor and self-promotion segments from YouTube videos (SponsorBlock)." checked={o.sponsorblock} onChange={(v) => setOption({ sponsorblock: v })} />
        <Toggle label="Title, artist and date" help="Written into the file." checked={o.embed_metadata} onChange={(v) => setOption({ embed_metadata: v })} />
        <Toggle label="Cover picture" help="The thumbnail, embedded." checked={o.embed_thumbnail} onChange={(v) => setOption({ embed_thumbnail: v })} />
        <label className="setting">
          <span className="setting__text">
            <span className="setting__label">Audio format</span>
            <span className="setting__help">Used when you choose Audio.</span>
          </span>
          <select className="select select--sm" value={o.audio_format} onChange={(e) => setOption({ audio_format: e.target.value })}>
            {AUDIO_FORMATS.map((f) => <option key={f} value={f}>{f.toUpperCase()}</option>)}
          </select>
        </label>
        {!isAndroid && (
          <label className="setting">
            <span className="setting__text">
              <span className="setting__label">Sign in with my browser</span>
              <span className="setting__help">For private or age-limited videos: uses that browser’s login.</span>
            </span>
            <select
              className="select select--sm"
              value={o.cookies_browser || ""}
              onChange={(e) => setOption({ cookies_browser: e.target.value || null })}
            >
              <option value="">Off</option>
              {BROWSERS.map((b) => <option key={b} value={b}>{b[0].toUpperCase() + b.slice(1)}</option>)}
            </select>
          </label>
        )}
      </div>

      <div className="settings__group">
        <h3 className="group-title">App</h3>
        <Toggle label="Dark theme" checked={settings.theme === "dark"} onChange={(v) => set({ theme: v ? "dark" : "light" })} />
        <Toggle label="Sounds" help="A chime when a download ends or fails." checked={settings.sound} onChange={(v) => set({ sound: v })} />
        <div className="setting">
          <span className="setting__text">
            <span className="setting__label">Download engines</span>
            <span className="setting__help">Checks yt-dlp, aria2, ffmpeg and the rest.</span>
          </span>
          <button type="button" className="btn btn-sm btn-secondary" onClick={onCheckEngine}>Check</button>
        </div>
        {engineReport && <pre className="report" aria-live="polite">{engineReport}</pre>}
        <p className="setting__help">U-Download {appVersion || ""}</p>
      </div>
    </section>
  );
}
