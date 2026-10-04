import { describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { REPOSITORY_ROOT } from './playground-paths.ts';
import {
  FINGERPRINT_SOURCE_DIRECTORIES,
  FINGERPRINT_SOURCE_FILES,
  isFingerprintStale,
  newestFileMtimeMs,
  newestSourceMtimeMs,
} from './source-fingerprint.ts';

describe('newestFileMtimeMs', () => {
  test('returns null for a directory with no files', () => {
    const directory = mkdtempSync(join(tmpdir(), 'source-fingerprint-empty-'));
    try {
      expect(newestFileMtimeMs(directory)).toBeNull();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('returns null for a directory that does not exist', () => {
    expect(newestFileMtimeMs(join(tmpdir(), 'does-not-exist-source-fingerprint'))).toBeNull();
  });

  test('finds the newest mtime across nested files', () => {
    const directory = mkdtempSync(join(tmpdir(), 'source-fingerprint-nested-'));
    try {
      writeFileSync(join(directory, 'a.txt'), 'a');
      const nestedDirectory = join(directory, 'nested');
      mkdirSync(nestedDirectory);
      writeFileSync(join(nestedDirectory, 'b.txt'), 'b');

      const newest = newestFileMtimeMs(directory);
      expect(newest).not.toBeNull();
      expect(typeof newest).toBe('number');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('ignores dot-prefixed directories such as playground build scratch dirs', () => {
    const directory = mkdtempSync(join(tmpdir(), 'source-fingerprint-dotdir-'));
    try {
      const oldFile = join(directory, 'a.txt');
      writeFileSync(oldFile, 'a');

      const scratchDirectory = join(directory, '.tmp-abc123');
      mkdirSync(scratchDirectory);
      const scratchFile = join(scratchDirectory, 'entry.ts');
      writeFileSync(scratchFile, 'scratch');
      // Force the scratch file's mtime newer than the tracked file's so a
      // failure to skip it would be observable.
      const future = new Date(Date.now() + 60_000);
      utimesSync(scratchFile, future, future);

      const newest = newestFileMtimeMs(directory);
      const oldMtimeMs = statSync(oldFile).mtimeMs;
      expect(newest).toBe(oldMtimeMs);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('newestFileMtimeMs while the tree changes under the walk', () => {
  /** An `ENOENT` the way `statSync` raises it when a file vanishes after `readdirSync` listed it. */
  function vanishedFileError(path: string): NodeJS.ErrnoException {
    return Object.assign(new Error(`ENOENT: no such file or directory, stat '${path}'`), {
      code: 'ENOENT',
    });
  }

  test('ignores an entry that is deleted between the directory listing and its stat', () => {
    const directory = mkdtempSync(join(tmpdir(), 'source-fingerprint-race-'));
    try {
      const survivor = join(directory, 'survivor.txt');
      const vanishing = join(directory, 'vanishing.txt');
      writeFileSync(survivor, 'kept');
      writeFileSync(vanishing, 'removed mid-walk');
      // The vanishing file would be the newest, so a walk that stopped on it
      // (or counted it) would report a different answer from the survivor's.
      const future = new Date(Date.now() + 60_000);
      utimesSync(vanishing, future, future);

      const newest = newestFileMtimeMs(directory, {
        statFile: (path) => {
          if (path === vanishing) throw vanishedFileError(path);
          return statSync(path);
        },
      });

      expect(newest).toBe(statSync(survivor).mtimeMs);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('returns null when every listed entry vanished before it was statted', () => {
    const directory = mkdtempSync(join(tmpdir(), 'source-fingerprint-all-gone-'));
    try {
      writeFileSync(join(directory, 'only.txt'), 'removed mid-walk');
      expect(
        newestFileMtimeMs(directory, {
          statFile: (path) => {
            throw vanishedFileError(path);
          },
        }),
      ).toBeNull();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('still reports a stat failure that is not a vanished file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'source-fingerprint-denied-'));
    try {
      writeFileSync(join(directory, 'locked.txt'), 'unreadable');
      const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      expect(() =>
        newestFileMtimeMs(directory, {
          statFile: () => {
            throw denied;
          },
        }),
      ).toThrow('EACCES');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('newestFileMtimeMs when a directory cannot be read', () => {
  function readFailure(code: string, path: string): NodeJS.ErrnoException {
    return Object.assign(new Error(`${code}: cannot read directory '${path}'`), { code });
  }

  test('reports a directory that exists but cannot be read instead of treating it as empty', () => {
    const directory = mkdtempSync(join(tmpdir(), 'source-fingerprint-unreadable-'));
    try {
      writeFileSync(join(directory, 'a.txt'), 'a');
      // A fingerprint that silently omitted a whole source tree would call a stale server fresh.
      for (const code of ['EACCES', 'EIO']) {
        expect(() =>
          newestFileMtimeMs(directory, {
            readDirectory: (path) => {
              throw readFailure(code, path);
            },
          }),
        ).toThrow(code);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('skips a directory that is removed after its parent was listed, and counts the rest', () => {
    const directory = mkdtempSync(join(tmpdir(), 'source-fingerprint-subdirectory-gone-'));
    try {
      const survivor = join(directory, 'survivor.txt');
      writeFileSync(survivor, 'kept');
      const vanishing = join(directory, 'vanishing');
      mkdirSync(vanishing);
      writeFileSync(join(vanishing, 'inside.txt'), 'removed mid-walk');

      const newest = newestFileMtimeMs(directory, {
        readDirectory: (path) => {
          if (path === vanishing) throw readFailure('ENOENT', path);
          return readdirSync(path, { withFileTypes: true });
        },
      });

      expect(newest).toBe(statSync(survivor).mtimeMs);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('treats a directory that was replaced by a file as gone', () => {
    const directory = mkdtempSync(join(tmpdir(), 'source-fingerprint-replaced-'));
    try {
      expect(
        newestFileMtimeMs(directory, {
          readDirectory: (path) => {
            throw readFailure('ENOTDIR', path);
          },
        }),
      ).toBeNull();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('newestSourceMtimeMs', () => {
  test('returns null when none of the fingerprinted directories exist', () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), 'source-fingerprint-root-'));
    try {
      expect(newestSourceMtimeMs(emptyRoot)).toBeNull();
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  test('resolves a real newest mtime against the actual repo root', () => {
    expect(newestSourceMtimeMs(REPOSITORY_ROOT)).not.toBeNull();
  });

  function statFailure(code: string, path: string): NodeJS.ErrnoException {
    return Object.assign(new Error(`${code}: cannot stat '${path}'`), { code });
  }

  test('reports an input file that exists but cannot be statted, instead of leaving it out', () => {
    // A package manifest or the package map that raised EACCES or EIO and was silently omitted
    // would let a server start (and stay) fresh against an input it never saw.
    for (const code of ['EACCES', 'EIO']) {
      expect(() =>
        newestSourceMtimeMs(REPOSITORY_ROOT, {
          statFile: (path) => {
            if (path.endsWith('scripts/mirror/package-map.json')) throw statFailure(code, path);
            return statSync(path);
          },
        }),
      ).toThrow(code);
    }
  });

  test('still skips an input file that is absent, as in a branch being assembled', () => {
    const withoutPackageMap = newestSourceMtimeMs(REPOSITORY_ROOT, {
      statFile: (path) => {
        if (path.endsWith('scripts/mirror/package-map.json')) throw statFailure('ENOENT', path);
        return statSync(path);
      },
    });

    expect(withoutPackageMap).not.toBeNull();
  });

  test('includes the private upstream packages the playground bundle depends on', () => {
    // The playground server imports these packages (@lostgradient/markdown,
    // @lostgradient/editor). An edit to one of them must move the fingerprint,
    // or a running server built from stale upstream code looks fresh.
    expect(FINGERPRINT_SOURCE_DIRECTORIES).toContain('packages/markdown/src');
    expect(FINGERPRINT_SOURCE_DIRECTORIES).toContain('components/editor/src');
  });

  test('includes extracted Chat package source', () => {
    expect(FINGERPRINT_SOURCE_DIRECTORIES).toContain('components/chat/src');
  });

  test('includes package manifests that control discovery and bundling', () => {
    expect(FINGERPRINT_SOURCE_FILES).toContain('components/cinder/components.json');
    expect(FINGERPRINT_SOURCE_FILES).toContain('components/chat/package.json');
    expect(FINGERPRINT_SOURCE_FILES).toContain('components/chat/components.json');
    // The documentation's displayed versions come from the mirror's package map.
    expect(FINGERPRINT_SOURCE_FILES).toContain('scripts/mirror/package-map.json');
  });

  test('includes the server and bundler script trees the playground server runs', () => {
    // The playground server itself and its build helpers live under these
    // `scripts` trees. An edit to the server/bundler code must move the
    // fingerprint too, or a running server with the old server code loaded
    // looks fresh.
    expect(FINGERPRINT_SOURCE_DIRECTORIES).toContain('components/cinder/scripts');
    expect(FINGERPRINT_SOURCE_DIRECTORIES).toContain('applications/playground/scripts');
  });

  test('picks up a change to an upstream package source over the playground and Cinder sources', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'source-fingerprint-upstream-'));
    try {
      const playgroundSourceDirectory = join(repoRoot, 'applications/playground/src');
      const componentsSourceDirectory = join(repoRoot, 'components/cinder/src');
      const markdownSourceDirectory = join(repoRoot, 'packages/markdown/src');
      mkdirSync(playgroundSourceDirectory, { recursive: true });
      mkdirSync(componentsSourceDirectory, { recursive: true });
      mkdirSync(markdownSourceDirectory, { recursive: true });

      const playgroundFile = join(playgroundSourceDirectory, 'a.ts');
      writeFileSync(playgroundFile, 'a');
      const past = new Date(Date.now() - 60_000);
      utimesSync(playgroundFile, past, past);

      const baseline = newestSourceMtimeMs(repoRoot);
      expect(baseline).not.toBeNull();

      // Editing @lostgradient/markdown's source after the "baseline" server started
      // must be visible as a newer fingerprint input.
      const markdownFile = join(markdownSourceDirectory, 'index.ts');
      writeFileSync(markdownFile, 'markdown');
      const future = new Date(Date.now() + 60_000);
      utimesSync(markdownFile, future, future);

      const afterUpstreamEdit = newestSourceMtimeMs(repoRoot);
      expect(afterUpstreamEdit).not.toBeNull();
      expect(afterUpstreamEdit! > baseline!).toBe(true);
      expect(afterUpstreamEdit).toBe(statSync(markdownFile).mtimeMs);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe('isFingerprintStale', () => {
  test('is not stale when the current source tree has no newer file', () => {
    expect(isFingerprintStale({ startedAtMs: 0, newestSourceMtimeMs: 100 }, 100)).toBe(false);
    expect(isFingerprintStale({ startedAtMs: 0, newestSourceMtimeMs: 100 }, 50)).toBe(false);
  });

  test('is stale when the current source tree has a file newer than the server saw at startup', () => {
    expect(isFingerprintStale({ startedAtMs: 0, newestSourceMtimeMs: 100 }, 200)).toBe(true);
  });

  test('treats an unknown current mtime as not stale (nothing to compare against)', () => {
    expect(isFingerprintStale({ startedAtMs: 0, newestSourceMtimeMs: 100 }, null)).toBe(false);
  });

  test('treats a server with no known startup mtime as stale when current source exists', () => {
    expect(isFingerprintStale({ startedAtMs: 0, newestSourceMtimeMs: null }, 100)).toBe(true);
  });
});
