import { useEffect, useRef, useState } from "react";
import { formatSpeed } from "../lib/format";
import { countTo, prefersReducedMotion } from "../lib/motion";

/**
 * The live throughput core: the WebGL scene (lib/coreScene.js) behind a HUD
 * of real readouts. The scene is loaded on demand, so the readouts paint
 * first and a webview without WebGL still gets every number.
 */

function readColour(el, name, fallback) {
  const value = getComputedStyle(el).getPropertyValue(name).trim();
  return value || fallback;
}

/** "15.9 MB/s" → [15.9, "MB/s"]; nothing reported → [0, "B/s"]. */
function speedParts(bps) {
  const text = formatSpeed(bps);
  if (!text) return [0, "B/s"];
  const [value, unit] = text.split(" ");
  return [Number(value), unit];
}

export default function ThroughputCore({
  lanes,
  totalSpeed,
  activeTasks,
  connections,
  downloadedBytes,
  armed,
  pulseKey,
  theme,
}) {
  const canvasRef = useRef(null);
  const sceneRef = useRef(null);
  const valueRef = useRef(null);
  const shownRef = useRef(0);
  const [webgl, setWebgl] = useState(true);
  const latest = useRef({ lanes, totalSpeed, armed });
  latest.current = { lanes, totalSpeed, armed };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    let disposed = false;
    let cleanup = () => {};

    import("../lib/coreScene")
      .then(({ createCoreScene }) => {
        if (disposed) return;
        let scene;
        try {
          scene = createCoreScene(canvas, {
            phone: window.matchMedia("(max-width: 720px)").matches,
            reduced: prefersReducedMotion(),
          });
        } catch (error) {
          console.error("3D core unavailable, showing readouts only:", error);
          setWebgl(false);
          return;
        }
        sceneRef.current = scene;
        const applyColours = () =>
          scene.setColors({
            accent: readColour(canvas, "--accent", "#ff9f1c"),
            lane: readColour(canvas, "--border", "#40464b"),
            background: readColour(canvas, "--neutral-1", "#0b1015"),
            light: document.documentElement.getAttribute("data-theme") === "light",
          });
        const resize = () => {
          const r = canvas.getBoundingClientRect();
          scene.resize(r.width, r.height);
        };
        applyColours();
        resize();
        const { lanes: l, totalSpeed: s, armed: a } = latest.current;
        scene.setData({ lanes: l, speed: s, armed: a });

        const ro = new ResizeObserver(resize);
        ro.observe(canvas);
        const io = new IntersectionObserver(([entry]) => scene.setVisible(entry.isIntersecting));
        io.observe(canvas);
        const onVisibility = () => scene.setVisible(!document.hidden);
        document.addEventListener("visibilitychange", onVisibility);
        const themeWatch = new MutationObserver(applyColours);
        themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

        cleanup = () => {
          ro.disconnect();
          io.disconnect();
          themeWatch.disconnect();
          document.removeEventListener("visibilitychange", onVisibility);
          scene.dispose();
          sceneRef.current = null;
        };
      })
      .catch((error) => {
        console.error("3D core failed to load:", error);
        setWebgl(false);
      });

    return () => {
      disposed = true;
      cleanup();
    };
  }, []);

  useEffect(() => {
    sceneRef.current?.setData({ lanes, speed: totalSpeed, armed });
  }, [lanes, totalSpeed, armed, theme]);

  useEffect(() => {
    if (pulseKey > 0) sceneRef.current?.pulse();
  }, [pulseKey]);

  const [value, unit] = speedParts(totalSpeed);
  const decimals = Number.isInteger(value) ? 0 : 1;
  useEffect(() => {
    const tween = countTo(valueRef.current, shownRef.current, value, (v) => v.toFixed(decimals));
    shownRef.current = value;
    return () => tween?.kill();
  }, [value, decimals]);

  const idle = activeTasks === 0;
  const label = idle ? (armed ? "Link locked · ready" : "Standing by") : "Throughput";

  return (
    <section
      className={`core ${idle ? "core--idle" : "core--live"} ${armed ? "core--armed" : ""}`}
      aria-label="Live throughput"
      data-testid="core"
    >
      {webgl && <canvas ref={canvasRef} className="core__canvas" aria-hidden="true" />}
      <div className="core__readout">
        <p className="core__label">
          <span className="core__dot" aria-hidden="true" />
          {label}
        </p>
        <p className="core__speed" data-testid="hud-speed">
          {/* Written by the count-up tween, not by React, so the two never fight over the text. */}
          <span className="core__value" ref={valueRef} />

          <span className="core__unit">{unit}</span>
        </p>
      </div>
      <dl className="core__stats">
        <div>
          <dt>Tasks</dt>
          <dd data-testid="hud-tasks">{activeTasks}</dd>
        </div>
        <div>
          <dt>Connections</dt>
          <dd data-testid="hud-connections">{connections}</dd>
        </div>
        <div>
          <dt>Session</dt>
          <dd>{formatBytes(downloadedBytes)}</dd>
        </div>
      </dl>
    </section>
  );
}

export function formatBytes(bytes) {
  const v = Number(bytes) || 0;
  if (v < 1024) return `${v} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let n = v / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n >= 100 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}
