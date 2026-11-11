import { expect } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnWithHangGuard } from '../../testing/testing/src/hang-guard.ts';
import { waitUntil } from '../../testing/testing/src/wait-until.ts';
import { defaultRunner, type Runner } from './process-runner.ts';
import { createScenarios } from './scenario.test-support.ts';
import { Refusal, removeWorktree, run, staleWorktrees } from './worktree.ts';

/**
 * `worktree.ts stale` and the `deliveredTip` rule of `remove` against real Git repositories (a
 * bare origin and a clone) and a real `sleep` child. The main checkout is injected, as in
 * `worktree.slow.test.ts`.
 */

let sandbox = '';
let checkout = '';
let configPath = '';
let roots = { claude: '', codex: '' };
const children: ReturnType<typeof spawnWithHangGuard>[] = [];

const gitEnvironment = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

function git(cwd: string, ...args: string[]) {
  const result = defaultRunner(['git', ...args], { cwd, env: gitEnvironment });
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function setUp() {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'stale-')));
  const origin = join(sandbox, 'origin.git');
  checkout = join(sandbox, 'checkout');
  roots = { claude: join(sandbox, 'roots', 'claude'), codex: join(sandbox, 'roots', 'codex') };
  configPath = join(sandbox, 'config.json');
  mkdirSync(origin);
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  git(sandbox, 'clone', '-q', origin, checkout);
  writeFileSync(join(checkout, 'file.txt'), 'one\n');
  git(checkout, 'add', '.');
  git(checkout, 'commit', '-q', '-m', 'initial');
  git(checkout, 'push', '-q', 'origin', 'HEAD:main');
  writeFileSync(
    configPath,
    JSON.stringify({
      repository: 'o/n',
      defaultBranch: 'main',
      worktreeRoots: roots,
      manifestName: 'demo',
      installCommand: 'true',
      gateCommand: 'true',
      affectedCheckCommand: 'true',
      mergeMethod: 'squash',
    }),
  );
}

async function tearDown() {
  for (const child of children.splice(0)) {
    child.kill();
    await child.exited;
  }
  rmSync(sandbox, { recursive: true, force: true });
}

const scenarios = createScenarios({ setUp, tearDown });

/** A worktree under the claude root on a new branch with one commit of its own. */
function addWorktree(name: string, commit = true): string {
  const path = join(roots.claude, name);
  git(checkout, 'worktree', 'add', '-q', '-b', `work/${name}`, path, 'origin/main');
  if (commit) {
    writeFileSync(join(path, `${name}.txt`), `${name}\n`);
    git(path, 'add', '.');
    git(path, 'commit', '-q', '-m', name);
  }
  return path;
}

/** Squash-merge `work/<name>` into main and push it: the branch tip stays outside main's history. */
function squashMerge(name: string) {
  git(checkout, 'merge', '--squash', `work/${name}`);
  git(checkout, 'commit', '-q', '-m', `squash ${name}`);
  git(checkout, 'push', '-q', 'origin', 'main');
}

/** Real Git; GitHub is answered with "no pull request", so no test reaches the network. */
const runner: Runner = (command, options) =>
  command[0] === 'gh'
    ? { code: 1, stdout: '', stderr: 'no pull requests found' }
    : defaultRunner(command, options);
const dependencies = () => ({ checkout, runner });
const list = (options: { remove?: boolean; currentDirectory?: string } = {}) =>
  staleWorktrees(
    { configPath, remove: options.remove ?? false, currentDirectory: sandbox },
    dependencies(),
  ).entries;
const entryFor = (path: string, remove = false) => {
  const found = list({ remove }).find((entry) => entry.path === path);
  if (found === undefined) throw new Error(`${path} was not listed`);
  return found;
};

