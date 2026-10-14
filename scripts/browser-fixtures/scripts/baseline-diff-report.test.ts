import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { PNG } from 'pngjs';

import {
  buildBaselineDiffReport,
  compareBaselinePair,
  filesToApply,
  listBaselines,
  parseRegeneratedList,
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
  it('classifies a refresh and names only the files a commit should carry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'baseline-diff-report-'));
    const oldDirectory = join(root, 'old');
    const newDirectory = join(root, 'new');
    write(oldDirectory, 'button/same.png', png(white));
    write(newDirectory, 'button/same.png', png(white));
    write(oldDirectory, 'button/reencoded.png', png(white, { deflateLevel: 9 }));
    write(newDirectory, 'button/reencoded.png', png(white, { deflateLevel: 0 }));
    write(oldDirectory, 'chip/changed.png', png(white));
    write(newDirectory, 'chip/changed.png', png(twoBlack));
    write(oldDirectory, 'chip/resized.png', png(white));
    write(newDirectory, 'chip/resized.png', png(white, { size: 12 }));
    write(newDirectory, 'tabs/added.png', png(white));
    write(oldDirectory, 'tabs/orphan.png', png(white));
    write(newDirectory, 'tabs/orphan.png', png(white));

    const report = await buildBaselineDiffReport({
      oldDirectory,
      newDirectory,
      regenerated: [
        'button/same.png',
        'button/reencoded.png',
        'chip/changed.png',
        'chip/resized.png',
        'tabs/added.png',
      ],
      diffDirectory: join(root, 'diffs'),
    });

    expect(report.counts).toEqual({
      regenerated: 5,
      changed: 1,
      dimensionChanged: 1,
      unchanged: 2,
      byteIdentical: 1,
      added: 1,
      orphaned: 1,
      needsClassification: 2,
    });
    expect(report.orphaned).toEqual(['tabs/orphan.png']);
    expect(filesToApply(report)).toEqual([
      'chip/changed.png',
      'chip/resized.png',
      'tabs/added.png',
    ]);
    expect(existsSync(join(root, 'diffs', 'chip/changed-diff.png'))).toBe(true);

    const markdown = renderReportMarkdown(report, 'Refresh');
    expect(markdown).toContain('| Changed (pixels) | 1 |');
    expect(markdown).toContain('| `chip/changed.png` | 2 | 2.000% | to classify |');
    expect(markdown).toContain('- `chip/resized.png`: 10x10 to 12x12');
    expect(markdown).toContain('- `tabs/added.png`');
    expect(markdown).toContain('- `tabs/orphan.png`');

    const written = await writeBaselineDiffReport(report, join(root, 'report'), 'Refresh');
    expect(JSON.parse(readFileSync(written.json, 'utf8')).counts.changed).toBe(1);
    expect(readFileSync(written.markdown, 'utf8')).toBe(markdown);
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
