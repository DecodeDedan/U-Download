#!/usr/bin/env node
//
// Builds the `latest.json` the Tauri updater polls, from the `.sig` files the
// release matrix uploaded. One job writing it after every build finishes
// replaces tauri-action's per-job read-merge-write of the same asset, which
// races when five platform jobs finish close together and silently drops a
// platform.
//
// Usage: node scripts/updater-manifest.mjs <sig-dir> <tag> <base-url> <notes-file> <out-file>

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Only formats the updater can install from. deb/rpm/dmg are for first
// installs; the updater replaces the .app, the AppImage, or reruns NSIS.
const RULES = [
  { suffix: '.app.tar.gz.sig', arch: [['aarch64', 'darwin-aarch64'], ['x64', 'darwin-x86_64'], ['x86_64', 'darwin-x86_64']] },
  { suffix: '.AppImage.sig', arch: [['aarch64', 'linux-aarch64'], ['amd64', 'linux-x86_64'], ['x86_64', 'linux-x86_64']] },
  { suffix: '-setup.exe.sig', arch: [['x64', 'windows-x86_64']] },
];

export function platformForSignature(name) {
  const rule = RULES.find((r) => name.endsWith(r.suffix));
  const match = rule?.arch.find(([token]) => name.includes(token));
  return match ? match[1] : null;
}

export function buildManifest({ version, notes, pubDate, baseUrl, sigs }) {
  const platforms = {};
  for (const { name, signature } of sigs) {
    const platform = platformForSignature(name);
    if (!platform) continue;
    if (platforms[platform]) {
      throw new Error(`Two signatures claim ${platform}: ${name} and ${platforms[platform].url}`);
    }
    platforms[platform] = { signature: signature.trim(), url: `${baseUrl}/${name.slice(0, -'.sig'.length)}` };
  }
  if (Object.keys(platforms).length === 0) {
    throw new Error('No updater signatures found; is TAURI_SIGNING_PRIVATE_KEY set for the build?');
  }
  return { version: version.replace(/^v/, ''), notes, pub_date: pubDate, platforms };
}

function main([sigDir, tag, baseUrl, notesFile, outFile]) {
  if (!outFile) {
    throw new Error('Usage: updater-manifest.mjs <sig-dir> <tag> <base-url> <notes-file> <out-file>');
  }
  const sigs = readdirSync(sigDir)
    .filter((name) => name.endsWith('.sig'))
    .map((name) => ({ name, signature: readFileSync(join(sigDir, name), 'utf8') }));
  const manifest = buildManifest({
    version: tag,
    notes: readFileSync(notesFile, 'utf8'),
    pubDate: new Date().toISOString(),
    baseUrl,
    sigs,
  });
  writeFileSync(outFile, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stderr.write(`latest.json: ${Object.keys(manifest.platforms).join(', ')}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