scenarios.describe('stale: the delivered test', () => {
  scenarios.scenario('a branch whose tip is in origin/main is delivered by ancestry', () => {
    const path = addWorktree('merged');
    git(checkout, 'merge', '-q', '--ff-only', 'work/merged');
    git(checkout, 'push', '-q', 'origin', 'main');
    expect(entryFor(path)).toMatchObject({
      delivered: true,
      deliveredBy: 'ancestor',
      clean: true,
      locked: false,
      processes: 0,
      keep: [],
      branch: 'work/merged',
    });
  });

  scenarios.scenario(
    'a squash-merged branch that was never pushed is delivered by its changes being in main',
    () => {
      const path = addWorktree('squashed');
      squashMerge('squashed');
      expect(entryFor(path)).toMatchObject({
        delivered: true,
        deliveredBy: 'changes-in-default',
        keep: [],
      });
    },
  );

  scenarios.scenario(
    'a squash-merged branch whose remote branch still exists is not delivered until it is pruned',
    () => {
      const path = addWorktree('pushed');
      git(path, 'push', '-q', 'origin', 'work/pushed');
      squashMerge('pushed');
      expect(entryFor(path)).toMatchObject({ delivered: false, deliveredBy: 'none' });
      git(checkout, 'push', '-q', 'origin', '--delete', 'work/pushed');
      git(checkout, 'fetch', '-q', '--prune', 'origin');
      expect(entryFor(path)).toMatchObject({ delivered: true, deliveredBy: 'changes-in-default' });
    },
  );

  scenarios.scenario('a branch with a change main does not have is not delivered', () => {
    const path = addWorktree('open');
    const entry = entryFor(path);
    expect(entry).toMatchObject({ delivered: false, deliveredBy: 'none' });
    expect(entry.keep).toEqual(['branch not delivered']);
  });

  scenarios.scenario('a branch that conflicts with main is not delivered', () => {
    const path = addWorktree('conflict', false);
    writeFileSync(join(path, 'file.txt'), 'branch\n');
    git(path, 'commit', '-q', '-am', 'branch edit');
    writeFileSync(join(checkout, 'file.txt'), 'main\n');
    git(checkout, 'commit', '-q', '-am', 'main edit');
    git(checkout, 'push', '-q', 'origin', 'main');
    expect(entryFor(path).delivered).toBe(false);
  });
});

scenarios.describe('stale: what is kept', () => {
  scenarios.scenario('lists only worktrees under the roots, never the main checkout', () => {
    const inside = addWorktree('inside');
    const outside = join(sandbox, 'elsewhere');
    git(checkout, 'worktree', 'add', '-q', '-b', 'work/outside', outside, 'origin/main');
    expect(list().map((entry) => entry.path)).toEqual([inside]);
  });

  scenarios.scenario(
    'keeps a dirty, a locked and the current worktree, each for its own reason',
    () => {
      const dirty = addWorktree('dirty');
      writeFileSync(join(dirty, 'scratch.txt'), 'x');
      const locked = addWorktree('locked');
      git(checkout, 'worktree', 'lock', '--reason', 'live session', locked);
      const current = addWorktree('current');
      for (const name of ['dirty', 'locked', 'current']) {
        git(checkout, 'merge', '-q', '--no-edit', `work/${name}`);
      }
      git(checkout, 'push', '-q', 'origin', 'main');
      const entries = staleWorktrees(
        {
          configPath,
          remove: false,
          currentDirectory: join(current, 'nested-that-does-not-exist'),
        },
        dependencies(),
      ).entries;
      const byPath = new Map(entries.map((entry) => [entry.path, entry]));
      expect(byPath.get(dirty)?.keep).toEqual(['uncommitted or untracked changes']);
      expect(byPath.get(locked)?.keep).toEqual(['locked']);
      expect(byPath.get(current)?.keep).toEqual(['it is the worktree this command runs from']);
    },
  );

  scenarios.scenario(
    'keeps a worktree with a live process inside it, and frees it once the process ends',
    async () => {
      const path = addWorktree('busy');
      git(checkout, 'merge', '-q', '--ff-only', 'work/busy');
      git(checkout, 'push', '-q', 'origin', 'main');
      const child = spawnWithHangGuard(['sleep', '60'], { cwd: path });
      children.push(child);
      await waitUntil(() => (entryFor(path).processes ?? 0) > 0, {
        message: 'sleep to hold the cwd',
      });
      expect(entryFor(path).keep[0]).toMatch(/live process/);
      child.kill();
      await child.exited;
      await waitUntil(() => entryFor(path).processes === 0, {
        message: 'sleep to release the cwd',
      });
      expect(entryFor(path).keep).toEqual([]);
    },
  );
});

