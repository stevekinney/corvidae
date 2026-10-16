import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runWithHangGuard } from './hang-guard.ts';
import { nulByteOffenders, nulOffsets } from './source-text-encoding';

const root = join(import.meta.dir, '..');

/**
 * Builds a git repository holding tracked, deleted, untracked and excluded files with NUL
 * bytes, and scans it. Both scans run `git ls-files`, so they run here at module scope, off
 * Bun's five-second per-test clock; the tests below only assert on the settled results.
 */
async function scanExcludesFixture(directory: string) {
  const text = (value: string) => new TextEncoder().encode(value);
  const withNul = new Uint8Array([0x61, 0x00, 0x62, 0x00]);
  const git = async (...command: string[]) => {
    const result = await runWithHangGuard(['git', ...command], { cwd: directory });
    if (result.exitCode !== 0) {
      throw new Error(`git ${command.join(' ')} failed: ${result.stderr.toString()}`);
    }
  };
  await git('init', '--quiet');
  await Bun.write(join(directory, '.gitignore'), Bun.file(join(root, '.gitignore')));
  const fixtures: Record<string, Uint8Array> = {
    'packages/example/src/tracked.ts': withNul,
    'packages/example/src/deleted.ts': withNul,
    '.agents/skills/example/helper.mjs': withNul,
    'packages/example/src/escaped.ts': text('export const delimiter = "\\u0000";\n'),
    'packages/example/src/image.png': withNul,
  };
  for (const [path, bytes] of Object.entries(fixtures)) {
    await Bun.write(join(directory, path), bytes);
  }
  await git('add', '--all');
  await rm(join(directory, 'packages/example/src/deleted.ts'));
  await Bun.write(join(directory, 'scripts/untracked.ts'), new Uint8Array([0x00]));
  await Bun.write(join(directory, 'scripts/excluded-locally.ts'), withNul);
  await Bun.write(join(directory, 'scripts/excluded-globally.cts'), withNul);
  await Bun.write(join(directory, 'packages/example/build/output.js'), withNul);
  await Bun.write(join(directory, 'node_modules/dependency/index.js'), withNul);
  await Bun.write(join(directory, '.git/info/exclude'), 'excluded-locally.ts\n');
  const globalExcludes = join(directory, 'global-excludes');
  await Bun.write(globalExcludes, 'excluded-globally.cts\n');
  await git('config', 'core.excludesFile', globalExcludes);
  return nulByteOffenders(directory);
}

const fixtureDirectory = await mkdtemp(join(tmpdir(), 'source-text-encoding-'));
afterAll(() => rm(fixtureDirectory, { recursive: true, force: true }));
const [repositoryScan, fixtureScan] = await Promise.all([
  nulByteOffenders(root),
  scanExcludesFixture(fixtureDirectory),
]);

/**
 * A source file containing a raw NUL byte is not a text file, and the tools
 * that read source treat it accordingly: `grep` classifies it as binary and
 * silently reports no matches, and `git diff` prints "Binary files differ"
 * instead of a diff. Both fail quietly, so a search over such a file returns
 * a confidently wrong answer rather than an error.
 *
 * Nothing else in this repository catches it. A NUL is a valid character in a
 * string literal, so lint, `tsc`, and the full test suite all pass over a file
 * that has become unreadable to every code-search tool. That combination —
 * invisible to every gate, and silently corrupting of search — is why this is
 * checked rather than left to review.
 *
 * Use a unicode escape (backslash-u followed by four zeros) when a NUL is
 * genuinely wanted, which is the usual case here: it is a common composite-key
 * delimiter, chosen because it cannot appear in the components being joined.
 * The escape emits the identical byte at runtime, so a persisted key format is
 * unchanged.
 *
 * This comment deliberately spells that escape out in words rather than
 * writing it. Several tools that generate or rewrite files interpret the
 * escape and emit the byte itself — which is how this very file first tripped
 * the check it defines. For the same reason, the fixtures below build their
 * NUL bytes from numbers rather than from string escapes.
 */
describe('source text encoding', () => {
  test('reports exact byte offsets including consecutive and boundary NULs', () => {
    expect(nulOffsets(new Uint8Array([0, 0, 65, 195, 169, 0]))).toEqual([0, 1, 5]);
    expect(nulOffsets(new TextEncoder().encode('\\u0000'))).toEqual([]);
    expect(nulOffsets(new Uint8Array())).toEqual([]);
  });

  test('no source file contains a raw NUL byte', () => {
    expect(repositoryScan.files).toBeGreaterThan(0);
    expect(repositoryScan.offenders).toEqual([]);
  });

  test('catches tracked and untracked source regardless of local excludes', () => {
    expect(fixtureScan.offenders).toEqual([
      '.agents/skills/example/helper.mjs (2 at 1, 3)',
      'packages/example/src/tracked.ts (2 at 1, 3)',
      'scripts/excluded-globally.cts (2 at 1, 3)',
      'scripts/excluded-locally.ts (2 at 1, 3)',
      'scripts/untracked.ts (1 at 0)',
    ]);
  });
});
