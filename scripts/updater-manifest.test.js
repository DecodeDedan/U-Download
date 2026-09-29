import { describe, expect, it } from 'vitest';
import { buildManifest, platformForSignature } from './updater-manifest.mjs';

const base = 'https://github.com/DecodeDedan/U-Download/releases/download/v3.1.0';

describe('platformForSignature', () => {
  it.each([
    ['U-Download_3.1.0_aarch64.app.tar.gz.sig', 'darwin-aarch64'],
    ['U-Download_3.1.0_x64.app.tar.gz.sig', 'darwin-x86_64'],
    ['U-Download_3.1.0_amd64.AppImage.sig', 'linux-x86_64'],
    ['U-Download_3.1.0_aarch64.AppImage.sig', 'linux-aarch64'],
    ['U-Download_3.1.0_x64-setup.exe.sig', 'windows-x86_64'],
  ])('maps %s to %s', (name, platform) => {
    expect(platformForSignature(name)).toBe(platform);
  });

  it('ignores signatures the updater cannot install from', () => {
    expect(platformForSignature('U-Download_3.1.0_amd64.deb.sig')).toBeNull();
    expect(platformForSignature('U-Download-3.1.0-1.x86_64.rpm.sig')).toBeNull();
    expect(platformForSignature('U-Download_3.1.0_x64.dmg')).toBeNull();
  });
});

describe('buildManifest', () => {
  const sigs = [
    { name: 'U-Download_3.1.0_x64.app.tar.gz.sig', signature: 'sig-mac-x64\n' },
    { name: 'U-Download_3.1.0_x64-setup.exe.sig', signature: 'sig-win' },
    { name: 'U-Download_3.1.0_amd64.deb.sig', signature: 'ignored' },
  ];

  it('points each platform at its asset and inlines the trimmed signature', () => {
    const manifest = buildManifest({
      version: 'v3.1.0',
      notes: 'Notes',
      pubDate: '2026-09-29T00:00:00.000Z',
      baseUrl: base,
      sigs,
    });

    expect(manifest).toEqual({
      version: '3.1.0',
      notes: 'Notes',
      pub_date: '2026-09-29T00:00:00.000Z',
      platforms: {
        'darwin-x86_64': { signature: 'sig-mac-x64', url: `${base}/U-Download_3.1.0_x64.app.tar.gz` },
        'windows-x86_64': { signature: 'sig-win', url: `${base}/U-Download_3.1.0_x64-setup.exe` },
      },
    });
  });

  it('refuses two signatures claiming the same platform', () => {
    const clash = [...sigs, { name: 'U-Download_3.1.0_x64-setup.exe.sig', signature: 'again' }];
    expect(() =>
      buildManifest({ version: '3.1.0', notes: '', pubDate: 'x', baseUrl: base, sigs: clash }),
    ).toThrow(/windows-x86_64/);
  });

  it('refuses a release with no installable platform', () => {
    expect(() =>
      buildManifest({ version: '3.1.0', notes: '', pubDate: 'x', baseUrl: base, sigs: [] }),
    ).toThrow(/no updater signatures/i);
  });
});
