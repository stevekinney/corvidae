import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { throwingRejectionOf } from '../../testing/testing/src/helpers/promise-outcome.ts';
import { outcomeOf, rethrow } from '../module-scope-scenario.test-support.ts';
import { createDeliveryVerificationFixture } from './delivery-verification.test-support.ts';
import {
  loadDeliveryVerification,
  type DeliveryVerificationDependencies,
} from './delivery-verification.ts';
import { directMerge, type DirectMergeOptions } from './direct-merge.ts';
import {
  acquireDispatch,
  cancelDispatch,
  readExecutionSnapshot,
  requireAuthority,
} from './execution-state.ts';
import { greenLanding } from './landing-evidence.test-support.ts';
import { withMergeLock } from './merge-gate.ts';
import { defaultRunner, type Runner } from './process-runner.ts';
import type { GuardsResult } from './text-guards.ts';
import type { EvidencePlan } from './verification-plan.ts';

/**
 * `directMerge` against real Git: a bare repository as `origin`, a clone that the merge runs in, and
 * a second clone that moves `origin/main` behind the first one's back. Only the text guards are
 * injected, because they need the real repository's scripts (`text-guards.integration.test.ts` runs
 * the real ones). Each scenario starts processes, so it runs once at module scope, where no per-test
 * clock applies, and its test rethrows what it recorded.
 */

/** Real Git with no host configuration reaching in: identity and signing are set per repository. */
const isolated: Runner = greenLanding((command, options) =>
  defaultRunner(command, {
    ...options,
    env: {
      ...options?.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
  }),
);

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
  verification: DeliveryVerificationDependencies;
}

/**
 * A world: `main` holds `shared.txt`, `branch` adds `feature.txt` on top of it, and both are on
 * `origin`. The clone has fetched neither since, so its remote-tracking refs are stale. With
 * `conflicting`, `branch` also edits `shared.txt` and `main` then edits the same line.
 */
interface WorldExtras {
  /** The branch also edits line one of `shared.txt` (main never touches line one). */
  branchEditsShared?: boolean;
  /** `main` gains `early.txt` before the branch integrates it, but the evidence names the older base. */
  lateMain?: boolean;
  /**
   * Runs after the evidence is taken, in the clone that moves `main`; it pushes what `main` gains
   * afterwards. A returned tree replaces the attested integration tree.
   */
  afterEvidence?: (other: string, evidence: { base: string; head: string }) => string | undefined;
}

