import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { outcomeOf, rethrow } from '../module-scope-scenario.test-support.ts';
import { defaultRunner } from './process-runner.ts';
import {
  findingsOf,
  linkNodeModules,
  parseGuardList,
  runTextGuards,
  type GuardsResult,
} from './text-guards.ts';

/**
 * The real guard runner on real commits of this repository: no injected runner and no injected
 * result, the way `direct-merge.ts` runs it. The commit under test is this checkout's `HEAD` tree,
 * a commit object that is never pushed. The control is a normal checkout of that same tree, each
 * guard run with plain `bun scripts/check-<name>.ts` in it. `main` may fail a guard for reasons that
 * are not this change's, so the runner is compared with the control, never asserted to pass.
 * Each scenario runs the guards once (tens of seconds), at module scope, where no per-test clock
 * applies.
 */
const repositoryRoot = join(import.meta.dir, '..', '..');
const SEEDED_FILE = 'scripts/chef/seeded-guard-failure.test.ts';
const SEEDED_GUARD = 'check-test-process-spawns';

const scratchDirectories: string[] = [];
const worktrees: string[] = [];

afterAll(() => {
  for (const directory of scratchDirectories) rmSync(directory, { recursive: true, force: true });
});

/** A commit needs an identity, which a CI runner may not have configured. */
const identity = {
  GIT_AUTHOR_NAME: 'Test Author',
  GIT_AUTHOR_EMAIL: 'author@example.test',
  GIT_COMMITTER_NAME: 'Test Author',
  GIT_COMMITTER_EMAIL: 'author@example.test',
};

function git(...args: string[]): string {
  const result = defaultRunner(['git', ...args], { cwd: repositoryRoot, env: identity });
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), 'text-guards-real-'));
  scratchDirectories.push(directory);
  return directory;
}

/** A commit object on `HEAD`'s tree, plus `file` when given, made with a throwaway index. */
function commitOfHeadTree(file?: { path: string; content: string }): string {
  if (file === undefined) return git('commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'squash');
  const index = join(scratch(), 'index');
  const env = { ...identity, GIT_INDEX_FILE: index };
  const run = (args: string[], input?: string) => {
    const result = defaultRunner(['git', ...args], { cwd: repositoryRoot, env, input });
    if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  run(['read-tree', 'HEAD^{tree}']);
  const blob = run(['hash-object', '-w', '--stdin'], file.content);
  run(['update-index', '--add', '--cacheinfo', `100644,${blob},${file.path}`]);
  return git('commit-tree', run(['write-tree']), '-p', 'HEAD', '-m', 'seeded squash');
}

/** A normal checkout of `commit`, with the repository's `node_modules` linked in. */
function normalCheckout(commit: string): string {
  const tree = join(scratch(), 'checkout');
  mkdirSync(tree);
  git('worktree', 'add', '--detach', tree, commit);
  worktrees.push(tree);
  linkNodeModules(repositoryRoot, tree);
  return tree;
}

/** What each guard does in a normal checkout: a plain `bun scripts/check-<name>.ts`, one at a time. */
function controlRun(tree: string): GuardsResult {
  const guards = parseGuardList(
    // The list a normal `bun run lint:guards` in that checkout would read.
    defaultRunner(['git', 'show', 'HEAD:package.json'], { cwd: tree }).stdout,
  );
  if (typeof guards === 'string') throw new Error(guards);
  const failures: GuardsResult['failures'] = [];
  for (const guard of guards) {
    const result = defaultRunner(guard.command, { cwd: tree });
    if (result.code === 0) continue;
    const findings = findingsOf(result, tree);
    failures.push({ guard: guard.name, findings, output: findings.slice(0, 3).join(' | ') });
  }
  return { ok: failures.length === 0, failures };
}

const names = (result: GuardsResult) => result.failures.map((failure) => failure.guard);

// The runner passes or fails exactly as a normal checkout does, guard by guard and finding by finding.
const squash = commitOfHeadTree();
let runnerResult: GuardsResult | undefined;
const sameAsNormalCheckout = await outcomeOf(() => {
  runnerResult = runTextGuards(defaultRunner, repositoryRoot, squash);
  const control = controlRun(normalCheckout(squash));
  expect(names(runnerResult)).toEqual(names(control));
  expect(runnerResult.failures.map((failure) => failure.findings)).toEqual(
    control.failures.map((failure) => failure.findings),
  );
  expect(runnerResult.ok).toBe(control.ok);
  // The two guards that need Git ran with a baseline: neither failed for want of `origin/main`.
  for (const failure of runnerResult.failures)
    expect(failure.findings.join('\n')).not.toContain('does not resolve');
});

// A failure seeded in the fifth guard is reported under that guard's name, and under no other.
const seededName = await outcomeOf(() => {
  const seeded = commitOfHeadTree({
    path: SEEDED_FILE,
    content:
      "import { test } from 'bun:test';\n\ntest('starts a process', () => {\n  Bun.spawnSync(['true']);\n});\n",
  });
  const result = runTextGuards(defaultRunner, repositoryRoot, seeded);
  expect(result.ok).toBe(false);
  const failure = result.failures.find((candidate) => candidate.guard === SEEDED_GUARD);
  expect(failure?.findings.join('\n')).toContain(SEEDED_FILE);
  const baseline = runnerResult;
  if (baseline === undefined) throw new Error('the unseeded run did not finish');
  // Every other guard fails exactly as without the seed: the seed is named once, by its own guard.
  expect(names(result).filter((name) => name !== SEEDED_GUARD)).toEqual(
    names(baseline).filter((name) => name !== SEEDED_GUARD),
  );
  const guards = parseGuardList(git('show', 'HEAD:package.json'));
  if (typeof guards === 'string') throw new Error(guards);
  expect(guards.map((guard) => guard.name).indexOf(SEEDED_GUARD)).toBe(4);
});

// Why the guards cannot run in a `git archive`: a tree with no `.git` has no `origin/main` to compare
// a plugin's identities against, and the guard fails for it. The runner above never fails that way.
const archiveHasNoBaseline = await outcomeOf(() => {
  const directory = scratch();
  const tree = join(directory, 'tree');
  mkdirSync(tree);
  const archive = join(directory, 'tree.tar');
  git('archive', '--format=tar', '-o', archive, squash);
  expect(defaultRunner(['tar', '-xf', archive, '-C', tree]).code).toBe(0);
  const result = defaultRunner(['bun', 'scripts/check-plugin-identities.ts'], { cwd: tree });
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain('does not resolve');
});

// The control checkouts are linked worktrees of this repository: remove them, which also prunes
// their entries, here at module scope, where a process may start.
for (const tree of worktrees)
  defaultRunner(['git', 'worktree', 'remove', '--force', tree], { cwd: repositoryRoot });

describe('runTextGuards on real commits', () => {
  test('passes or fails exactly as the guards do in a normal checkout of the same tree', () => {
    rethrow(sameAsNormalCheckout);
  });

  test('reports a failure seeded in the fifth guard under that guard, not another', () => {
    rethrow(seededName);
  });

  test('a tree extracted with git archive cannot resolve origin/main, which is why guards run in a worktree', () => {
    rethrow(archiveHasNoBaseline);
  });
});
