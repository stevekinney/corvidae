import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BoundaryError,
  capture,
  normalizeConfiguration,
  normalizeRelativePath,
  parseCommandLine,
  readManifest,
  UsageError,
  verify,
  type Accounting,
  type Manifest,
} from './review-boundary.ts';

let scratchRoot: string;

beforeEach(() => {
  scratchRoot = mkdtempSync(join(tmpdir(), 'review-boundary-test-'));
});

afterEach(() => {
  rmSync(scratchRoot, { recursive: true, force: true });
});

function writeFile(relativePath: string, contents: string) {
  const absolute = join(scratchRoot, relativePath);
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, contents);
}

function captureBoundary(directories: string[], exclusions: string[] = []) {
  const outputPath = join(scratchRoot, '..', `${Math.random().toString(36).slice(2)}.json`);
  const manifest = capture({ root: scratchRoot, directories, exclusions }, outputPath);
  return { manifest, outputPath };
}

describe('normalizeRelativePath', () => {
  test('rejects absolute paths', () => {
    expect(() => normalizeRelativePath('/etc/passwd')).toThrow(BoundaryError);
  });
  test('rejects empty strings', () => {
    expect(() => normalizeRelativePath('')).toThrow(BoundaryError);
  });
  test('rejects dot-dot components', () => {
    expect(() => normalizeRelativePath('src/../secret')).toThrow(BoundaryError);
  });
  test('rejects backslashes', () => {
    expect(() => normalizeRelativePath('src\\file.ts')).toThrow(BoundaryError);
  });
  test("permits '.' only when allowed explicitly", () => {
    expect(() => normalizeRelativePath('.')).toThrow(BoundaryError);
    expect(normalizeRelativePath('.', { allowDotAsWhole: true })).toBe('.');
  });
});

describe('normalizeConfiguration', () => {
  test('collapses nested directories into their ancestor', () => {
    writeFile('src/a.ts', 'a');
    const normalized = normalizeConfiguration({
      root: scratchRoot,
      directories: ['src', 'src/nested'],
      exclusions: [],
    });
    expect(normalized.directories).toEqual(['src']);
  });

  test('dedupes and sorts directories and exclusions', () => {
    writeFile('a/x.ts', '1');
    writeFile('b/y.ts', '2');
    const normalized = normalizeConfiguration({
      root: scratchRoot,
      directories: ['b', 'a', 'a'],
      exclusions: ['b/y.ts', 'a/x.ts', 'a/x.ts'],
    });
    expect(normalized.directories).toEqual(['a', 'b']);
    expect(normalized.exclusions).toEqual(['a/x.ts', 'b/y.ts']);
  });
});