async function world(
  conflicting = false,
  integrateMain = true,
  extras: WorldExtras = {},
): Promise<World> {
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
  // The landing queue reads the repository's workspaces, so the world has a manifest.
  commit(other, 'package.json', '{"name":"world","workspaces":[]}\n', 'Add the manifest');
  git(other, 'push', '-q', 'origin', 'main');
  git(directory, 'clone', '-q', origin, clone);
  configure(clone);
  git(other, 'checkout', '-q', '-b', 'branch');
  commit(other, 'feature.txt', 'feature\n', 'Add the feature');
  if (conflicting) commit(other, 'shared.txt', 'one\nbranch\nthree\n', 'Edit shared on the branch');
  if (extras.branchEditsShared)
    commit(other, 'shared.txt', 'branch\ntwo\nthree\n', 'Edit shared line one on the branch');
  let head = git(other, 'rev-parse', 'HEAD');
  git(other, 'push', '-q', 'origin', 'branch');
  git(other, 'checkout', '-q', 'main');
  // `main` moves after the clone last fetched, so the clone's `origin/main` is stale.
  const moved = commit(
    other,
    conflicting ? 'shared.txt' : 'moved.txt',
    conflicting ? 'one\nmain\nthree\n' : 'moved\n',
    'Move main',
  );
  git(other, 'push', '-q', 'origin', 'main');
  if (extras.lateMain) {
    commit(other, 'early.txt', 'early\n', 'A later commit on main that the branch integrates');
    git(other, 'push', '-q', 'origin', 'main');
  }
  if (!conflicting && integrateMain) {
    // Positive delivery controls must attest to the actual candidate tree, including moved main.
    git(other, 'checkout', '-q', 'branch');
    git(other, 'merge', '-q', '--no-edit', 'main');
    head = git(other, 'rev-parse', 'HEAD');
    git(other, 'push', '-q', 'origin', 'branch');
    git(other, 'checkout', '-q', 'main');
  }
  const staleBase = git(clone, 'rev-parse', 'origin/main');
  git(clone, 'fetch', '-q', 'origin', 'main', 'branch');
  const base = extras.lateMain ? moved : refs(origin, 'refs/heads/main');
  const integrationTree =
    extras.afterEvidence?.(other, { base, head }) ?? mergeTree(other, base, head).first;
  const fixture = await createDeliveryVerificationFixture(
    {
      directory: clone,
      base,
      revision: head,
      integrationTree,
      relevantInputs: ['shared.txt', 'feature.txt'],
      outputDirectory: directory,
    },
    { route: 'branch', landing: true },
  );
  git(clone, 'update-ref', 'refs/remotes/origin/main', staleBase);
  git(clone, 'update-ref', '-d', 'refs/remotes/origin/branch');
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
      verification: fixture.verification,
      lockDirectory: join(directory, 'merge-lock'),
      lockPollIntervalMs: 10,
    },
    verification: fixture.dependencies,
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
const clean = await outcomeOf(async () => {
  const w = await world();
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
  const report = await directMerge(w.options, {
    runner: isolated,
    verification: w.verification,
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
    'package.json',
    'shared.txt',
  ]);
  // The remote branch is gone, and the merge never touched the clone's checked-out files.
  expect(refs(w.origin, 'refs/heads/branch')).toBe('');
  expect(existsSync(join(w.clone, 'feature.txt'))).toBe(false);
  expect(git(w.clone, 'status', '--porcelain')).toBe('');
});

