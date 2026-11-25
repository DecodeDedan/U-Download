import gsap from "gsap";

/**
 * The app's motion vocabulary, on GSAP. Every from-state is written at run
 * time (gsap.from), never in the stylesheet, so a webview that fails to run
 * this still shows the whole interface. Reduced motion turns all of it off.
 */

export const prefersReducedMotion = () =>
  typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);

const EASE = "power3.out";

/** Elements rise into place one after another. */
export function rise(targets, { delay = 0, stagger = 0.06, y = 14, duration = 0.55 } = {}) {
  if (prefersReducedMotion() || !targets) return null;
  return gsap.from(targets, { y, opacity: 0, duration, stagger, delay, ease: EASE, clearProps: "transform,opacity" });
}

/** A panel opens from slightly smaller, the way a screen powers on. */
export function powerOn(target, { delay = 0 } = {}) {
  if (prefersReducedMotion() || !target) return null;
  return gsap.from(target, {
    scale: 0.97,
    y: 10,
    opacity: 0,
    duration: 0.6,
    delay,
    ease: EASE,
    clearProps: "transform,opacity",
  });
}

/** A new row slides in from the command bar's side. */
export function slideIn(target) {
  if (prefersReducedMotion() || !target) return null;
  return gsap.from(target, { x: -16, opacity: 0, duration: 0.45, ease: EASE, clearProps: "transform,opacity" });
}

/** A one-shot glow over an element (its `.flash` overlay), for "this just finished". */
export function flash(overlay) {
  if (prefersReducedMotion() || !overlay) return null;
  return gsap.fromTo(overlay, { opacity: 0.9 }, { opacity: 0, duration: 1.4, ease: "power2.out" });
}

/** Counts a number up or down to `value`, writing it with `format`. */
export function countTo(el, from, value, format) {
  if (!el) return null;
  if (prefersReducedMotion()) {
    el.textContent = format(value);
    return null;
  }
  const box = { v: from };
  return gsap.to(box, {
    v: value,
    duration: 0.45,
    ease: "power2.out",
    onUpdate: () => {
      el.textContent = format(box.v);
    },
  });
}
