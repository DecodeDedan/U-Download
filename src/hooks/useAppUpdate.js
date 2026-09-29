import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Self-update from GitHub Releases, with no action required from the user.
 *
 * GitHub cannot push to an installed copy, so this asks: shortly after launch,
 * every 15 minutes, and when the window regains focus or the network returns.
 * A newer signed release is downloaded in the background and installed the
 * moment no download is running; installing restarts the app, and restarting
 * mid-download would kill yt-dlp/ffmpeg and lose the partial file.
 *
 * States: idle → downloading → ready (waiting for the queue) → installing.
 * A failure returns to idle via `error`, and the next check tries again.
 */

const FIRST_CHECK_DELAY_MS = 3_000;
const CHECK_EVERY_MS = 15 * 60 * 1000;
// Focus and reconnect fire in bursts; one check a minute is plenty.
const MIN_GAP_MS = 60 * 1000;

const reason = (cause) => (cause instanceof Error ? cause.message : String(cause));

/**
 * @param {{ enabled: boolean, busy: boolean }} options
 *   enabled: false in dev builds and on Android, which have nothing to replace.
 *   busy: true while any download job is active.
 */
export function useAppUpdate({ enabled, busy }) {
  const [state, setState] = useState({ phase: 'idle', version: null, percent: null, error: null });
  const updateRef = useRef(null);

  const install = useCallback(async () => {
    const update = updateRef.current;
    if (!update) return;
    updateRef.current = null;
    setState((s) => ({ ...s, phase: 'installing' }));
    try {
      await update.install();
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    } catch (cause) {
      console.error('Update install failed:', cause);
      setState({ phase: 'idle', version: null, percent: null, error: `Update failed to install: ${reason(cause)}` });
    }
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;

    let cancelled = false;
    let inFlight = false;
    let lastCheck = 0;

    async function checkAndDownload() {
      if (inFlight || updateRef.current || Date.now() - lastCheck < MIN_GAP_MS) return;
      inFlight = true;
      lastCheck = Date.now();
      try {
        const { check } = await import('@tauri-apps/plugin-updater');
        const update = await check();
        if (!update || cancelled) return;

        let total = 0;
        let received = 0;
        setState({ phase: 'downloading', version: update.version, percent: null, error: null });
        await update.download((event) => {
          if (cancelled) return;
          if (event.event === 'Started') total = event.data.contentLength ?? 0;
          if (event.event === 'Progress') {
            received += event.data.chunkLength;
            const percent = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null;
            setState((s) => ({ ...s, percent }));
          }
        });
        if (cancelled) return;
        updateRef.current = update;
        setState((s) => ({ ...s, phase: 'ready', percent: 100 }));
      } catch (cause) {
        // Offline or GitHub unreachable: the app works without it and the next
        // check retries, so this is logged, not shown.
        console.error('Update check failed:', cause);
        if (!cancelled) setState({ phase: 'idle', version: null, percent: null, error: null });
      } finally {
        inFlight = false;
      }
    }

    const run = () => void checkAndDownload();
    const first = setTimeout(run, FIRST_CHECK_DELAY_MS);
    const repeat = setInterval(run, CHECK_EVERY_MS);
    window.addEventListener('focus', run);
    window.addEventListener('online', run);
    return () => {
      cancelled = true;
      clearTimeout(first);
      clearInterval(repeat);
      window.removeEventListener('focus', run);
      window.removeEventListener('online', run);
    };
  }, [enabled]);

  // Apply as soon as the queue is idle: at once if nothing is downloading,
  // otherwise right after the last active job settles.
  useEffect(() => {
    if (state.phase === 'ready' && !busy) void install();
  }, [state.phase, busy, install]);

  const dismissError = useCallback(() => setState((s) => ({ ...s, error: null })), []);

  return { ...state, installNow: install, dismissError };
}
