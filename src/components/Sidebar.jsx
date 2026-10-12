import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import gsap from "gsap";
import { IconClose, IconExternal } from "./icons";
import { APK_DOWNLOAD_URL, DEVELOPER_URL, ISSUES_URL } from "../lib/mobileRelease";

const SLIDE_S = 0.2;

const NAV = [
  { id: "home", label: "Download" },
  { id: "settings", label: "Settings" },
  { id: "guide", label: "How to use" },
  { id: "about", label: "About" },
];

const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export const openExternal = (url) =>
  openUrl(url).catch((error) => console.error(`Could not open ${url}:`, error));

/**
 * The mobile navigation drawer. Stays mounted while it slides out, so the
 * exit is animated too; the start positions are written by GSAP at runtime.
 */
export default function Sidebar({ open, onClose, view, onNavigate, appVersion, update }) {
  const panelRef = useRef(null);
  const backdropRef = useRef(null);
  const firstItemRef = useRef(null);
  const [mounted, setMounted] = useState(open);
  const [engine, setEngine] = useState({ busy: false, message: null });

  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);

  useLayoutEffect(() => {
    if (!mounted) return undefined;
    const panel = panelRef.current;
    const backdrop = backdropRef.current;
    const reduce = prefersReducedMotion();
    if (open) {
      if (!reduce) {
        gsap.fromTo(panel, { xPercent: -100 }, { xPercent: 0, duration: SLIDE_S, ease: "power2.out" });
        gsap.fromTo(backdrop, { opacity: 0 }, { opacity: 1, duration: SLIDE_S });
      }
      firstItemRef.current?.focus();
      return () => gsap.killTweensOf([panel, backdrop]);
    }
    if (reduce) {
      setMounted(false);
      return undefined;
    }
    gsap.to(backdrop, { opacity: 0, duration: SLIDE_S });
    gsap.to(panel, { xPercent: -100, duration: SLIDE_S, ease: "power2.in", onComplete: () => setMounted(false) });
    return () => gsap.killTweensOf([panel, backdrop]);
  }, [open, mounted]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const updateEngine = async () => {
    setEngine({ busy: true, message: "Updating yt-dlp…" });
    try {
      const version = await invoke("update_engine");
      localStorage.setItem("engineUpdatedAt", String(Date.now()));
      setEngine({ busy: false, message: `yt-dlp is up to date (${version}).` });
    } catch (error) {
      setEngine({ busy: false, message: `Update failed: ${error}` });
    }
  };

  if (!mounted) return null;

  const updateLine = {
    idle: null,
    checking: "Checking for a newer version…",
    current: "You have the latest version.",
    available: update.latest ? `Version ${update.latest.version} is available.` : null,
    error: update.error ? `Could not check: ${update.error}` : null,
  }[update.status];

  return (
    <div className="fixed inset-0 z-40">
      <div ref={backdropRef} className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden="true" />
      <nav
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Menu"
        className="absolute inset-y-0 left-0 flex w-[min(20rem,85vw)] flex-col border-r border-hair bg-panel"
      >
        <div className="flex items-center gap-3 border-b border-hair px-4 py-4">
          <img src="/logo.png" alt="" className="h-9 w-9 shrink-0 object-contain" />
          <div className="min-w-0 flex-1">
            <p className="text-ui font-semibold">U-Download</p>
            <p className="tnum text-micro text-fg-muted">Android {appVersion || "dev"}</p>
          </div>
          <button type="button" onClick={onClose} className="icon-btn" aria-label="Close menu">
            <IconClose size={18} />
          </button>
        </div>

        <div className="scroll-quiet flex-1 overflow-y-auto py-2">
          <ul>
            {NAV.map((item, index) => (
              <li key={item.id}>
                <button
                  ref={index === 0 ? firstItemRef : undefined}
                  type="button"
                  onClick={() => onNavigate(item.id)}
                  aria-current={view === item.id ? "page" : undefined}
                  className={`flex w-full items-center px-4 py-3 text-left text-ui ${
                    view === item.id ? "bg-accent-soft font-semibold text-fg" : "text-fg hover:bg-sunken"
                  }`}
                >
                  {item.label}
                </button>
              </li>
            ))}
          </ul>

          <div className="mt-2 border-t border-hair px-4 pt-4">
            <p className="label-region">Updates</p>
            <div className="mt-2 flex flex-col gap-2">
              {update.status === "available" ? (
                <button type="button" onClick={() => openExternal(APK_DOWNLOAD_URL)} className="btn btn-primary">
                  Download version {update.latest.version}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={update.check}
                  disabled={update.status === "checking"}
                  className="btn btn-secondary"
                >
                  Check for app update
                </button>
              )}
              {updateLine && (
                <p role="status" className="text-meta text-fg-muted">
                  {updateLine}
                </p>
              )}
              <button type="button" onClick={updateEngine} disabled={engine.busy} className="btn btn-secondary">
                Update download engine
              </button>
              {engine.message && (
                <p role="status" className="text-meta text-fg-muted">
                  {engine.message}
                </p>
              )}
            </div>
          </div>

          <div className="mt-4 border-t border-hair px-4 pt-2">
            <button
              type="button"
              onClick={() => openExternal(ISSUES_URL)}
              className="flex w-full items-center justify-between py-3 text-left text-ui text-fg"
            >
              Report a problem
              <IconExternal size={16} className="text-fg-muted" />
            </button>
            <button
              type="button"
              onClick={() => openExternal(DEVELOPER_URL)}
              className="flex w-full items-center justify-between py-3 text-left text-ui text-fg"
            >
              Visit okwaretech.com
              <IconExternal size={16} className="text-fg-muted" />
            </button>
          </div>
        </div>

        <p className="border-t border-hair px-4 py-3 text-micro text-fg-muted">
          Developed by{" "}
          <button type="button" onClick={() => openExternal(DEVELOPER_URL)} className="font-semibold text-fg underline">
            OkwareTech
          </button>{" "}
          · okwaretech.com
        </p>
      </nav>
    </div>
  );
}
