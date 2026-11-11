import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { outcomeOf, rethrow } from '../module-scope-scenario.test-support.ts';
import { directMerge, directMergeExclusively, type DirectMergeOptions } from './direct-merge.ts';
import { defaultRunner, type Runner } from './process-runner.ts';
import type { GuardsResult } from './text-guards.ts';

/**
 * `directMerge` against real Git: a bare repository as `origin`, a clone that the merge runs in, and
 * a second clone that moves `origin/main` behind the first one's back. Only the text guards are
 * injected, because they need the real repository's scripts (`text-guards.integration.test.ts` runs
 * the real ones). Each scenario starts processes, so it runs once at module scope, where no per-test
 * clock applies, and its test rethrows what it recorded.
 */

/** Real Git with no host configuration reaching in: identity and signing are set per repository. */
const isolated: Runner = (command, options) =>
  defaultRunner(command, {
    ...options,
    env: {
      ...options?.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
  });

const scratchDirectories: string[] = [];

afterAll(() => {
  for (const directory of scratchDirectories) rmSync(directory, { recursive: true, force: true });
});

/** `git <args>` in `cwd`; throws when it fails, returns trimmed standard output. */
function git(cwd: string, ...args: string[]): string {
  const result = isolated(['git', ...args], { cwd });
  if (result.code !== 0)
    throw new Error(`git ${args.join(' ')} failed (${result.code}): ${result.stderr}`);
  return result.stdout.trim();
}

function configure(clone: string): void {
  git(clone, 'config', 'user.name', 'Test Author');
  git(clone, 'config', 'user.email', 'author@example.test');
  git(clone, 'config', 'commit.gpgsign', 'false');
}

/** Write `file` in `clone`, commit it with `message`, and return the new commit. */
function commit(clone: string, file: string, content: string, message: string): string {
  writeFileSync(join(clone, file), content);
  git(clone, 'add', file);
  git(clone, 'commit', '-q', '-m', message);
  return git(clone, 'rev-parse', 'HEAD');
}

interface World {
  directory: string;
  /** The bare repository that is `origin`. */
  origin: string;
  /** The clone `directMerge` runs in; it has not fetched since the branch was made. */
  clone: string;
  /** Another clone, for moving `origin/main` and pushing the branch. */
  other: string;
  head: string;
  options: DirectMergeOptions;
}

/**
 * A world: `main` holds `shared.txt`, `branch` adds `feature.txt` on top of it, and both are on
 * `origin`. The clone has fetched neither since, so its remote-tracking refs are stale. With
 * `conflicting`, `branch` also edits `shared.txt` and `main` then edits the same line.
 */
function world(conflicting = false): World {
  const directory = mkdtempSync(join(tmpdir(), 'direct-merge-world-'));
  scratchDirectories.push(directory);
  const origin = join(directory, 'origin.git');
  const clone = join(directory, 'clone');
  const other = join(directory, 'other');
  git(directory, 'init', '-q', '--bare', '-b', 'main', origin);
  git(directory, 'init', '-q', '-b', 'main', other);
  configure(other);
  git(other, 'remote', 'add', 'origin', origin);
  commit(other, 'shared.txt', 'one\ntwo\nthree\n', 'Add shared');
  git(other, 'push', '-q', 'origin', 'main');
  git(directory, 'clone', '-q', origin, clone);
  configure(clone);
  git(other, 'checkout', '-q', '-b', 'branch');
  commit(other, 'feature.txt', 'feature\n', 'Add the feature');
  if (conflicting) commit(other, 'shared.txt', 'one\nbranch\nthree\n', 'Edit shared on the branch');
  const head = git(other, 'rev-parse', 'HEAD');
  git(other, 'push', '-q', 'origin', 'branch');
  git(other, 'checkout', '-q', 'main');
  // `main` moves after the clone last fetched, so the clone's `origin/main` is stale.
  commit(
    other,
    conflicting ? 'shared.txt' : 'moved.txt',
    conflicting ? 'one\nmain\nthree\n' : 'moved\n',
    'Move main',
  );
  git(other, 'push', '-q', 'origin', 'main');
  const configPath = join(directory, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      repository: 'acme/widgets',
      defaultBranch: 'main',
      worktreeRoots: { claude: '/c', codex: '/x' },
      manifestName: 'widgets',
      installCommand: 'true',
      gateCommand: 'true',
      affectedCheckCommand: 'true',
      mergeMethod: 'squash',
    }),
  );
  const messageFile = join(directory, 'message.md');
  writeFileSync(messageFile, 'COR-9: Add the feature\n\nSquashed from branch.\n');
  return {
    directory,
    origin,
    clone,
    other,
    head,
    options: {
      configPath,
      branch: 'branch',
      head,
      messageFile,
      worktree: clone,
      lockDirectory: join(directory, 'merge-lock'),
      lockPollIntervalMs: 10,
    },
  };
}

const guardsPass = (): GuardsResult => ({ ok: true, failures: [] });
const refs = (origin: string, ref: string): string =>
  git(origin, 'for-each-ref', '--format=%(objectname)', ref);