// A conflicting branch: merge-tree exits 1, nothing is pushed, the branch stays.
const conflict = await outcomeOf(async () => {
  const w = await world(true);
  git(w.clone, 'fetch', '-q', 'origin', 'main', 'branch');
  const mainTip = refs(w.origin, 'refs/heads/main');
  const probe = mergeTree(w.clone, mainTip, w.head);
  expect(probe.code).toBe(1);
  git(w.clone, 'update-ref', '-d', 'refs/remotes/origin/branch');
  let guardsRan = false;
  const report = await directMerge(w.options, {
    runner: isolated,
    verification: w.verification,
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
const race = await outcomeOf(async () => {
  const w = await world();
  let racing = '';
  const report = await directMerge(w.options, {
    runner: isolated,
    verification: w.verification,
    // The guards run after the fetch and before the push, so this is the window.
    guards: () => {
      racing = commit(w.other, 'racing.txt', 'racing\n', 'Race main');
      git(w.other, 'push', '-q', 'origin', 'main');
      return guardsPass();
    },
  });
  expect(report).toMatchObject({ merged: false, mergeCommit: null, failedStep: 'merge' });
  const verification = loadDeliveryVerification(w.options.verification, w.verification);
  expect(
    readExecutionSnapshot(verification.state).operations[verification.request.operationId],
  ).toMatchObject({
    outcome: 'unknown',
    observed: { state: 'pending-provider-outcome', reviewedHead: w.head },
  });
  expect(refs(w.origin, 'refs/heads/main')).toBe(racing);
  expect(refs(w.origin, 'refs/heads/branch')).toBe(w.head);
});

// An overlapping commit that reaches main after the head's evidence is refused by the landing queue,
// inside the merge lock the push holds, with the files named. One that touches nothing the plan
// reaches is not refused by the queue.
const queueOverlap = await outcomeOf(async () => {
  const w = await world();
  commit(w.other, 'bun.lock', 'lock\n', 'Change the lockfile on main');
  git(w.other, 'push', '-q', 'origin', 'main');
  const lockDirectory = w.options.lockDirectory ?? '';
  let heldDuringQueue = false;
  const watching: Runner = (command, options) => {
    if (command[1] === 'rev-list') heldDuringQueue = existsSync(lockDirectory);
    return isolated(command, options);
  };
  const mainTip = refs(w.origin, 'refs/heads/main');
  const report = await directMerge(w.options, {
    runner: watching,
    verification: w.verification,
    guards: guardsPass,
    // No green main.yml run covers the new commit.
    mainRuns: () => [],
  });
  expect(report).toMatchObject({ merged: false, mergeCommit: null, failedStep: 'queue' });
  expect(report.detail).toContain('bun.lock');
  expect(heldDuringQueue).toBe(true);
  expect(refs(w.origin, 'refs/heads/main')).toBe(mainTip);
  expect(refs(w.origin, 'refs/heads/branch')).toBe(w.head);
});

// Main moves after the evidence with a commit outside the plan's scope: the landing queue says LAND,
// and the integration-tree check accepts the merged tree because Git shows it is the attested tree
// plus main's new commit. No new evidence run is needed.
const queueLand = await outcomeOf(async () => {
  const w = await world();
  const notes = commit(w.other, 'notes.txt', 'notes\n', 'Unrelated file on main');
  git(w.other, 'push', '-q', 'origin', 'main');
  const report = await directMerge(w.options, {
    runner: isolated,
    verification: w.verification,
    guards: guardsPass,
  });
  expect(report).toMatchObject({ merged: true, failedStep: null, detail: null, base: notes });
  const merged = report.mergeCommit ?? '';
  expect(git(w.origin, 'rev-list', '--parents', '-n', '1', merged).split(' ')).toEqual([
    merged,
    notes,
  ]);
  expect(git(w.origin, 'ls-tree', '--name-only', merged).split('\n')).toEqual([
    'feature.txt',
    'moved.txt',
    'notes.txt',
    'package.json',
    'shared.txt',
  ]);
  // The durable receipt keeps the attested identity and names the pushed base and tree.
  const verification = loadDeliveryVerification(w.options.verification, w.verification);
  const observed = readExecutionSnapshot(verification.state).operations[
    verification.request.operationId
  ]?.observed as { base: string; landedBase: string; landedTree: string } | undefined;
  expect(observed?.base).toBe(verification.request.base);
  expect(observed?.landedBase).toBe(notes);
  expect(observed?.landedTree).toBe(git(w.origin, 'rev-parse', `${merged}^{tree}`));
});

// Main's own CI verified a commit that reaches the plan (the lockfile is a global input): the queue
// says LAND, and the integration-tree check accepts because Git shows the pushed tree is the
// attested tree plus main's new commit. No new evidence run is needed.
const queueLandVerified = await outcomeOf(async () => {
  const w = await world();
  const lock = commit(w.other, 'bun.lock', 'lock\n', 'Change the lockfile on main');
  git(w.other, 'push', '-q', 'origin', 'main');
  let reads = 0;
  const report = await directMerge(w.options, {
    runner: isolated,
    verification: w.verification,
    guards: guardsPass,
    mainRuns: () => {
      reads += 1;
      return [{ sha: lock, id: '4242', status: 'completed', conclusion: 'success' }];
    },
  });
  expect(reads).toBe(1);
  expect(report).toMatchObject({ merged: true, failedStep: null, detail: null, base: lock });
  expect(report.verifiedOnMain?.join('\n')).toContain('main.yml run 4242');
  expect(report.verifiedOnMain?.join('\n')).toContain(lock.slice(0, 12));
  const merged = report.mergeCommit ?? '';
  // The merged tree is the attested tree plus main's commit: what merging the head onto the new
  // main gives, and it holds the lockfile.
  expect(git(w.origin, 'rev-parse', `${merged}^{tree}`)).toBe(
    mergeTree(w.other, lock, w.head).first,
  );
  expect(git(w.origin, 'ls-tree', '--name-only', merged).split('\n')).toEqual([
    'bun.lock',
    'feature.txt',
    'moved.txt',
    'package.json',
    'shared.txt',
  ]);
  const verification = loadDeliveryVerification(w.options.verification, w.verification);
  const observed = readExecutionSnapshot(verification.state).operations[
    verification.request.operationId
  ]?.observed as { base: string; landedBase: string } | undefined;
  expect(observed?.base).toBe(verification.request.base);
  expect(observed?.landedBase).toBe(lock);
});

// The same verified commit, but main also gained a merge whose own change no commit's file list
// shows: the pushed tree holds something besides the attested tree plus main's commits, so the
// verified commit does not excuse it.
const queueVerifiedButTreeDiffers = await outcomeOf(async () => {
  const w = await world(false, true, {
    afterEvidence: (other) => {
      commit(other, 'bun.lock', 'lock\n', 'Change the lockfile on main');
      git(other, 'checkout', '-q', '-b', 'side');
      commit(other, 'side.txt', 'side\n', 'A side commit');
      git(other, 'checkout', '-q', 'main');
      git(other, 'merge', '-q', '--no-ff', '--no-commit', 'side');
      writeFileSync(join(other, 'evil.txt'), 'evil\n');
      git(other, 'add', 'evil.txt');
      git(other, 'commit', '-q', '-m', 'Merge side, with a change only the merge makes');
      git(other, 'push', '-q', 'origin', 'main');
      return undefined;
    },
  });
  const tip = refs(w.origin, 'refs/heads/main');
  const mainTip = tip;
  const report = await directMerge(w.options, {
    runner: isolated,
    verification: w.verification,
    guards: guardsPass,
    mainRuns: () => [{ sha: tip, id: '4243', status: 'completed', conclusion: 'success' }],
  });
  expect(report).toMatchObject({ merged: false, mergeCommit: null, failedStep: 'verification' });
  expect(report.detail).toContain('the trees differ outside main');
  expect(refs(w.origin, 'refs/heads/main')).toBe(mainTip);
  expect(refs(w.origin, 'refs/heads/branch')).toBe(w.head);
});

// A provider that cannot be read verifies nothing: the queue refuses, never lands.
const queueProviderFails = await outcomeOf(async () => {
  const w = await world();
  commit(w.other, 'bun.lock', 'lock\n', 'Change the lockfile on main');
  git(w.other, 'push', '-q', 'origin', 'main');
  const mainTip = refs(w.origin, 'refs/heads/main');
  const report = await directMerge(w.options, {
    runner: isolated,
    verification: w.verification,
    guards: guardsPass,
    mainRuns: () => {
      throw new Error('gh run list failed: HTTP 502');
    },
  });
  expect(report).toMatchObject({ merged: false, mergeCommit: null, failedStep: 'queue' });
  expect(report.detail).toContain('the queue could not verify main');
  expect(report.detail).toContain('bun.lock');
  expect(refs(w.origin, 'refs/heads/main')).toBe(mainTip);
});

const planWithoutShared = (): EvidencePlan => ({
  changed: ['feature.txt'],
  unit_tests: [],
  root_checks: ['lint:root', 'typecheck:root'],
  fixture_slugs: [],
  fixture_specs: [],
  e2e_specs: [],
  requires_full_run: false,
  full_run_rules: [],
});

/** Lands a world whose `main` moved, expecting the refusal at `verification` and `main` untouched. */
async function refusedAtVerification(
  w: World,
  detail: string,
  partial: { evidencePlan?: () => EvidencePlan } = {},
): Promise<void> {
  const mainTip = refs(w.origin, 'refs/heads/main');
  const report = await directMerge(w.options, {
    runner: isolated,
    verification: w.verification,
    guards: guardsPass,
    ...partial,
  });
  expect(report).toMatchObject({ merged: false, mergeCommit: null, failedStep: 'verification' });
  expect(report.detail).toContain(detail);
  expect(refs(w.origin, 'refs/heads/main')).toBe(mainTip);
  expect(refs(w.origin, 'refs/heads/branch')).toBe(w.head);
}

// (b) The head merged onto the attested base must reproduce the attested tree. Here the attested
// tree is the right one for the pushed base, not for the attested base.
const attestedTreeNotReproduced = await outcomeOf(async () => {
  const w = await world(false, true, {
    afterEvidence: (other, { head }) => {
      const notes = commit(other, 'notes.txt', 'notes\n', 'Unrelated file on main');
      git(other, 'push', '-q', 'origin', 'main');
      return mergeTree(other, notes, head).first;
    },
  });
  await refusedAtVerification(w, 'does not give the attested tree');
});

// (c) A path main's new commits touch must be one the queue classified. The head integrated a later
// main commit than the attested base names, so that commit's path is main's, yet outside the range
// the queue classified (it starts at the merge-base with the head).
const unclassifiedPath = await outcomeOf(async () => {
  const w = await world(false, true, { lateMain: true });
  await refusedAtVerification(w, 'the queue did not classify early.txt');
});

// (d) The pushed tree may differ from the attested tree only at paths main's new commits touch. An
// evil merge on main changes `evil.txt` in the merge commit alone, which no commit's file list shows.
const differsOutsideIncoming = await outcomeOf(async () => {
  const w = await world(false, true, {
    afterEvidence: (other) => {
      git(other, 'checkout', '-q', '-b', 'side');
      commit(other, 'side.txt', 'side\n', 'A side commit');
      git(other, 'checkout', '-q', 'main');
      git(other, 'merge', '-q', '--no-ff', '--no-commit', 'side');
      writeFileSync(join(other, 'evil.txt'), 'evil\n');
      git(other, 'add', 'evil.txt');
      git(other, 'commit', '-q', '-m', 'Merge side, with a change only the merge makes');
      git(other, 'push', '-q', 'origin', 'main');
      return undefined;
    },
  });
  await refusedAtVerification(w, 'the trees differ outside main');
});

// (d) At each path main's new commits touch, the pushed tree must hold what main holds. The branch
// and main both edit `shared.txt` (different lines), so the merge holds both edits, not main's.
const incomingContentDiffers = await outcomeOf(async () => {
  const w = await world(false, true, {
    branchEditsShared: true,
    afterEvidence: (other) => {
      commit(other, 'shared.txt', 'one\ntwo\nmain\n', 'Edit shared line three on main');
      git(other, 'push', '-q', 'origin', 'main');
      return undefined;
    },
  });
  await refusedAtVerification(w, 'shared.txt is not what main holds', {
    evidencePlan: planWithoutShared,
  });
});

// Main deletes an unrelated file and adds a path Git quotes (non-ASCII), after the evidence: the
// landing succeeds, with the deletion and the new path in the merged tree.
const deletionAndQuotedPath = await outcomeOf(async () => {
  const w = await world(false, true, {
    afterEvidence: (other) => {
      git(other, 'rm', '-q', 'moved.txt');
      writeFileSync(join(other, 'naïve.txt'), 'naive\n');
      git(other, 'add', 'naïve.txt');
      git(other, 'commit', '-q', '-m', 'Delete moved.txt and add a non-ASCII path on main');
      git(other, 'push', '-q', 'origin', 'main');
      return undefined;
    },
  });
  const report = await directMerge(w.options, {
    runner: isolated,
    verification: w.verification,
    guards: guardsPass,
  });
  expect(report).toMatchObject({ merged: true, failedStep: null, detail: null });
  const names = git(w.origin, 'ls-tree', '-z', '--name-only', report.mergeCommit ?? '').split('\0');
  expect(names).toContain('naïve.txt');
  expect(names).not.toContain('moved.txt');
  expect(names).toContain('feature.txt');
});

// Movement the queue did not classify stays refused: main is rewritten so the attested base is no
// longer an ancestor, although the only new commit (`notes.txt`) is outside the plan's scope.
const queueMismatch = await outcomeOf(async () => {
  const w = await world();
  git(w.other, 'checkout', '-q', 'main');
  git(w.other, 'reset', '-q', '--hard', 'HEAD~1');
  commit(w.other, 'notes.txt', 'notes\n', 'Rewrite main without the attested commit');
  git(w.other, 'push', '-q', '--force', 'origin', 'main');
  const mainTip = refs(w.origin, 'refs/heads/main');
  const report = await directMerge(w.options, {
    runner: isolated,
    verification: w.verification,
    guards: guardsPass,
  });
  expect(report).toMatchObject({ merged: false, mergeCommit: null, failedStep: 'verification' });
  expect(report.detail).toContain('cannot be shown to be the attested tree');
  expect(refs(w.origin, 'refs/heads/main')).toBe(mainTip);
  expect(refs(w.origin, 'refs/heads/branch')).toBe(w.head);
});

// A failed branch delete is its own named step, and the merge stands.
const deleteDenied = await outcomeOf(async () => {
  const w = await world();
  git(w.origin, 'config', 'receive.denyDeletes', 'true');
  const report = await directMerge(w.options, {
    runner: isolated,
    guards: guardsPass,
    verification: w.verification,
  });
  expect(report).toMatchObject({ merged: true, failedStep: 'delete' });
  expect(report.detail).toContain('deleting origin/branch failed');
  const merged = report.mergeCommit ?? '';
  expect(merged).toMatch(/^[0-9a-f]{40}$/);
  expect(refs(w.origin, 'refs/heads/main')).toBe(merged);
  expect(refs(w.origin, 'refs/heads/branch')).toBe(w.head);
  git(w.other, 'checkout', '-q', 'branch');
  const newer = commit(w.other, 'newer.txt', 'unmerged work\n', 'New work after delivery');
  git(w.other, 'push', '-q', 'origin', 'branch');
  git(w.origin, 'config', 'receive.denyDeletes', 'false');
  const retried = await directMerge(w.options, {
    runner: isolated,
    guards: guardsPass,
    verification: w.verification,
  });
  expect(retried).toMatchObject({ merged: true, failedStep: 'delete', mergeCommit: merged });
  expect(refs(w.origin, 'refs/heads/branch')).toBe(newer);
  expect(refs(w.origin, 'refs/heads/main')).toBe(merged);
  const substituted = await directMerge(
    { ...w.options, head: newer },
    {
      runner: isolated,
      guards: guardsPass,
      verification: w.verification,
    },
  );
  expect(substituted).toMatchObject({ merged: false, failedStep: 'recovery' });
  expect(refs(w.origin, 'refs/heads/branch')).toBe(newer);
  expect(refs(w.origin, 'refs/heads/main')).toBe(merged);
});

const guardsFail = (findings: string[]): GuardsResult => ({
  ok: false,
  failures: [{ guard: 'check-a', findings, output: findings.join(' | ') }],
});

// A guard that already fails on `origin/main` does not hold up a change that adds nothing to it: the
// squash commit is merged, and the report names the guard and the count as already failing.
const inheritedFailure = await outcomeOf(async () => {
  const w = await world();
  const mainBefore = refs(w.origin, 'refs/heads/main');
  const seen: { revision: string; only: readonly string[] | undefined }[] = [];
  const report = await directMerge(w.options, {
    runner: isolated,
    verification: w.verification,
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
const newFinding = await outcomeOf(async () => {
  const w = await world();
  const mainBefore = refs(w.origin, 'refs/heads/main');
  const pushes: string[][] = [];
  const recordingRunner: Runner = (command, options) => {
    if (command[0] === 'git' && command[1] === 'push') pushes.push(command);
    return isolated(command, options);
  };
  const report = await directMerge(w.options, {
    runner: recordingRunner,
    verification: w.verification,
    guards: (revision) =>
      revision === mainBefore ? guardsFail(['x:1']) : guardsFail(['x:1', 'z:3']),
  });
  expect(report).toMatchObject({ merged: false, mergeCommit: null, failedStep: 'guards' });
  expect(report.guardsAlreadyFailing).toBeUndefined();
  expect(refs(w.origin, 'refs/heads/main')).toBe(mainBefore);
  expect(refs(w.origin, 'refs/heads/branch')).toBe(w.head);
  expect(pushes).toEqual([]);
  const verification = loadDeliveryVerification(w.options.verification, w.verification);
  expect(
    readExecutionSnapshot(verification.state).operations[verification.request.operationId]?.outcome,
  ).toBe('intent');
  const retried = await directMerge(w.options, {
    runner: recordingRunner,
    verification: w.verification,
    guards: guardsPass,
  });
  expect(retried).toMatchObject({ merged: true, failedStep: null });
  expect(pushes.filter((command) => command[3] !== '--delete')).toHaveLength(1);
  expect(retried.mergeCommit).toBe(refs(w.origin, 'refs/heads/main'));
});

// A pinned head that is not the branch's head is refused before anything else happens.
const wrongHead = await outcomeOf(async () => {
  const w = await world();
  const report = await directMerge(
    { ...w.options, head: 'f'.repeat(40) },
    { runner: isolated, guards: guardsPass, verification: w.verification },
  );
  expect(report).toMatchObject({ merged: false, failedStep: 'head' });
  expect(refs(w.origin, 'refs/heads/branch')).toBe(w.head);
});

// The merge lock is held from before the fetch to after the delete, and released after each outcome.
const lock = await outcomeOf(async () => {
  const w = await world();
  const lockDirectory = w.options.lockDirectory ?? '';
  let heldDuringGuards = false;
  const refused = await directMerge(
    { ...w.options, head: 'f'.repeat(40) },
    { runner: isolated, guards: guardsPass, verification: w.verification },
  );
  expect(refused).toMatchObject({ merged: false, failedStep: 'head' });
  expect(existsSync(lockDirectory)).toBe(false);
  const merged = await directMerge(w.options, {
    runner: isolated,
    verification: w.verification,
    guards: () => {
      heldDuringGuards = existsSync(lockDirectory);
      return guardsPass();
    },
  });
  expect(merged).toMatchObject({ merged: true, failedStep: null });
  expect(heldDuringGuards).toBe(true);
  expect(existsSync(lockDirectory)).toBe(false);
});

const cancelledBeforeMerge = await outcomeOf(async () => {
  const w = await world();
  const authority = loadDeliveryVerification(w.options.verification, w.verification).request
    .authority;
  const mutations: string[][] = [];
  const mainBefore = refs(w.origin, 'refs/heads/main');
  const queued = await withMergeLock(
    {
      worktree: w.clone,
      lockDirectory: w.options.lockDirectory,
      command: 'hold before cancellation',
    },
    async () => {
      const refusal = throwingRejectionOf(
        directMerge(w.options, {
          verification: w.verification,
          guards: guardsPass,
          runner: (command, options) => {
            if (command[0] === 'git' && command[1] === 'push') mutations.push(command);
            return isolated(command, options);
          },
        }),
      );
      expect(await cancelDispatch(w.verification.state, authority)).toBe(true);
      const replacement = await acquireDispatch(w.verification.state, {
        ...authority,
        ownerId: 'replacement',
      });
      expect(replacement.granted).toBe(true);
      return { refusal, replacement };
    },
    isolated,
  );
  expect(await queued.refusal).toThrow('newer generation');
  expect(mutations).toEqual([]);
  expect(refs(w.origin, 'refs/heads/main')).toBe(mainBefore);
  if (!queued.replacement.granted) throw new Error(queued.replacement.reason);
  expect(requireAuthority(w.verification.state, queued.replacement.authority)).toEqual(
    queued.replacement.authority,
  );
});

const cancelledDuringMerge = await outcomeOf(async () => {
  const w = await world();
  const authority = loadDeliveryVerification(w.options.verification, w.verification).request
    .authority;
  const providerLock = join(
    w.verification.state.lockDirectory,
    `${encodeURIComponent(authority.resource)}.provider-transition.lock`,
  );
  const events: string[] = [];
  let cancellation: Promise<boolean> | undefined;
  const report = await directMerge(w.options, {
    verification: w.verification,
    guards: guardsPass,
    runner: (command, options) => {
      if (command[0] === 'git' && command[1] === 'push') {
        expect(existsSync(providerLock)).toBe(true);
        expect(requireAuthority(w.verification.state, authority)).toEqual(authority);
        cancellation ??= cancelDispatch(w.verification.state, authority).then((result) => {
          events.push('cancelled');
          return result;
        });
        events.push(command.includes('--delete') ? 'delete' : 'merge');
      }
      return isolated(command, options);
    },
  });
  expect(report).toMatchObject({ merged: true, failedStep: null });
  expect(cancellation).toBeDefined();
  expect(await cancellation).toBe(true);
  expect(events).toEqual(['merge', 'delete', 'cancelled']);
  expect(existsSync(providerLock)).toBe(false);
});

describe('directMerge against real Git', () => {
  test('refuses a queued delivery after cancellation and owner replacement', () => {
    rethrow(cancelledBeforeMerge);
  });

  test('holds authority through both pushes before cancellation can settle', () => {
    rethrow(cancelledDuringMerge);
  });
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

  test('a guard refusal records no merge attempt and the original operation remains retryable', () => {
    rethrow(newFinding);
  });

  test('refuses, inside the merge lock, an overlapping commit that reached main after the evidence', () => {
    rethrow(queueOverlap);
  });

  test('lands without a new run when main moved only outside the plan scope, and the tree is proven', () => {
    rethrow(queueLand);
  });

  test('lands without a new run when main moved with a commit main CI had already verified, and the tree is proven', () => {
    rethrow(queueLandVerified);
  });

  test('still refuses a verified moved main whose pushed tree holds anything besides the attested tree and main commits', () => {
    rethrow(queueVerifiedButTreeDiffers);
  });

  test('refuses at the queue when main CI cannot be read, never landing on a guess', () => {
    rethrow(queueProviderFails);
  });

  test('still refuses a moved main whose tree is not the attested tree plus its new commits', () => {
    rethrow(queueMismatch);
  });

  test('refuses when the head merged onto the attested base does not reproduce the attested tree', () => {
    rethrow(attestedTreeNotReproduced);
  });

  test('refuses when main touches a path the queue did not classify', () => {
    rethrow(unclassifiedPath);
  });

  test('refuses when the pushed tree differs from the attested tree outside main new commits', () => {
    rethrow(differsOutsideIncoming);
  });

  test('refuses when the pushed tree holds other content than main at a path main changed', () => {
    rethrow(incomingContentDiffers);
  });

  test('lands when main deleted an unrelated file and added a non-ASCII path', () => {
    rethrow(deletionAndQuotedPath);
  });

  test('a head that is not the pinned one is refused at head', () => {
    rethrow(wrongHead);
  });

  test('holds the merge lock across the guards and releases it on a refusal and on a merge', () => {
    rethrow(lock);
  });
});

const untestedIntegration = await outcomeOf(async () => {
  const candidate = await world(false, false);
  const before = refs(candidate.origin, 'refs/heads/main');
  const result = await directMerge(candidate.options, {
    runner: isolated,
    guards: guardsPass,
    verification: candidate.verification,
  });
  expect(result).toMatchObject({ merged: false, failedStep: 'verification' });
  expect(refs(candidate.origin, 'refs/heads/main')).toBe(before);
  expect(refs(candidate.origin, 'refs/heads/branch')).toBe(candidate.head);
});
test('refuses a divergent main tree that the branch provider run never checked', () =>
  rethrow(untestedIntegration));
