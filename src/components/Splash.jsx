import { useEffect, useRef } from "react";
import gsap from "gsap";

/** How long the splash stays up, fade-out included. */
export const SPLASH_MS = 3000;
const FADE_OUT_S = 0.35;

/**
 * Launch splash for the mobile app: logo, name and tagline over the app,
 * which keeps loading underneath so a shared link is already in place when
 * the splash lifts.
 *
 * Every hidden start state is written by `gsap.from` at runtime, so if the
 * animation never runs the splash still renders complete and still lifts on
 * the timer. Reduced motion gets the same three seconds without movement.
 */
export default function Splash({ onDone }) {
  const root = useRef(null);

  useEffect(() => {
    const timer = window.setTimeout(onDone, SPLASH_MS);
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) return () => window.clearTimeout(timer);

    const ctx = gsap.context(() => {
      gsap
        .timeline()
        .from("[data-splash='logo']", { scale: 0.6, opacity: 0, duration: 0.7, ease: "back.out(1.7)" })
        .from("[data-splash='name']", { y: 16, opacity: 0, duration: 0.5, ease: "power3.out" }, "-=0.3")
        .from("[data-splash='tagline']", { y: 12, opacity: 0, duration: 0.5, ease: "power3.out" }, "-=0.3")
        .from(
          "[data-splash='bar']",
          { scaleX: 0, transformOrigin: "left center", duration: SPLASH_MS / 1000 - 0.9, ease: "power1.inOut" },
          0.4,
        )
        .to(root.current, { opacity: 0, duration: FADE_OUT_S, ease: "power1.in" }, SPLASH_MS / 1000 - FADE_OUT_S);
    }, root);

    return () => {
      window.clearTimeout(timer);
      ctx.revert();
    };
  }, [onDone]);

  return (
    <div
      ref={root}
      role="status"
      aria-label="U-Download is starting"
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-canvas px-6 text-center"
    >
      <img data-splash="logo" src="/logo.png" alt="" className="h-24 w-24 object-contain" />
      <p data-splash="name" className="text-[1.75rem] font-semibold tracking-[-0.02em] text-fg">
        U-Download
      </p>
      <p data-splash="tagline" className="text-ui text-fg-muted">
        Share from any app. Saved in seconds.
      </p>
      <div className="mt-6 h-[3px] w-40 overflow-hidden rounded-full bg-sunken" aria-hidden="true">
        <div data-splash="bar" className="h-full w-full bg-accent" />
      </div>
    </div>
  );
}
