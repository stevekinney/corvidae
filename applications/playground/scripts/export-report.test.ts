import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createExportReport,
  parseExportReport,
  peakResidentSetBytes,
  readSourceRevision,
} from './export-report.ts';
import {
  buildDigestOf,
  createDigestManifest,
  serializeDigestManifest,
} from './static-playground-digest.ts';

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

describe('peak resident set', () => {
  it('converts resourceUsage().maxRSS kibibytes to bytes', () => {
    expect(peakResidentSetBytes(1)).toBe(1024);
    expect(peakResidentSetBytes(401_424)).toBe(411_058_176);
  });

  it('reads a live maxRSS in kibibytes, at or above the current resident set in bytes / 1024 / 2', () => {
    // A unit mistake is off by a factor of 1024, far outside this factor-of-two band.
    const kibibytes = process.resourceUsage().maxRSS;
    expect(peakResidentSetBytes(kibibytes)).toBeGreaterThanOrEqual(process.memoryUsage().rss / 2);
  });
});

describe('source revision', () => {
  it('prefers the Vercel commit SHA and reports a dirty tree', () => {
    expect(
      readSourceRevision('v'.repeat(40), (args) => (args[0] === 'status' ? ' M a' : 'h')),
    ).toEqual({ sourceSha: 'v'.repeat(40), dirty: true });
  });

  it('falls back to git HEAD and a clean tree', () => {
    expect(readSourceRevision(undefined, (args) => (args[0] === 'status' ? '' : 'h'))).toEqual({
      sourceSha: 'h',
      dirty: false,
    });
  });

  it('records null instead of throwing when git is unavailable', () => {
    expect(readSourceRevision(undefined, () => null)).toEqual({ sourceSha: null, dirty: null });
  });
});

describe('build digest', () => {
  it('hashes every file by POSIX path, sorted, as sha256sum lines', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'static-digest-'));
    try {
      await mkdir(join(directory, 'page', 'b'), { recursive: true });
      await writeFile(join(directory, 'page', 'b', 'index.html'), '');
      await writeFile(join(directory, 'Z.txt'), '');
      await writeFile(join(directory, 'a.txt'), '');

      const manifest = await createDigestManifest(directory);

      expect(serializeDigestManifest(manifest)).toBe(
        `${EMPTY_SHA256}  Z.txt\n${EMPTY_SHA256}  a.txt\n${EMPTY_SHA256}  page/b/index.html\n`,
      );
      const expected = new Bun.CryptoHasher('sha256')
        .update(serializeDigestManifest(manifest))
        .digest('hex');
      expect(buildDigestOf(manifest)).toBe(expected);

      const report = await createExportReport({
        directory,
        routes: ['/'],
        exportDurationMilliseconds: 10,
        maximumResidentSetKibibytes: 2,
        revision: { sourceSha: 'h', dirty: false },
        nodeEnv: 'production',
      });
      expect(report).toEqual({
        version: 1,
        routes: ['/'],
        sourceSha: 'h',
        dirty: false,
        nodeEnv: 'production',
        exportDurationMilliseconds: 10,
        peakResidentSetBytes: 2048,
        buildDigest: expected,
      });
      expect(parseExportReport(JSON.parse(JSON.stringify(report)))).toEqual(report);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('names every invalid report field', () => {
    expect(() => parseExportReport({ version: 2, routes: [1], buildDigest: 'x' })).toThrow(
      'version, routes, sourceSha, dirty, nodeEnv, exportDurationMilliseconds, peakResidentSetBytes, buildDigest',
    );
  });
});
