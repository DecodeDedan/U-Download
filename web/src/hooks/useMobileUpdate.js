import { useCallback, useEffect, useRef, useState } from "react";
import { compareVersions, latestAndroidRelease, RELEASES_API } from "../lib/mobileRelease";

const CHECK_TIMEOUT_MS = 10_000;

/**
 * Checks GitHub for a newer Android build. An APK cannot replace itself, so
 * "update" here means telling the user and handing them the download link.
 *
 * status: idle | checking | current | available | error
 */
export function useMobileUpdate({ enabled, currentVersion }) {
  const [state, setState] = useState({ status: "idle", latest: null, error: null });
  const inFlight = useRef(null);

  const check = useCallback(async () => {
    if (!currentVersion) return;
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    const timer = window.setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
    setState((s) => ({ ...s, status: "checking", error: null }));
    try {
      const response = await fetch(RELEASES_API, {
        signal: controller.signal,
        headers: { Accept: "application/vnd.github+json" },
      });
      if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
      const latest = latestAndroidRelease(await response.json());
      const newer = latest && compareVersions(latest.version, currentVersion) > 0;
      setState({ status: newer ? "available" : "current", latest, error: null });
    } catch (error) {
      if (controller.signal.aborted && inFlight.current !== controller) return;
      const message = controller.signal.aborted ? "The update check timed out." : String(error?.message || error);
      console.error("Android update check failed:", message);
      setState({ status: "error", latest: null, error: message });
    } finally {
      window.clearTimeout(timer);
    }
  }, [currentVersion]);

  // Once per launch; a failure stays quiet until the user asks again.
  useEffect(() => {
    if (enabled && currentVersion) check();
    return () => inFlight.current?.abort();
  }, [enabled, currentVersion, check]);

  return { ...state, check };
}