describe('capture', () => {
  test('records hashes for every included file', () => {
    writeFile('src/a.ts', 'hello');
    writeFile('src/b.ts', 'world');
    const { manifest } = captureBoundary(['src']);
    expect(manifest.files.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(manifest.files[0]?.sha256).toHaveLength(64);
  });

  test('excludes declared paths and their descendants', () => {
    writeFile('src/a.ts', 'hello');
    writeFile('node_modules/pkg/index.js', 'ignored');
    const { manifest } = captureBoundary(['.'], ['node_modules']);
    expect(manifest.files.map((f) => f.path)).toEqual(['src/a.ts']);
  });

  test('permits an excluded path that does not exist on disk', () => {
    writeFile('src/a.ts', 'hello');
    const { manifest } = captureBoundary(['src'], ['src/does-not-exist.ts']);
    expect(manifest.files.map((f) => f.path)).toEqual(['src/a.ts']);
  });

  test('fails on an escaping symlink without mutating fixture content', () => {
    writeFile('src/a.ts', 'hello');
    const outsideTarget = join(scratchRoot, '..', 'outside-target.txt');
    writeFileSync(outsideTarget, 'outside');
    symlinkSync(outsideTarget, join(scratchRoot, 'src', 'escape-link'));

    const outputPath = join(scratchRoot, '..', 'escape-manifest.json');
    expect(() =>
      capture({ root: scratchRoot, directories: ['src'], exclusions: [] }, outputPath),
    ).toThrow(BoundaryError);
    expect(existsSync(outputPath)).toBe(false);
    expect(existsSync(join(scratchRoot, 'src', 'a.ts'))).toBe(true);
  });

  test("excluding a symlink's path lets capture succeed", () => {
    writeFile('src/a.ts', 'hello');
    symlinkSync(join(scratchRoot, 'src', 'a.ts'), join(scratchRoot, 'node_modules_link'));
    const { manifest } = captureBoundary(['.'], ['node_modules_link']);
    expect(manifest.files.map((f) => f.path)).toEqual(['src/a.ts']);
  });

  test('rejects an output path inside the included boundary', () => {
    writeFile('src/a.ts', 'hello');
    const insideOutput = join(scratchRoot, 'src', 'manifest.json');
    expect(() =>
      capture({ root: scratchRoot, directories: ['src'], exclusions: [] }, insideOutput),
    ).toThrow(BoundaryError);
  });

  test('never overwrites an existing evidence file', () => {
    writeFile('src/a.ts', 'hello');
    const { outputPath } = captureBoundary(['src']);
    expect(() =>
      capture({ root: scratchRoot, directories: ['src'], exclusions: [] }, outputPath),
    ).toThrow(BoundaryError);
  });
});

describe('verify', () => {
  test('passes on an unchanged boundary', () => {
    writeFile('src/a.ts', 'hello');
    const { manifest } = captureBoundary(['src']);
    const report = verify({ root: scratchRoot, directories: ['src'], exclusions: [] }, manifest);
    expect(report.errors).toEqual([]);
    expect(report.removed).toEqual([]);
  });

  test('reports a harmless addition without failing', () => {
    writeFile('src/a.ts', 'hello');
    const { manifest } = captureBoundary(['src']);
    writeFile('src/b.ts', 'new file');
    const report = verify({ root: scratchRoot, directories: ['src'], exclusions: [] }, manifest);
    expect(report.errors).toEqual([]);
    expect(report.added).toEqual(['src/b.ts']);
  });

  test("fails on an adjacent deleted file even if it wasn't in the focused command", () => {
    writeFile('src/tree.ts', 'tree');
    writeFile('src/tree.test.ts', 'tree test');
    writeFile('src/navigation-bar.ts', 'nav');
    const { manifest } = captureBoundary(['src']);

    // Simulate a "focused" split that only touches tree.ts, silently dropping navigation-bar.ts.
    rmSync(join(scratchRoot, 'src', 'navigation-bar.ts'));

    const report = verify({ root: scratchRoot, directories: ['src'], exclusions: [] }, manifest);
    expect(report.unaccounted).toEqual(['src/navigation-bar.ts']);
    expect(report.errors.length).toBeGreaterThan(0);
  });

  test('accepts an explicit valid move', () => {
    writeFile('src/old-name.ts', 'content');
    const { manifest } = captureBoundary(['src']);
    rmSync(join(scratchRoot, 'src', 'old-name.ts'));
    writeFile('src/new-name.ts', 'content');

    const accounting: Accounting = {
      captureId: manifest.captureId,
      removals: [],
      moves: [
        {
          from: 'src/old-name.ts',
          to: ['src/new-name.ts'],
          reason: 'renamed for clarity',
        },
      ],
    };
    const report = verify(
      { root: scratchRoot, directories: ['src'], exclusions: [] },
      manifest,
      accounting,
    );
    expect(report.errors).toEqual([]);
    expect(report.unaccounted).toEqual([]);
    expect(report.accounted).toEqual(['src/old-name.ts']);
  });

  test("fails when a move's destination is absent", () => {
    writeFile('src/old-name.ts', 'content');
    const { manifest } = captureBoundary(['src']);
    rmSync(join(scratchRoot, 'src', 'old-name.ts'));

    const accounting: Accounting = {
      captureId: manifest.captureId,
      removals: [],
      moves: [
        {
          from: 'src/old-name.ts',
          to: ['src/never-created.ts'],
          reason: 'renamed',
        },
      ],
    };
    const report = verify(
      { root: scratchRoot, directories: ['src'], exclusions: [] },
      manifest,
      accounting,
    );
    expect(report.errors.length).toBeGreaterThan(0);
    expect(report.unaccounted).toEqual(['src/old-name.ts']);
  });

  test('fails verification against the wrong root', () => {
    writeFile('src/a.ts', 'hello');
    const { manifest } = captureBoundary(['src']);
    const otherRoot = mkdtempSync(join(tmpdir(), 'review-boundary-other-root-'));
    mkdirSync(join(otherRoot, 'src'), { recursive: true });
    writeFileSync(join(otherRoot, 'src', 'a.ts'), 'hello');
    try {
      const report = verify({ root: otherRoot, directories: ['src'], exclusions: [] }, manifest);
      expect(report.errors.length).toBeGreaterThan(0);
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  test('rejects an accounting document with a different captureId', () => {
    writeFile('src/a.ts', 'hello');
    const { manifest } = captureBoundary(['src']);
    rmSync(join(scratchRoot, 'src', 'a.ts'));
    const accounting: Accounting = {
      captureId: 'not-the-real-capture-id',
      removals: [{ path: 'src/a.ts', reason: 'cleanup' }],
      moves: [],
    };
    const report = verify(
      { root: scratchRoot, directories: ['src'], exclusions: [] },
      manifest,
      accounting,
    );
    expect(report.errors.length).toBeGreaterThan(0);
    expect(report.unaccounted).toEqual(['src/a.ts']);
  });

  test('fails on an escaping symlink introduced after capture', () => {
    writeFile('src/a.ts', 'hello');
    const { manifest } = captureBoundary(['src']);
    const outsideTarget = join(scratchRoot, '..', 'outside-target-2.txt');
    writeFileSync(outsideTarget, 'outside');
    symlinkSync(outsideTarget, join(scratchRoot, 'src', 'escape-link'));

    const report = verify({ root: scratchRoot, directories: ['src'], exclusions: [] }, manifest);
    expect(report.errors.some((e) => e.includes('symlink'))).toBe(true);
  });
});

describe('evidence file overwrite protection', () => {
  test('an existing evidence path is refused without modification', () => {
    writeFile('src/a.ts', 'hello');
    const evidencePath = join(scratchRoot, '..', 'preexisting-evidence.json');
    writeFileSync(evidencePath, 'not a manifest');
    expect(() =>
      capture({ root: scratchRoot, directories: ['src'], exclusions: [] }, evidencePath),
    ).toThrow(BoundaryError);
    expect(readFileSync(evidencePath, 'utf8')).toBe('not a manifest');
  });
});

describe('readManifest', () => {
  test('round-trips a captured manifest from disk', () => {
    writeFile('src/a.ts', 'hello');
    const { manifest, outputPath } = captureBoundary(['src']);
    const reloaded: Manifest = readManifest(outputPath);
    expect(reloaded.captureId).toBe(manifest.captureId);
    expect(reloaded.files).toEqual(manifest.files);
  });

  test('rejects a non-manifest JSON file', () => {
    const badPath = join(scratchRoot, '..', 'bad-manifest.json');
    writeFileSync(badPath, JSON.stringify({ not: 'a manifest' }));
    expect(() => readManifest(badPath)).toThrow(BoundaryError);
  });
});

describe('parseCommandLine', () => {
  const bad: string[][] = [
    [],
    ['bogus'],
    ['capture'],
    ['capture', '--configuration', 'c'],
    ['verify', '--configuration', 'c'],
    ['verify', '--before', 'b'],
    // An unknown option is refused, not silently accepted.
    ['capture', '--configuration', 'c', '--output', 'o', '--bogus', 'x'],
    // A boolean-looking flag must not swallow the next argument and pass.
    ['capture', '--configuration', 'c', '--output', 'o', '--json'],
    ['verify', '--json', '--configuration', 'c', '--before', 'b'],
    ['capture', '--configuration', 'c', '--output', 'o', 'stray'],
    ['capture', '--configuration'],
    // An option that lost its value to the next option.
    ['capture', '--configuration', 'c', '--output', '--configuration', 'd'],
    ['capture', '--configuration', 'c', '--output', '--bogus'],
    // `--accounting` belongs to verify only.
    ['capture', '--configuration', 'c', '--output', 'o', '--accounting', 'a'],
  ];
  for (const argv of bad) {
    test(`rejects ${JSON.stringify(argv)} as a usage error`, () => {
      expect(() => parseCommandLine(argv)).toThrow(UsageError);
    });
  }

  test('accepts the documented forms', () => {
    const capture = parseCommandLine(['capture', '--configuration', 'c', '--output', 'o']);
    expect(capture.command).toBe('capture');
    expect(capture.options.values).toEqual({ configuration: 'c', output: 'o' });
    const verify = parseCommandLine([
      'verify',
      '--configuration',
      'c',
      '--before',
      'b',
      '--accounting',
      'a',
    ]);
    expect(verify.options.values).toEqual({ configuration: 'c', before: 'b', accounting: 'a' });
  });
});
