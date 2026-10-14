import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { PNG } from 'pngjs';

import {
  buildBaselineDiffReport,
  compareBaselinePair,
  filesToApply,
  filesToDelete,
  listBaselines,
  orphanEvidence,
  parseRegeneratedList,
  renameTarget,
  renderReportMarkdown,
  writeBaselineDiffReport,
} from './baseline-diff-report.ts';

type Paint = (x: number, y: number) => [number, number, number];

/** A 10x10 PNG; `deflateLevel` changes the bytes without changing the pixels. */
function png(paint: Paint, options: { size?: number; deflateLevel?: number } = {}): Buffer {
  const size = options.size ?? 10;
  const image = new PNG({ width: size, height: size });
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = (size * y + x) << 2;
      const [red, green, blue] = paint(x, y);
      image.data[index] = red;
      image.data[index + 1] = green;
      image.data[index + 2] = blue;
      image.data[index + 3] = 255;
    }
  }
  return PNG.sync.write(image, { deflateLevel: options.deflateLevel ?? 9 });
}

const white: Paint = () => [255, 255, 255];
/** Two of 100 pixels turn black: a 2% change. */
const twoBlack: Paint = (x, y) => (y === 0 && x < 2 ? [0, 0, 0] : [255, 255, 255]);

function write(root: string, path: string, bytes: Buffer): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), bytes);
}

describe('compareBaselinePair', () => {
  it('reports byte-identical images as unchanged', () => {
    expect(compareBaselinePair('a.png', png(white), png(white)).comparison).toEqual({
      path: 'a.png',
      kind: 'unchanged',
      byteIdentical: true,
    });
  });

  it('reports re-encoded but pixel-identical images as unchanged, not byte-identical', () => {
    const before = png(white, { deflateLevel: 9 });
    const after = png(white, { deflateLevel: 0 });
    expect(before.equals(after)).toBe(false);
    expect(compareBaselinePair('a.png', before, after).comparison).toEqual({
      path: 'a.png',
      kind: 'unchanged',
      byteIdentical: false,
    });
  });

  it('counts changed pixels against the new image area and returns a diff image', () => {
    const { comparison, diffImage } = compareBaselinePair('a.png', png(white), png(twoBlack));
    expect(comparison).toEqual({
      path: 'a.png',
      kind: 'changed',
      changedPixels: 2,
      totalPixels: 100,
      ratio: 0.02,
    });
    expect(diffImage).toBeInstanceOf(Buffer);
  });

  it('reports a dimension change without a ratio', () => {
    expect(compareBaselinePair('a.png', png(white), png(white, { size: 12 })).comparison).toEqual({
      path: 'a.png',
      kind: 'dimensions',
      oldSize: { width: 10, height: 10 },
      newSize: { width: 12, height: 12 },
    });
  });

  it('reports a baseline with no committed counterpart as added', () => {
    expect(compareBaselinePair('a.png', undefined, png(white)).comparison).toEqual({
      path: 'a.png',
      kind: 'added',
    });
  });
});