scenarios.describe('stale --remove', () => {
  scenarios.scenario(
    'removes exactly the clean, unlocked, idle, delivered worktrees and keeps the rest',
    () => {
      const merged = addWorktree('merged');
      const squashed = addWorktree('squashed');
      const open = addWorktree('open');
      const dirty = addWorktree('dirty');
      writeFileSync(join(dirty, 'scratch.txt'), 'x');
      git(checkout, 'merge', '-q', '--ff-only', 'work/merged');
      git(checkout, 'push', '-q', 'origin', 'main');
      squashMerge('squashed');
      git(checkout, 'merge', '-q', '--no-edit', 'work/dirty');
      git(checkout, 'push', '-q', 'origin', 'main');
      git(checkout, 'push', '-q', 'origin', 'work/merged');

      const result = staleWorktrees(
        { configPath, remove: true, currentDirectory: sandbox },
        dependencies(),
      );
      expect(result.removed.map((item) => item.path).toSorted()).toEqual(
        [merged, squashed].toSorted(),
      );
      expect(result.refused).toEqual([]);
      expect(existsSync(merged)).toBe(false);
      expect(existsSync(squashed)).toBe(false);
      expect(existsSync(open)).toBe(true);
      expect(existsSync(dirty)).toBe(true);
      expect(git(checkout, 'branch', '--list', 'work/merged', 'work/squashed')).toBe('');
      expect(git(checkout, 'branch', '--list', 'work/open')).toContain('work/open');
      // A bulk removal never deletes a remote branch.
      expect(git(checkout, 'ls-remote', '--heads', 'origin', 'work/merged')).toContain(
        'work/merged',
      );
      expect(existsSync(checkout)).toBe(true);
    },
  );

  scenarios.scenario('the listing alone changes nothing', () => {
    const path = addWorktree('merged');
    git(checkout, 'merge', '-q', '--ff-only', 'work/merged');
    git(checkout, 'push', '-q', 'origin', 'main');
    expect(entryFor(path).keep).toEqual([]);
    expect(existsSync(path)).toBe(true);
    expect(git(checkout, 'branch', '--list', 'work/merged')).toContain('work/merged');
  });

  scenarios.scenario(
    'the command line prints a line per worktree, the totals and what it removed, and --json both',
    () => {
      const merged = addWorktree('merged');
      const open = addWorktree('open');
      git(checkout, 'merge', '-q', '--ff-only', 'work/merged');
      git(checkout, 'push', '-q', 'origin', 'main');
      const listing = run(['stale', '--config', configPath], dependencies());
      expect(listing.code).toBe(0);
      expect(listing.output).toContain(`${merged}: work/merged`);
      expect(listing.output).toContain('-> removable');
      expect(listing.output).toContain('-> kept: branch not delivered');
      expect(listing.output).toContain('2 worktree(s): 1 delivered, 1 removable, 0 locked');
      const json = JSON.parse(
        run(['stale', '--config', configPath, '--json'], dependencies()).output,
      );
      expect(json.entries).toHaveLength(2);
      const removal = run(['stale', '--config', configPath, '--remove'], dependencies());
      expect(removal.output).toContain(`removed ${merged} (work/merged)`);
      expect(removal.output).toContain('removed 1, kept 1');
      expect(existsSync(open)).toBe(true);
      const removalJson = JSON.parse(
        run(['stale', '--config', configPath, '--remove', '--json'], dependencies()).output,
      );
      expect(removalJson).toMatchObject({ removed: [], refused: [] });
    },
  );
});

scenarios.describe('remove with deliveredTip', () => {
  const removeAbsolute = (path: string, deliveredTip?: string) =>
    removeWorktree({ configPath, name: path, keepRemote: true, deliveredTip }, dependencies());

  scenarios.scenario(
    'a squash merge leaves the tip outside main, so remove refuses it without the fact',
    () => {
      const path = addWorktree('squashed');
      squashMerge('squashed');
      expect(() => removeAbsolute(path)).toThrow(Refusal);
      expect(existsSync(path)).toBe(true);
    },
  );

  scenarios.scenario('passes when the tip is the delivered commit, under any provider root', () => {
    const path = addWorktree('squashed');
    squashMerge('squashed');
    const tip = git(path, 'rev-parse', 'HEAD');
    expect(removeAbsolute(path, tip).path).toBe(path);
    expect(existsSync(path)).toBe(false);
  });

  scenarios.scenario('does not weaken the check for a tip that moved after the delivery', () => {
    const path = addWorktree('squashed');
    squashMerge('squashed');
    const delivered = git(path, 'rev-parse', 'HEAD');
    writeFileSync(join(path, 'later.txt'), 'later\n');
    git(path, 'add', '.');
    git(path, 'commit', '-q', '-m', 'later');
    expect(() => removeAbsolute(path, delivered)).toThrow('not delivered');
    expect(existsSync(path)).toBe(true);
  });

  scenarios.scenario('the command line needs no --provider for an absolute path', () => {
    const path = addWorktree('merged');
    git(checkout, 'merge', '-q', '--ff-only', 'work/merged');
    git(checkout, 'push', '-q', 'origin', 'main');
    const result = run(['remove', '--config', configPath, '--name', path, '--keep-remote'], {
      checkout,
      runner,
    });
    expect(result.code).toBe(0);
    expect(existsSync(path)).toBe(false);
  });

  scenarios.scenario('still refuses a locked, a dirty and an out-of-roots worktree', () => {
    const locked = addWorktree('locked');
    git(checkout, 'worktree', 'lock', locked);
    const dirty = addWorktree('dirty');
    writeFileSync(join(dirty, 'scratch.txt'), 'x');
    const outside = join(sandbox, 'elsewhere');
    git(checkout, 'worktree', 'add', '-q', '-b', 'work/outside', outside, 'origin/main');
    for (const path of [locked, dirty, outside]) {
      expect(() => removeAbsolute(path, git(path, 'rev-parse', 'HEAD'))).toThrow(Refusal);
      expect(existsSync(path)).toBe(true);
    }
  });
});

await scenarios.settled();