/** `git merge-tree --write-tree` as the merge runs it, with its exit code and first line. */
function mergeTree(clone: string, base: string, head: string) {
  const result = isolated(['git', 'merge-tree', '--write-tree', base, head], { cwd: clone });
  return { code: result.code, first: result.stdout.split('\n')[0] ?? '' };
}

// A clean branch merges: one squash commit on the moved `main`, the merged tree, branch deleted.
const clean = await outcomeOf(() => {
  const w = world();
  const staleBase = git(w.clone, 'rev-parse', 'origin/main');
  expect(
    isolated(['git', 'rev-parse', '--verify', 'refs/remotes/origin/branch'], { cwd: w.clone }).code,
  ).not.toBe(0);
  const movedMain = refs(w.origin, 'refs/heads/main');
  expect(movedMain).not.toBe(staleBase);

  // The merge-tree contract the merge relies on: exit 0 and the tree id on the first line.
  git(w.clone, 'fetch', '-q', 'origin', 'main', 'branch');
  const probe = mergeTree(w.clone, movedMain, w.head);
  expect(probe.code).toBe(0);
  expect(probe.first).toMatch(/^[0-9a-f]{40}$/);
  // The fetch updated the remote-tracking refs the code reads, to the tip and to the branch head.
  expect(git(w.clone, 'rev-parse', 'refs/remotes/origin/main')).toBe(movedMain);
  expect(git(w.clone, 'rev-parse', 'refs/remotes/origin/branch')).toBe(w.head);
  // Put the clone back to stale so the merge's own fetch is what updates them.
  git(w.clone, 'update-ref', 'refs/remotes/origin/main', staleBase);
  git(w.clone, 'update-ref', '-d', 'refs/remotes/origin/branch');

  const guardRevisions: string[] = [];
  const report = directMerge(w.options, {
    runner: isolated,
    guards: (revision) => {
      guardRevisions.push(revision);
      return guardsPass();
    },
  });
  expect(report).toMatchObject({ merged: true, failedStep: null, detail: null, base: movedMain });
  const merged = report.mergeCommit ?? '';
  expect(merged).toMatch(/^[0-9a-f]{40}$/);
  expect(guardRevisions).toEqual([merged]);
  expect(refs(w.origin, 'refs/heads/main')).toBe(merged);
  // Exactly one parent, the main that was fetched; the tree is the one merge-tree built.
  expect(git(w.origin, 'rev-list', '--parents', '-n', '1', merged).split(' ')).toEqual([
    merged,
    movedMain,
  ]);
  expect(git(w.origin, 'rev-parse', `${merged}^{tree}`)).toBe(probe.first);
  expect(git(w.origin, 'show', '-s', '--format=%B', merged)).toStartWith(
    'COR-9: Add the feature\n\nSquashed from branch.',
  );
  expect(git(w.origin, 'ls-tree', '--name-only', merged).split('\n')).toEqual([
    'feature.txt',
    'moved.txt',
    'shared.txt',
  ]);
  // The remote branch is gone, and the merge never touched the clone's checked-out files.
  expect(refs(w.origin, 'refs/heads/branch')).toBe('');
  expect(existsSync(join(w.clone, 'feature.txt'))).toBe(false);
  expect(git(w.clone, 'status', '--porcelain')).toBe('');
});

// A conflicting branch: merge-tree exits 1, nothing is pushed, the branch stays.
const conflict = await outcomeOf(() => {
  const w = world(true);
  git(w.clone, 'fetch', '-q', 'origin', 'main', 'branch');
  const mainTip = refs(w.origin, 'refs/heads/main');
  const probe = mergeTree(w.clone, mainTip, w.head);
  expect(probe.code).toBe(1);
  git(w.clone, 'update-ref', '-d', 'refs/remotes/origin/branch');
  let guardsRan = false;
  const report = directMerge(w.options, {
    runner: isolated,
    guards: () => {
      guardsRan = true;
      return guardsPass();
    },
  });
  expect(report).toMatchObject({ merged: false, mergeCommit: null, failedStep: 'conflict' });
  expect(report.detail).toContain('conflicts with origin/main');
  expect(guardsRan).toBe(false);
  expect(refs(w.origin, 'refs/heads/main')).toBe(mainTip);
  expect(refs(w.origin, 'refs/heads/branch')).toBe(w.head);
});

// `origin/main` moves between the fetch and the push: a non-fast-forward rejection that changes nothing.
const race = await outcomeOf(() => {
  const w = world();
  let racing = '';
  const report = directMerge(w.options, {
    runner: isolated,
    // The guards run after the fetch and before the push, so this is the window.
    guards: () => {
      racing = commit(w.other, 'racing.txt', 'racing\n', 'Race main');
      git(w.other, 'push', '-q', 'origin', 'main');
      return guardsPass();
    },
  });
  expect(report).toMatchObject({ merged: false, mergeCommit: null, failedStep: 'merge' });
  expect(report.detail).toContain('was rejected');
  expect(report.detail).toContain('Nothing changed');
  expect(refs(w.origin, 'refs/heads/main')).toBe(racing);
  expect(refs(w.origin, 'refs/heads/branch')).toBe(w.head);
});

