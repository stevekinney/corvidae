import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  artifactGroup,
  artifactMapFootprint,
  parseServerPrebuildSummary,
  parseSitemapRoutes,
  parseStaticExportSummary,
  readArtifactFiles,
  summarizeArtifacts,
} from './measure-playground-inventory.ts';

describe('parseSitemapRoutes', () => {
  it('returns each listed pathname in order', () => {
    const sitemap = `<?xml version="1.0"?><urlset>
      <url><loc>https://cinder.website/</loc></url>
      <url><loc>https://cinder.website/page/button</loc></url>
    </urlset>`;
    expect(parseSitemapRoutes(sitemap)).toEqual(['/', '/page/button']);
  });
});

describe('artifactGroup', () => {
  it('groups by top-level directory and extension', () => {
    expect(artifactGroup('page-bundle/chunk-abc123.js')).toBe('page-bundle:.js');
    expect(artifactGroup('page/button/index.html')).toBe('page:.html');
    expect(artifactGroup('robots.txt')).toBe('(root):.txt');
    expect(artifactGroup('api/manifest/button')).toBe('api:(none)');
  });
});

describe('summarizeArtifacts', () => {
  it('counts identical bytes once in the unique totals', () => {
    const inventory = summarizeArtifacts([
      { relativePath: 'page-bundle/a.js', bytes: 10, sha256: 'x' },
      { relativePath: 'shell-bundle/a.js', bytes: 10, sha256: 'x' },
      { relativePath: 'index.html', bytes: 5, sha256: 'y' },
    ]);
    expect(inventory).toEqual({
      fileCount: 3,
      totalBytes: 25,
      uniqueContentCount: 2,
      uniqueContentBytes: 15,
      groups: {
        '(root):.html': { files: 1, bytes: 5 },
        'page-bundle:.js': { files: 1, bytes: 10 },
        'shell-bundle:.js': { files: 1, bytes: 10 },
      },
    });
  });
});

describe('readArtifactFiles', () => {
  let directory: string | undefined;
  afterEach(async () => {
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  });

  it('hashes and sizes every nested file with a forward-slash relative path', async () => {
    directory = await mkdtemp(join(tmpdir(), 'measure-playground-inventory-'));
    await mkdir(join(directory, 'page-bundle'));
    await writeFile(join(directory, 'page-bundle', 'a.js'), 'abc');
    await writeFile(join(directory, 'index.html'), 'é');
    const files = await readArtifactFiles(directory);
    expect(files.map(({ relativePath, bytes }) => ({ relativePath, bytes }))).toEqual([
      { relativePath: 'index.html', bytes: 2 },
      { relativePath: 'page-bundle/a.js', bytes: 3 },
    ]);
  });
});

describe('summary line parsers', () => {
  it('reads the exporter closing line', () => {
    expect(
      parseStaticExportSummary(
        '[static-export] rendered 4210 files for 161 components in 212.4s\n',
      ),
    ).toEqual({ renderedFiles: 4210, sidebarComponents: 161, reportedSeconds: 212.4 });
    expect(parseStaticExportSummary('nothing')).toBeNull();
  });

  it('reads the server prebuild line', () => {
    expect(
      parseServerPrebuildSummary(
        '[playground] Pre-built 160/161 page bundles (failed: x) (peak resident 2048 MB)\n',
      ),
    ).toEqual({ succeeded: 160, total: 161, selfReportedPeakResidentMegabytes: 2048 });
  });
});

describe('artifactMapFootprint', () => {
  it('counts entries and UTF-8 bytes', () => {
    expect(
      artifactMapFootprint(
        new Map([
          ['a.js', 'ab'],
          ['b.js', 'é'],
        ]),
      ),
    ).toEqual({ entries: 2, bytes: 4 });
  });
});
