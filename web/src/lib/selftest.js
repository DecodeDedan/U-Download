import { invoke } from "@tauri-apps/api/core";

/**
 * The webview half of `--self-test` (see src/selftest.rs). It uses the real
 * interface the way a person would: clicks the navigation, types a link into
 * the command bar, presses Download, and reads the on-screen readouts while
 * the file comes in. Nothing here runs unless the app was started with the
 * option.
 */

const STEP_TIMEOUT_MS = 15000;
const DOWNLOAD_TIMEOUT_MS = 90000;
const POLL_MS = 100;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check, timeout = STEP_TIMEOUT_MS) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = check();
    if (value) return value;
    await sleep(POLL_MS);
  }
  return null;
}

const $ = (selector) => document.querySelector(selector);

/** Types into a React-controlled input the way the keyboard would. */
function typeInto(input, text) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function moveStep() {
  const visited = [];
  for (const [nav, heading] of [["search", "#search-heading"], ["settings", "#settings-heading"], ["downloads", "#tasks-heading"]]) {
    const button = await waitFor(() => $(`[data-testid="nav-${nav}"]`));
    if (!button) return { step: "move", passed: false, detail: `no ${nav} button in the navigation` };
    button.click();
    const shown = await waitFor(() => $(heading));
    if (!shown) return { step: "move", passed: false, detail: `pressing ${nav} did not open its view` };
    visited.push(nav);
  }
  return { step: "move", passed: true, detail: `navigated ${visited.join(" → ")} through the real buttons` };
}

async function actAndWatch(config, setOutputFolder) {
  setOutputFolder(config.folder);
  const input = await waitFor(() => $('[data-testid="command-input"]'));
  if (!input) {
    return [
      { step: "act", passed: false, detail: "the command bar never appeared" },
      { step: "hud", passed: false, detail: "nothing to read" },
    ];
  }
  typeInto(input, config.url);
  const chip = await waitFor(() => {
    const el = $('[data-testid="kind-chip"]');
    return el && el.textContent === "Direct file" ? el : null;
  });
  const go = await waitFor(() => {
    const el = $('[data-testid="command-go"]');
    return el && !el.disabled ? el : null;
  });
  if (!go) {
    return [
      { step: "act", passed: false, detail: "the Download button stayed disabled" },
      { step: "hud", passed: false, detail: "nothing to read" },
    ];
  }
  go.click();

  const seen = { speed: false, connections: 0, pieces: 0, tasks: 0, pictured: false };
  const started = Date.now();
  const done = await waitFor(() => {
    const speed = $('[data-testid="hud-speed"]')?.textContent || "";
    if (/[1-9]/.test(speed)) seen.speed = true;
    seen.connections = Math.max(seen.connections, Number($('[data-testid="hud-connections"]')?.textContent) || 0);
    seen.tasks = Math.max(seen.tasks, Number($('[data-testid="hud-tasks"]')?.textContent) || 0);
    seen.pieces = Math.max(seen.pieces, document.querySelectorAll(".pieces__cell").length);
    if (config.snapshot && !seen.pictured && seen.pieces > 0 && seen.connections > 1) {
      seen.pictured = true;
      invoke("selftest_snapshot").catch((error) => console.error("Mid-download picture failed:", error));
    }
    const failed = $('[data-testid="task"][data-status="failed"]');
    if (failed) return { failed: failed.textContent };
    // Finished tasks leave the Active tab, so look in Done.
    const doneTab = $('[data-testid="tab-done"]');
    if (doneTab && /[1-9]/.test(doneTab.textContent)) return { ok: true };
    return null;
  }, DOWNLOAD_TIMEOUT_MS);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  const act = !done
    ? { step: "act", passed: false, detail: `the download did not finish within ${DOWNLOAD_TIMEOUT_MS / 1000}s` }
    : done.failed
      ? { step: "act", passed: false, detail: `the download failed: ${done.failed}` }
      : {
        step: "act",
        passed: true,
        detail: `pasted a link (detected as ${chip ? "Direct file" : "unknown"}), pressed Download, finished in ${seconds}s`,
      };
  const hud = {
    step: "hud",
    passed: seen.speed && seen.connections > 1 && seen.pieces > 0 && seen.tasks > 0,
    detail: `live speed ${seen.speed ? "shown" : "never shown"}, up to ${seen.connections} connections and ${seen.tasks} task(s) on the core, piece map with ${seen.pieces} cells`,
  };
  return [act, hud];
}

/** Runs the test when the backend says one is running; otherwise does nothing. */
export async function runSelfTestIfRequested({ setOutputFolder, currentFolder }) {
  let config = null;
  try {
    config = await invoke("selftest_config");
  } catch (error) {
    console.error("Self-test check failed:", error);
    return;
  }
  if (!config) return;
  const steps = [];
  const folderBefore = currentFolder();
  try {
    steps.push(await moveStep());
    steps.push(...(await actAndWatch(config, setOutputFolder)));
  } catch (error) {
    steps.push({ step: "act", passed: false, detail: `the test crashed: ${error}` });
  }
  for (const name of ["move", "act", "hud"]) {
    if (!steps.some((s) => s.step === name)) steps.push({ step: name, passed: false, detail: "not reached" });
  }
  // The person's own folder comes back before the app exits.
  setOutputFolder(folderBefore);
  await sleep(POLL_MS);
  await invoke("selftest_finish", { steps });
}