// A failed branch delete is its own named step, and the merge stands.
const deleteDenied = await outcomeOf(() => {
  const w = world();
  git(w.origin, 'config', 'receive.denyDeletes', 'true');
  const report = directMerge(w.options, { runner: isolated, guards: guardsPass });
  expect(report).toMatchObject({ merged: true, failedStep: 'delete' });
  expect(report.detail).toContain('deleting origin/branch failed');
  const merged = report.mergeCommit ?? '';
  expect(merged).toMatch(/^[0-9a-f]{40}$/);
  expect(refs(w.origin, 'refs/heads/main')).toBe(merged);
  expect(refs(w.origin, 'refs/heads/branch')).toBe(w.head);
});

const guardsFail = (findings: string[]): GuardsResult => ({
  ok: false,
  failures: [{ guard: 'check-a', findings, output: findings.join(' | ') }],
});

// A guard that already fails on `origin/main` does not hold up a change that adds nothing to it: the
// squash commit is merged, and the report names the guard and the count as already failing.
const inheritedFailure = await outcomeOf(() => {
  const w = world();
  const mainBefore = refs(w.origin, 'refs/heads/main');
  const seen: { revision: string; only: readonly string[] | undefined }[] = [];
  const report = directMerge(w.options, {
    runner: isolated,
    guards: (revision, only) => {
      seen.push({ revision, only });
      return revision === mainBefore ? guardsFail(['x:1', 'y:2']) : guardsFail(['x:1']);
    },
  });
  expect(report).toMatchObject({
    merged: true,
    failedStep: null,
    guardsAlreadyFailing: [{ guard: 'check-a', findings: 1 }],
  });
  const merged = report.mergeCommit ?? '';
  // The squash commit is checked first, then the base, limited to the guard that failed.
  expect(seen).toEqual([
    { revision: merged, only: undefined },
    { revision: mainBefore, only: ['check-a'] },
  ]);
  expect(refs(w.origin, 'refs/heads/main')).toBe(merged);
  expect(refs(w.origin, 'refs/heads/branch')).toBe('');
});

// The same guard failing with a finding the base lacks is the change's own: refused, nothing pushed.
const newFinding = await outcomeOf(() => {
  const w = world();
  const mainBefore = refs(w.origin, 'refs/heads/main');
  const report = directMerge(w.options, {
    runner: isolated,
    guards: (revision) =>
      revision === mainBefore ? guardsFail(['x:1']) : guardsFail(['x:1', 'z:3']),
  });
  expect(report).toMatchObject({ merged: false, mergeCommit: null, failedStep: 'guards' });
  expect(report.guardsAlreadyFailing).toBeUndefined();
  expect(refs(w.origin, 'refs/heads/main')).toBe(mainBefore);
  expect(refs(w.origin, 'refs/heads/branch')).toBe(w.head);
});

// A pinned head that is not the branch's head is refused before anything else happens.
const wrongHead = await outcomeOf(() => {
  const w = world();
  const report = directMerge(
    { ...w.options, head: 'f'.repeat(40) },
    { runner: isolated, guards: guardsPass },
  );
  expect(report).toMatchObject({ merged: false, failedStep: 'head' });
  expect(refs(w.origin, 'refs/heads/branch')).toBe(w.head);
});

// The merge lock is held from before the fetch to after the delete, and released after each outcome.
const lock = await outcomeOf(async () => {
  const w = world();
  const lockDirectory = w.options.lockDirectory ?? '';
  let heldDuringGuards = false;
  const refused = await directMergeExclusively(
    { ...w.options, head: 'f'.repeat(40) },
    { runner: isolated, guards: guardsPass },
  );
  expect(refused).toMatchObject({ merged: false, failedStep: 'head' });
  expect(existsSync(lockDirectory)).toBe(false);
  const merged = await directMergeExclusively(w.options, {
    runner: isolated,
    guards: () => {
      heldDuringGuards = existsSync(lockDirectory);
      return guardsPass();
    },
  });
  expect(merged).toMatchObject({ merged: true, failedStep: null });
  expect(heldDuringGuards).toBe(true);
  expect(existsSync(lockDirectory)).toBe(false);
});

describe('directMerge against real Git', () => {
  test('squashes a clean branch into the moved main as one commit with the merged tree, then deletes the branch', () => {
    rethrow(clean);
  });

  test('refuses a conflicting branch at conflict, with nothing pushed and the branch kept', () => {
    rethrow(conflict);
  });

  test('a push rejected because origin/main moved after the fetch changes nothing and keeps the branch', () => {
    rethrow(race);
  });

  test('a branch delete the remote refuses is step delete with merged true', () => {
    rethrow(deleteDenied);
  });

  test('a guard failure with only findings origin/main already has merges and is reported', () => {
    rethrow(inheritedFailure);
  });

  test('a guard failure with a finding origin/main lacks is refused at guards with nothing pushed', () => {
    rethrow(newFinding);
  });

  test('a head that is not the pinned one is refused at head', () => {
    rethrow(wrongHead);
  });

  test('holds the merge lock across the guards and releases it on a refusal and on a merge', () => {
    rethrow(lock);
  });
});
