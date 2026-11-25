// Where the Android app is published, and how a newer build is recognised.
// Android releases live on their own tags (android-vX.Y.Z), apart from the
// desktop line, so "is there an update" means "is there a higher android-v
// tag" — never GitHub's "latest" release, which belongs to desktop.

export const REPO = "DecodeDedan/U-Download";
export const RELEASES_API = `https://api.github.com/repos/${REPO}/releases?per_page=30`;
/** Always the newest Android build; see .github/workflows/release-android.yml. */
export const APK_DOWNLOAD_URL = `https://github.com/${REPO}/releases/download/android-latest/U-Download-Android.apk`;
export const ISSUES_URL = `https://github.com/${REPO}/issues/new`;
export const SOURCE_URL = `https://github.com/${REPO}`;
export const DEVELOPER_URL = "https://okwaretech.com";

const TAG_PREFIX = "android-v";
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * Compares two MAJOR.MINOR.PATCH strings numerically.
 * @returns {number | null} <0, 0 or >0; null when either is not a version.
 */
export function compareVersions(a, b) {
  const pa = SEMVER.exec(String(a));
  const pb = SEMVER.exec(String(b));
  if (!pa || !pb) return null;
  for (let i = 1; i <= 3; i += 1) {
    const diff = Number(pa[i]) - Number(pb[i]);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * The newest published Android release in a GitHub releases payload.
 * @param {unknown} releases the parsed response of RELEASES_API
 * @returns {{ version: string, pageUrl: string } | null}
 */
export function latestAndroidRelease(releases) {
  if (!Array.isArray(releases)) return null;
  return releases
    .filter((r) => r && !r.draft && !r.prerelease && typeof r.tag_name === "string")
    .filter((r) => r.tag_name.startsWith(TAG_PREFIX))
    .map((r) => ({ version: r.tag_name.slice(TAG_PREFIX.length), pageUrl: r.html_url }))
    .filter((r) => SEMVER.test(r.version))
    .reduce((best, r) => (best === null || compareVersions(r.version, best.version) > 0 ? r : best), null);
}