describe('buildBaselineDiffReport', () => {
  it('classifies a refresh and names exactly the files a commit writes and deletes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'baseline-diff-report-'));
    const oldDirectory = join(root, 'old');
    const newDirectory = join(root, 'new');
    write(oldDirectory, 'button/light-desktop-same.png', png(white));
    write(newDirectory, 'button/light-desktop-same.png', png(white));
    write(oldDirectory, 'button/light-desktop-reencoded.png', png(white, { deflateLevel: 9 }));
    write(newDirectory, 'button/light-desktop-reencoded.png', png(white, { deflateLevel: 0 }));
    write(oldDirectory, 'chip/light-desktop-changed.png', png(white));
    write(newDirectory, 'chip/light-desktop-changed.png', png(twoBlack));
    write(oldDirectory, 'chip/light-desktop-resized.png', png(white));
    write(newDirectory, 'chip/light-desktop-resized.png', png(white, { size: 12 }));
    write(newDirectory, 'tabs/light-desktop-added.png', png(white));
    // A cinder-era rename: `default` became `assertion`, once with the same pixels, once changed.
    write(oldDirectory, 'select/light-desktop-default.png', png(white));
    write(newDirectory, 'select/light-desktop-assertion.png', png(white));
    write(oldDirectory, 'input/dark-mobile-default.png', png(white));
    write(newDirectory, 'input/dark-mobile-assertion.png', png(twoBlack));
    // An orphan with no rename partner.
    write(oldDirectory, 'access-gate/light-desktop-inline-denied.png', png(white));

    const report = await buildBaselineDiffReport({
      oldDirectory,
      newDirectory,
      regenerated: [
        'button/light-desktop-same.png',
        'button/light-desktop-reencoded.png',
        'chip/light-desktop-changed.png',
        'chip/light-desktop-resized.png',
        'tabs/light-desktop-added.png',
        'select/light-desktop-assertion.png',
        'input/dark-mobile-assertion.png',
      ],
      diffDirectory: join(root, 'diffs'),
      namingSources: {
        manifestFixtures: new Map([['access-gate', ['assertion']]]),
        specText: "test('inline-granted', () => {});",
      },
    });

    expect(report.counts).toEqual({
      regenerated: 7,
      changed: 1,
      dimensionChanged: 1,
      unchanged: 2,
      byteIdentical: 1,
      added: 1,
      renamed: 2,
      renamedUnchanged: 1,
      renamedChanged: 1,
      deletedOrphans: 3,
      unpairedOrphans: 1,
      needsClassification: 3,
    });
    expect(
      report.renamed.map((rename) => [rename.from, rename.to, rename.comparison.kind]),
    ).toEqual([
      ['input/dark-mobile-default.png', 'input/dark-mobile-assertion.png', 'changed'],
      ['select/light-desktop-default.png', 'select/light-desktop-assertion.png', 'unchanged'],
    ]);
    expect(report.unpairedOrphans).toEqual([
      {
        path: 'access-gate/light-desktop-inline-denied.png',
        slug: 'access-gate',
        fixture: 'inline-denied',
        slugInManifest: true,
        fixtureInManifest: false,
        fixtureNamedInSpecs: false,
      },
    ]);
    expect(filesToApply(report)).toEqual([
      'chip/light-desktop-changed.png',
      'chip/light-desktop-resized.png',
      'input/dark-mobile-assertion.png',
      'select/light-desktop-assertion.png',
      'tabs/light-desktop-added.png',
    ]);
    expect(filesToDelete(report)).toEqual([
      'access-gate/light-desktop-inline-denied.png',
      'input/dark-mobile-default.png',
      'select/light-desktop-default.png',
    ]);
    expect(existsSync(join(root, 'diffs', 'chip/light-desktop-changed-diff.png'))).toBe(true);
    expect(existsSync(join(root, 'diffs', 'input/dark-mobile-assertion-diff.png'))).toBe(true);

    const suite = {
      exitCode: 1,
      results: {
        expected: 6,
        unexpected: 1,
        flaky: 0,
        skipped: 0,
        failures: [
          {
            title: 'tree.playwright.ts › windowing',
            file: 'tree.playwright.ts',
            line: 26,
            status: 'failed',
            errors: ['Error: row | missing'],
            screenshot: false,
          },
        ],
        flakyTests: [],
      },
      decision: { apply: true, reason: 'Applied with 1 accepted behavioural failure(s).' },
    };
    const markdown = renderReportMarkdown(report, 'Refresh', { suite });
    expect(markdown).toContain('| Changed (pixels) | 1 |');
    expect(markdown).toContain('| `chip/light-desktop-changed.png` | 2 | 2.000% | to classify |');
    expect(markdown).toContain(
      '| `chip/light-desktop-resized.png` | dimensions | 10x10 to 12x12 | to classify |',
    );
    expect(markdown).toContain('| `input/dark-mobile-assertion.png` | 2 | 2.000% | to classify |');
    expect(markdown).toContain('- `tabs/light-desktop-added.png`');
    expect(markdown).toContain(
      '- `select/light-desktop-default.png` renamed to `select/light-desktop-assertion.png`',
    );
    expect(markdown).toContain('| `access-gate/light-desktop-inline-denied.png` | yes | no | no |');
    expect(markdown).toContain(
      'Playwright exited 1. Applied with 1 accepted behavioural failure(s).',
    );
    expect(markdown).toContain(
      '| `tree.playwright.ts › windowing` | behavioural | Error: row \\| missing |',
    );

    const hostLoad = {
      start: { oneMinuteLoad: 11.5, logicalCpus: 10 },
      end: { oneMinuteLoad: 42, logicalCpus: 10 },
    };
    const written = await writeBaselineDiffReport(report, join(root, 'report'), 'Refresh', {
      hostLoad,
      suite,
    });
    const json = JSON.parse(readFileSync(written.json, 'utf8'));
    expect(json.counts.renamed).toBe(2);
    expect(json.hostLoad).toEqual(hostLoad);
    expect(json.suite.exitCode).toBe(1);
    expect(readFileSync(written.markdown, 'utf8')).toContain(
      'Host 1-minute load: 11.50 on 10 logical CPUs at the start of the run, 42.00 on 10 logical CPUs at the end.',
    );
    expect(markdown).not.toContain('Host 1-minute load');
  });

  it('marks a small change as below the classification threshold', async () => {
    const root = mkdtempSync(join(tmpdir(), 'baseline-diff-report-'));
    const one: Paint = (x, y) => (x === 0 && y === 0 ? [0, 0, 0] : [255, 255, 255]);
    write(join(root, 'old'), 'a.png', png(white, { size: 20 }));
    write(join(root, 'new'), 'a.png', png(one, { size: 20 }));
    const report = await buildBaselineDiffReport({
      oldDirectory: join(root, 'old'),
      newDirectory: join(root, 'new'),
      regenerated: ['a.png'],
    });
    expect(report.counts.needsClassification).toBe(0);
    expect(renderReportMarkdown(report, 'Refresh')).toContain('| 0.250% | below threshold |');
  });
});

