import { describe, expect, it } from "vitest";
import { compareVersions, latestAndroidRelease } from "./mobileRelease";

const release = (tag, extra = {}) => ({
  tag_name: tag,
  draft: false,
  prerelease: false,
  html_url: `https://github.com/o/r/releases/tag/${tag}`,
  ...extra,
});

describe("compareVersions", () => {
  it("orders by major, then minor, then patch numerically", () => {
    expect(compareVersions("1.0.10", "1.0.9")).toBeGreaterThan(0);
    expect(compareVersions("1.2.0", "1.10.0")).toBeLessThan(0);
    expect(compareVersions("2.0.0", "1.99.99")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  it("returns null for anything that is not MAJOR.MINOR.PATCH", () => {
    expect(compareVersions("1.0", "1.0.0")).toBeNull();
    expect(compareVersions("dev", "1.0.0")).toBeNull();
  });
});

describe("latestAndroidRelease", () => {
  it("picks the highest android-v release, ignoring desktop tags", () => {
    const latest = latestAndroidRelease([
      release("v3.0.4"),
      release("android-v1.0.0"),
      release("android-v1.2.0"),
      release("android-v1.10.0"),
      release("android-latest"),
    ]);
    expect(latest).toEqual({
      version: "1.10.0",
      pageUrl: "https://github.com/o/r/releases/tag/android-v1.10.0",
    });
  });

  it("skips drafts and prereleases", () => {
    const latest = latestAndroidRelease([
      release("android-v1.0.0"),
      release("android-v1.1.0", { draft: true }),
      release("android-v1.2.0", { prerelease: true }),
    ]);
    expect(latest?.version).toBe("1.0.0");
  });

  it("returns null when there is no Android release or the payload is not a list", () => {
    expect(latestAndroidRelease([release("v3.0.4")])).toBeNull();
    expect(latestAndroidRelease({ message: "API rate limit exceeded" })).toBeNull();
    expect(latestAndroidRelease(null)).toBeNull();
  });
});
