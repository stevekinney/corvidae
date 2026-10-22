import { describe, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { defaultRunner } from './process-runner.ts';
import {
  capture as captureReviewBoundary,
  verify as verifyReviewBoundary,
} from './review-boundary.ts';
import { createScenarios } from './scenario.test-support.ts';
import {
  ScopeError,
  UsageError,
  capture,
  normalizeConfiguration,
  readEvidence,
  verify,
} from './worktree-scope.ts';

const scriptPath = join(import.meta.dir, 'worktree-scope.ts');

let sandbox: string;
let worktree: string;
let evidenceCounter = 0;

function git(directory: string, ...args: string[]): string {
  const result = defaultRunner(
    [
      'git',
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd: directory, env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } },
  );
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout;
}

function write(relativePath: string, contents: string, directory = worktree) {
  const absolute = join(directory, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
}

function initializeRepository(directory: string) {
  mkdirSync(directory, { recursive: true });
  git(directory, 'init', '-q', '-b', 'main');
  write('.gitignore', 'ignored/\n*.log\n', directory);
  write('src/app.ts', 'app', directory);
  write('docs/readme.md', 'readme', directory);
  write('outside/notes.md', 'notes', directory);
  git(directory, 'add', '-A');
  git(directory, 'commit', '-q', '-m', 'initial');
}

function evidencePath(): string {
  evidenceCounter += 1;
  return join(sandbox, `evidence-${evidenceCounter}.json`);
}

function configurationFor(paths: string[], root = worktree) {
  return { root, paths };
}

function captureScope(paths: string[]) {
  const output = evidencePath();
  capture(configurationFor(paths), output);
  return output;
}

function verifyScope(paths: string[], before: string, root = worktree) {
  return verify(configurationFor(paths, root), readEvidence(before));
}

function hashTree(directory: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  const visit = (relative: string) => {
    const absolute = join(directory, relative);
    const stats = lstatSync(absolute);
    if (relative === '.git') return;
    if (stats.isDirectory()) {
      for (const entry of readdirSync(absolute).toSorted())
        visit(relative === '' ? entry : `${relative}/${entry}`);
    } else if (stats.isFile()) {
      hashes[relative] = createHash('sha256').update(readFileSync(absolute)).digest('hex');
    }
  };
  visit('');
  return hashes;
}

function runCli(...args: string[]) {
  const result = defaultRunner(['bun', scriptPath, ...args], { cwd: sandbox });
  return { exitCode: result.code, stdout: result.stdout, stderr: result.stderr };
}

const scenarios = createScenarios({
  setUp() {
    sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-scope-test-')));
    worktree = join(sandbox, 'repository');
    initializeRepository(worktree);
  },
  tearDown() {
    rmSync(sandbox, { recursive: true, force: true });
  },
});

describe('normalizeConfiguration', () => {
  scenarios.scenario('rejects absolute, empty, dot-dot, backslash, and root-wide paths', () => {
    for (const path of ['/etc', '', 'src/../x', 'src\\a', '.', './src', 'src//a', 'src/']) {
      expect(() => normalizeConfiguration(configurationFor([path]))).toThrow(UsageError);
    }
  });

  scenarios.scenario('deduplicates and sorts allowed paths without wildcard expansion', () => {
    const normalized = normalizeConfiguration(configurationFor(['src', 'docs', 'src']));
    expect(normalized.paths).toEqual(['docs', 'src']);
    expect(normalizeConfiguration(configurationFor(['src/*.ts'])).paths).toEqual(['src/*.ts']);
  });

  scenarios.scenario('requires the root to be exactly a git worktree top level', () => {
    expect(() => normalizeConfiguration(configurationFor(['src'], join(worktree, 'src')))).toThrow(
      ScopeError,
    );
    const plain = join(sandbox, 'plain');
    mkdirSync(plain);
    expect(() => normalizeConfiguration(configurationFor(['src'], plain))).toThrow(ScopeError);
    expect(() =>
      normalizeConfiguration(configurationFor(['src'], join(sandbox, 'missing'))),
    ).toThrow(ScopeError);
  });

  scenarios.scenario('canonicalizes the root through symlinks', () => {
    const alias = join(sandbox, 'alias');
    symlinkSync(worktree, alias);
    expect(normalizeConfiguration(configurationFor(['src'], alias)).root).toBe(worktree);
  });
});

describe('clean and dirty baselines', () => {
  scenarios.scenario('a clean baseline with no changes verifies', () => {
    const before = captureScope(['src']);
    const report = verifyScope(['src'], before);
    expect(report.errors).toEqual([]);
    expect(report.outOfScope).toEqual([]);
  });

  scenarios.scenario('capture records identity fields', () => {
    const before = captureScope(['src', 'docs']);
    const evidence = readEvidence(before);
    expect(evidence.captureId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number.isNaN(Date.parse(evidence.capturedAt))).toBe(false);
    expect(evidence.head).toBe(git(worktree, 'rev-parse', 'HEAD').trim());
    expect(evidence.root).toBe(worktree);
    expect(evidence.paths).toEqual(['docs', 'src']);
  });

  scenarios.scenario('pre-existing dirty content outside scope may remain unchanged', () => {
    write('outside/notes.md', 'already dirty');
    write('outside/untracked.md', 'already untracked');
    const before = captureScope(['src']);
    write('src/app.ts', 'edited in scope');
    const report = verifyScope(['src'], before);
    expect(report.errors).toEqual([]);
    expect(report.changed).toEqual(['src/app.ts']);
  });

  scenarios.scenario('changing pre-existing dirty content outside scope fails', () => {
    write('outside/notes.md', 'already dirty');
    const before = captureScope(['src']);
    write('outside/notes.md', 'dirty differently');
    expect(verifyScope(['src'], before).outOfScope).toEqual(['outside/notes.md']);
  });

  scenarios.scenario('deleting pre-existing dirty content outside scope fails', () => {
    write('outside/untracked.md', 'already untracked');
    const before = captureScope(['src']);
    unlinkSync(join(worktree, 'outside/untracked.md'));
    const report = verifyScope(['src'], before);
    expect(report.removed).toEqual(['outside/untracked.md']);
    expect(report.outOfScope).toEqual(['outside/untracked.md']);
  });
});

describe('in-scope and out-of-scope mutations', () => {
  scenarios.scenario('in-scope edits, additions, and deletions verify', () => {
    const before = captureScope(['src']);
    write('src/app.ts', 'edited');
    write('src/new/file.ts', 'added');
    unlinkSync(join(worktree, 'src/app.ts'));
    const report = verifyScope(['src'], before);
    expect(report.errors).toEqual([]);
    expect(report.added).toEqual(['src/new/file.ts']);
    expect(report.removed).toEqual(['src/app.ts']);
  });

  scenarios.scenario('an allowed file path permits only that file', () => {
    const before = captureScope(['src/app.ts']);
    write('src/app.ts', 'edited');
    expect(verifyScope(['src/app.ts'], before).errors).toEqual([]);
    write('src/other.ts', 'sibling');
    expect(verifyScope(['src/app.ts'], before).outOfScope).toEqual(['src/other.ts']);
  });

  scenarios.scenario('a directory allowance does not cover a prefix-sharing sibling', () => {
    const before = captureScope(['src']);
    write('src-extra/file.ts', 'sibling directory');
    expect(verifyScope(['src'], before).outOfScope).toEqual(['src-extra/file.ts']);
  });

  scenarios.scenario('out-of-scope tracked edit fails', () => {
    const before = captureScope(['src']);
    write('docs/readme.md', 'changed');
    const report = verifyScope(['src'], before);
    expect(report.outOfScope).toEqual(['docs/readme.md']);
    expect(report.errors.length).toBeGreaterThan(0);
  });

  scenarios.scenario('out-of-scope new file fails', () => {
    const before = captureScope(['src']);
    write('scripts/verify-runtimes.ts', 'new');
    expect(verifyScope(['src'], before).outOfScope).toEqual(['scripts/verify-runtimes.ts']);
  });

  scenarios.scenario('out-of-scope tracked deletion fails', () => {
    const before = captureScope(['src']);
    unlinkSync(join(worktree, 'docs/readme.md'));
    const report = verifyScope(['src'], before);
    expect(report.removed).toEqual(['docs/readme.md']);
    expect(report.outOfScope).toEqual(['docs/readme.md']);
  });

  scenarios.scenario(
    'an out-of-scope edit fails even when the review-boundary guard passes',
    () => {
      const boundaryConfiguration = { root: worktree, directories: ['src'], exclusions: [] };
      const boundaryEvidence = evidencePath();
      const boundary = captureReviewBoundary(boundaryConfiguration, boundaryEvidence);
      const before = captureScope(['src']);

      write('src/app.ts', 'in scope edit');
      write('applications/web/scripts/verify-cimd-runtimes.ts', 'outside the captured directories');

      const boundaryReport = verifyReviewBoundary(boundaryConfiguration, boundary);
      expect(boundaryReport.errors).toEqual([]);
      const report = verifyScope(['src'], before);
      expect(report.outOfScope).toEqual(['applications/web/scripts/verify-cimd-runtimes.ts']);
      expect(report.errors.length).toBeGreaterThan(0);
    },
  );
});

describe('ignored files, modes, and symlinks', () => {
  scenarios.scenario('untracked ignored artifacts are skipped', () => {
    const before = captureScope(['src']);
    write('ignored/cache.bin', 'artifact');
    write('debug.log', 'log');
    expect(verifyScope(['src'], before).errors).toEqual([]);
  });

  scenarios.scenario('tracked ignored files remain covered', () => {
    write('ignored/tracked.txt', 'tracked despite ignore');
    git(worktree, 'add', '-f', 'ignored/tracked.txt');
    git(worktree, 'commit', '-q', '-m', 'track ignored');
    const before = captureScope(['src']);
    write('ignored/tracked.txt', 'modified');
    expect(verifyScope(['src'], before).outOfScope).toEqual(['ignored/tracked.txt']);
  });

  scenarios.scenario('an out-of-scope mode change fails and an in-scope one passes', () => {
    const before = captureScope(['src']);
    chmodSync(join(worktree, 'src/app.ts'), 0o755);
    expect(verifyScope(['src'], before).errors).toEqual([]);
    chmodSync(join(worktree, 'docs/readme.md'), 0o755);
    expect(verifyScope(['src'], before).outOfScope).toEqual(['docs/readme.md']);
  });

  scenarios.scenario('a symlink target change fails without following the link', () => {
    symlinkSync('../src/app.ts', join(worktree, 'outside/link'));
    git(worktree, 'add', 'outside/link');
    git(worktree, 'commit', '-q', '-m', 'link');
    const before = captureScope(['src']);
    write('src/app.ts', 'the link target changed content');
    expect(verifyScope(['src'], before).outOfScope).toEqual([]);
    unlinkSync(join(worktree, 'outside/link'));
    symlinkSync('../docs/readme.md', join(worktree, 'outside/link'));
    expect(verifyScope(['src'], before).outOfScope).toEqual(['outside/link']);
  });

  scenarios.scenario('a dangling untracked symlink is captured by target bytes', () => {
    symlinkSync('/nonexistent/target', join(worktree, 'outside/dangling'));
    const before = captureScope(['src']);
    expect(verifyScope(['src'], before).errors).toEqual([]);
    unlinkSync(join(worktree, 'outside/dangling'));
    symlinkSync('/nonexistent/other', join(worktree, 'outside/dangling'));
    expect(verifyScope(['src'], before).outOfScope).toEqual(['outside/dangling']);
  });
});

describe('path names and staging', () => {
  scenarios.scenario('names with spaces, tabs, and newlines parse unambiguously', () => {
    const awkward = [
      'outside/with space.txt',
      'outside/with\ttab.txt',
      'outside/with\nnewline.txt',
    ];
    for (const path of awkward) write(path, 'original');
    const before = captureScope(['src']);
    for (const path of awkward) write(path, 'changed');
    const report = verifyScope(['src'], before);
    expect(report.outOfScope).toEqual([...awkward].toSorted());
  });

  scenarios.scenario('staging alone without a content or mode change is not a mutation', () => {
    write('outside/draft.md', 'untracked draft');
    const before = captureScope(['src']);
    git(worktree, 'add', 'outside/draft.md');
    git(worktree, 'rm', '-q', '--cached', 'docs/readme.md');
    git(worktree, 'add', 'docs/readme.md');
    expect(verifyScope(['src'], before).errors).toEqual([]);
  });
});

describe('baseline identity', () => {
  scenarios.scenario('a different allowed path set fails', () => {
    const before = captureScope(['src']);
    const report = verifyScope(['src', 'docs'], before);
    expect(report.errors.some((message) => message.includes('path set'))).toBe(true);
  });

  scenarios.scenario('a changed HEAD fails', () => {
    const before = captureScope(['src']);
    write('src/app.ts', 'committed');
    git(worktree, 'commit', '-q', '-am', 'commit during work');
    const report = verifyScope(['src'], before);
    expect(report.errors.some((message) => message.includes('HEAD'))).toBe(true);
  });

  scenarios.scenario('a different root fails', () => {
    const before = captureScope(['src']);
    const other = join(sandbox, 'other');
    initializeRepository(other);
    const report = verifyScope(['src'], before, other);
    expect(report.errors.some((message) => message.includes('root'))).toBe(true);
  });

  scenarios.scenario('malformed evidence is rejected', () => {
    const garbage = join(sandbox, 'garbage.json');
    writeFileSync(garbage, 'not json');
    expect(() => readEvidence(garbage)).toThrow(ScopeError);
    expect(() => readEvidence(join(sandbox, 'missing.json'))).toThrow(ScopeError);

    const valid = JSON.parse(readFileSync(captureScope(['src']), 'utf8'));
    const variants: Record<string, unknown> = {
      wrongVersion: { ...valid, version: 2 },
      missingHead: { ...valid, head: undefined },
      badEntries: { ...valid, entries: 'nope' },
      badEntry: { ...valid, entries: [{ path: 'a' }] },
      unsortedPaths: { ...valid, paths: ['src', 'docs'] },
    };
    for (const [name, value] of Object.entries(variants)) {
      const path = join(sandbox, `${name}.json`);
      writeFileSync(path, JSON.stringify(value));
      expect(() => readEvidence(path), name).toThrow(ScopeError);
    }
  });

  scenarios.scenario(
    'unreadable content fails capture instead of producing partial evidence',
    () => {
      write('outside/secret.md', 'secret');
      chmodSync(join(worktree, 'outside/secret.md'), 0o000);
      try {
        const output = evidencePath();
        expect(() => capture(configurationFor(['src']), output)).toThrow(ScopeError);
        expect(existsSync(output)).toBe(false);
      } finally {
        chmodSync(join(worktree, 'outside/secret.md'), 0o644);
      }
    },
  );
});

describe('submodules and output handling', () => {
  scenarios.scenario('a submodule gitlink is refused, never silently omitted', () => {
    git(
      worktree,
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${git(worktree, 'rev-parse', 'HEAD').trim()},vendor/sub`,
    );
    expect(() => capture(configurationFor(['src']), evidencePath())).toThrow(/submodule/i);
  });

  scenarios.scenario('an untracked nested repository is refused', () => {
    const nested = join(worktree, 'nested');
    mkdirSync(nested);
    git(nested, 'init', '-q');
    write('file.txt', 'x', nested);
    expect(() => capture(configurationFor(['src']), evidencePath())).toThrow(/nested|submodule/i);
  });

  scenarios.scenario('capture never overwrites existing evidence', () => {
    const output = evidencePath();
    capture(configurationFor(['src']), output);
    const original = readFileSync(output, 'utf8');
    expect(() => capture(configurationFor(['src']), output)).toThrow(ScopeError);
    expect(readFileSync(output, 'utf8')).toBe(original);
  });

  scenarios.scenario('capture refuses to write inside the worktree', () => {
    const output = join(worktree, 'evidence.json');
    expect(() => capture(configurationFor(['src']), output)).toThrow(ScopeError);
    expect(existsSync(output)).toBe(false);
  });
});

describe('command line contract', () => {
  function writeConfiguration(paths: string[]) {
    const path = join(sandbox, `configuration-${evidenceCounter++}.json`);
    writeFileSync(path, JSON.stringify(configurationFor(paths)));
    return path;
  }

  scenarios.scenario(
    'exit codes: 0 accepted, 1 scope failure, 2 usage, one JSON report on stdout',
    () => {
      const configuration = writeConfiguration(['src']);
      const output = evidencePath();

      const captured = runCli('capture', '--configuration', configuration, '--output', output);
      expect(captured.exitCode).toBe(0);
      expect(JSON.parse(captured.stdout).captureId).toBeString();

      const accepted = runCli('verify', '--configuration', configuration, '--before', output);
      expect(accepted.exitCode).toBe(0);
      expect(JSON.parse(accepted.stdout).outOfScope).toEqual([]);

      write('docs/readme.md', 'escaped');
      const before = hashTree(worktree);
      const rejected = runCli('verify', '--configuration', configuration, '--before', output);
      expect(rejected.exitCode).toBe(1);
      expect(JSON.parse(rejected.stdout).outOfScope).toEqual(['docs/readme.md']);
      expect(hashTree(worktree)).toEqual(before);

      expect(runCli('bogus').exitCode).toBe(2);
      expect(runCli('capture', '--configuration', configuration).exitCode).toBe(2);
      expect(runCli('verify', '--configuration', configuration).exitCode).toBe(2);
      expect(
        runCli(
          'capture',
          '--configuration',
          writeConfiguration(['/etc']),
          '--output',
          evidencePath(),
        ).exitCode,
      ).toBe(2);
    },
  );

  scenarios.scenario(
    'failing verification leaves source content byte-identical and never cleans up',
    () => {
      const configuration = writeConfiguration(['src']);
      const output = evidencePath();
      expect(runCli('capture', '--configuration', configuration, '--output', output).exitCode).toBe(
        0,
      );
      write('outside/escape.ts', 'escaped');
      unlinkSync(join(worktree, 'docs/readme.md'));
      const before = hashTree(worktree);
      const status = git(worktree, 'status', '--porcelain');
      expect(runCli('verify', '--configuration', configuration, '--before', output).exitCode).toBe(
        1,
      );
      expect(hashTree(worktree)).toEqual(before);
      expect(git(worktree, 'status', '--porcelain')).toBe(status);
      expect(existsSync(join(worktree, 'outside/escape.ts'))).toBe(true);
    },
  );

  scenarios.scenario(
    'an explicit scope expansion via a new capture accepts the previously escaped path',
    () => {
      const narrow = writeConfiguration(['src']);
      const first = evidencePath();
      runCli('capture', '--configuration', narrow, '--output', first);
      write('docs/readme.md', 'escaped');
      expect(runCli('verify', '--configuration', narrow, '--before', first).exitCode).toBe(1);

      const wide = writeConfiguration(['src', 'docs']);
      const second = evidencePath();
      runCli('capture', '--configuration', wide, '--output', second);
      write('docs/readme.md', 'edited under the expanded scope');
      expect(runCli('verify', '--configuration', wide, '--before', second).exitCode).toBe(0);
      expect(runCli('verify', '--configuration', narrow, '--before', first).exitCode).toBe(1);
    },
  );
});

await scenarios.settled();