describe('renames and orphan evidence', () => {
  it('maps only cinder-era default baselines to their assertion name', () => {
    expect(renameTarget('select/dark-mobile-default.png')).toBe('select/dark-mobile-assertion.png');
    expect(renameTarget('access-gate/dark-mobile-inline-denied.png')).toBeUndefined();
  });

  it('records whether the manifest or a spec still names an orphaned fixture', () => {
    const sources = {
      manifestFixtures: new Map([['popover', ['assertion', 'shell']]]),
      specText: "captureScreenshot(page, 'popover', 'transformed-ancestor-shell');",
    };
    expect(orphanEvidence('popover/light-desktop-shell.png', sources).fixtureInManifest).toBe(true);
    expect(
      orphanEvidence('popover/light-desktop-transformed-ancestor-shell.png', sources)
        .fixtureNamedInSpecs,
    ).toBe(true);
    expect(orphanEvidence('gone/light-desktop-x.png', sources)).toEqual({
      path: 'gone/light-desktop-x.png',
      slug: 'gone',
      fixture: 'x',
      slugInManifest: false,
      fixtureInManifest: false,
      fixtureNamedInSpecs: false,
    });
  });
});

describe('regenerated and listed baselines', () => {
  it('normalizes the container find output to baseline-relative paths', () => {
    const base = 'scripts/browser-fixtures/snapshots/chromium/linux';
    expect(
      parseRegeneratedList(
        `${base}/chip/b.png\n./${base}/button/a.png\n${base}/provenance.json\n\n${base}/chip/b.png\n`,
        base,
      ),
    ).toEqual(['button/a.png', 'chip/b.png']);
  });

  it('lists PNGs recursively and ignores other files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'baseline-diff-report-'));
    write(root, 'b/two.png', png(white));
    write(root, 'a/one.png', png(white));
    writeFileSync(join(root, 'provenance.json'), '{}');
    expect(await listBaselines(root)).toEqual(['a/one.png', 'b/two.png']);
    expect(await listBaselines(join(root, 'missing'))).toEqual([]);
  });
});
