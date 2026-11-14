import { expect } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnWithHangGuard } from '../../testing/testing/src/hang-guard.ts';
import { waitUntil } from '../../testing/testing/src/wait-until.ts';
import { recordDelivery } from './delivery-ledger.ts';
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
  writeFileSync(join(checkout, '.gitignore'), 'tmp/\nnode_modules/\n');
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
      // `stale --remove` never deletes a branch.
      expect(git(checkout, 'branch', '--list', 'work/merged')).toContain('work/merged');
      expect(git(checkout, 'branch', '--list', 'work/squashed')).toContain('work/squashed');
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

const agentReason = (id: string) => `claude agent ${id} (pid 86565 start Tue Nov 10 19:59:31 2026)`;
const ghAnswering = (heads: string[], failing = false): Runner => {
  return (command, options) =>
    command[0] === 'gh'
      ? failing
        ? { code: 1, stdout: '', stderr: 'gh is not authenticated' }
        : {
            code: 0,
            stdout: JSON.stringify(heads.map((headRefOid) => ({ headRefOid }))),
            stderr: '',
          }
      : defaultRunner(command, options);
};
const HOUR = 3_600_000;
/** A clock `hours` ahead of the real one, so the files a test just wrote are that old. */
const hoursLater = (hours: number) => () => Date.now() + hours * HOUR;
const staleWith = (customRunner: Runner, options: { remove?: boolean; hours?: number } = {}) =>
  staleWorktrees(
    { configPath, remove: options.remove ?? false, currentDirectory: sandbox },
    // By default long after the worktree's files were written, as an idle agent's would be.
    { checkout, runner: customRunner, now: hoursLater(options.hours ?? 7) },
  );
const byPath = (result: ReturnType<typeof staleWorktrees>, path: string) => {
  const found = result.entries.find((entry) => entry.path === path);
  if (found === undefined) throw new Error(`${path} was not listed`);
  return found;
};

scenarios.describe('stale: the delivery ledger and merged pull requests', () => {
  scenarios.scenario(
    'a tip equal to a ledger head is delivered, on a branch whose remote still exists',
    () => {
      const path = addWorktree('pushed');
      git(path, 'push', '-q', 'origin', 'work/pushed');
      squashMerge('pushed');
      expect(entryFor(path).delivered).toBe(false);
      recordDelivery(checkout, {
        branch: 'work/pushed',
        head: git(path, 'rev-parse', 'HEAD'),
        mergeCommit: git(checkout, 'rev-parse', 'HEAD'),
      });
      expect(entryFor(path)).toMatchObject({ delivered: true, deliveredBy: 'delivered-head' });
    },
  );

  scenarios.scenario('a detached tip is delivered by a ledger head and not without one', () => {
    const path = join(roots.claude, 'detached');
    git(checkout, 'worktree', 'add', '-q', '--detach', path, 'origin/main');
    writeFileSync(join(path, 'd.txt'), 'd\n');
    git(path, 'add', '.');
    git(path, 'commit', '-q', '-m', 'detached work');
    expect(entryFor(path)).toMatchObject({ delivered: false, branch: undefined });
    recordDelivery(checkout, {
      branch: 'work/detached',
      head: git(path, 'rev-parse', 'HEAD'),
      mergeCommit: null,
    });
    expect(entryFor(path)).toMatchObject({
      delivered: true,
      deliveredBy: 'delivered-head',
      keep: [],
    });
  });

  scenarios.scenario('an earlier commit of a delivered branch is delivered with it', () => {
    git(checkout, 'branch', 'work/two', 'origin/main');
    const path = join(roots.claude, 'earlier');
    git(checkout, 'worktree', 'add', '-q', '--detach', path, 'work/two');
    for (const name of ['first', 'second']) {
      writeFileSync(join(path, `${name}.txt`), name);
      git(path, 'add', '.');
      git(path, 'commit', '-q', '-m', name);
    }
    const second = git(path, 'rev-parse', 'HEAD');
    git(checkout, 'branch', '-f', 'work/two', second);
    git(path, 'checkout', '-q', '--detach', 'HEAD~1');
    expect(entryFor(path).delivered).toBe(false);
    recordDelivery(checkout, { branch: 'work/two', head: second, mergeCommit: null });
    expect(entryFor(path)).toMatchObject({ delivered: true, deliveredBy: 'delivered-head' });
  });

  scenarios.scenario('a tip with a commit that is in no delivered head stays undelivered', () => {
    const path = addWorktree('extra');
    const delivered = git(path, 'rev-parse', 'HEAD');
    recordDelivery(checkout, { branch: 'work/extra', head: delivered, mergeCommit: null });
    writeFileSync(join(path, 'more.txt'), 'more\n');
    git(path, 'add', '.');
    git(path, 'commit', '-q', '-m', 'work after the delivery');
    const entry = entryFor(path);
    expect(entry).toMatchObject({ delivered: false, deliveredBy: 'none' });
    expect(entry.keep).toEqual(['branch not delivered']);
  });

  scenarios.scenario('a merged pull request head delivers a tip, with one gh call', () => {
    const first = addWorktree('first');
    const second = addWorktree('second');
    git(first, 'push', '-q', 'origin', 'work/first');
    squashMerge('first');
    const calls: string[][] = [];
    const counting: Runner = (command, options) => {
      if (command[0] === 'gh') calls.push(command);
      return ghAnswering([git(first, 'rev-parse', 'HEAD')])(command, options);
    };
    const result = staleWith(counting);
    expect(byPath(result, first)).toMatchObject({ delivered: true, deliveredBy: 'delivered-head' });
    expect(byPath(result, second).delivered).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('merged');
    expect(result.notes).toEqual([]);
  });

  scenarios.scenario('a failed gh falls back to the ledger and says so', () => {
    const path = addWorktree('ledgered');
    recordDelivery(checkout, {
      branch: 'work/ledgered',
      head: git(path, 'rev-parse', 'HEAD'),
      mergeCommit: null,
    });
    const result = staleWith(ghAnswering([], true));
    expect(byPath(result, path).delivered).toBe(true);
    expect(result.notes.join('\n')).toContain('merged pull requests could not be read');
    const printed = run(['stale', '--config', configPath], {
      checkout,
      runner: ghAnswering([], true),
    });
    expect(printed.output).toContain('merged pull requests could not be read');
  });
});

scenarios.describe('stale --remove: a lock that only names a finished Agent session', () => {
  const lockedAgent = (id: string, reason = agentReason(id)) => {
    const path = addWorktree(id);
    git(checkout, 'worktree', 'lock', '--reason', reason, path);
    return path;
  };
  const ledger = (path: string) =>
    recordDelivery(checkout, {
      branch: `work/${path.split('/').pop()}`,
      head: git(path, 'rev-parse', 'HEAD'),
      mergeCommit: null,
    });

  scenarios.scenario(
    'unlocks and removes a delivered, clean, idle worktree, and deletes no branch',
    () => {
      const path = lockedAgent('agent-a1b2c3');
      ledger(path);
      const listed = staleWith(ghAnswering([]));
      expect(byPath(listed, path)).toMatchObject({ locked: true, keep: [] });
      const result = staleWith(ghAnswering([]), { remove: true });
      expect(result.removed.map((item) => item.path)).toEqual([path]);
      expect(existsSync(path)).toBe(false);
      expect(git(checkout, 'branch', '--list', 'work/agent-a1b2c3')).toContain('work/agent-a1b2c3');
    },
  );

  scenarios.scenario('the command line removes it too, with the delivered branch', () => {
    const path = lockedAgent('agent-d4e5f6');
    ledger(path);
    const removal = run(['stale', '--config', configPath, '--remove'], {
      checkout,
      runner: ghAnswering([]),
      now: hoursLater(7),
    });
    expect(removal.output).toContain(`removed ${path}`);
    expect(existsSync(path)).toBe(false);
    expect(git(checkout, 'branch', '--list', 'work/agent-d4e5f6')).toContain('work/agent-d4e5f6');
  });

  scenarios.scenario(
    'keeps an Agent worktree used within the quiet period, and frees it after',
    () => {
      const path = lockedAgent('agent-quiet');
      ledger(path);
      const recent = byPath(staleWith(ghAnswering([]), { hours: 1 }), path);
      expect(recent.keep).toHaveLength(1);
      expect(recent.keep[0]).toMatch(/^Agent lock, used \d+ minutes ago$/);
      expect(staleWith(ghAnswering([]), { remove: true, hours: 5 }).removed).toEqual([]);
      expect(existsSync(path)).toBe(true);
      expect(byPath(staleWith(ghAnswering([]), { hours: 7 }), path).keep).toEqual([]);
      expect(staleWith(ghAnswering([]), { remove: true, hours: 7 }).removed).toHaveLength(1);
    },
  );

  scenarios.scenario(
    'keeps an Agent worktree holding ignored files that are not dependencies',
    () => {
      const notes = lockedAgent('agent-notes');
      const modules = lockedAgent('agent-modules');
      ledger(notes);
      ledger(modules);
      mkdirSync(join(notes, 'tmp'));
      writeFileSync(join(notes, 'tmp', 'notes.txt'), 'keep me\n');
      mkdirSync(join(modules, 'node_modules'));
      writeFileSync(join(modules, 'node_modules', 'package.js'), 'x\n');
      const result = staleWith(ghAnswering([]), { remove: true });
      expect(byPath(result, notes).keep).toEqual(['ignored files: tmp/']);
      expect(existsSync(join(notes, 'tmp', 'notes.txt'))).toBe(true);
      expect(byPath(result, modules).keep).toEqual([]);
      expect(result.removed.map((item) => item.path)).toEqual([modules]);
      expect(existsSync(modules)).toBe(false);
    },
  );

  scenarios.scenario(
    'keeps an Agent-locked worktree whose changes are in main while a process runs inside it',
    async () => {
      const path = lockedAgent('agent-squashed');
      squashMerge('agent-squashed');
      const child = spawnWithHangGuard(['sleep', '60'], { cwd: path });
      children.push(child);
      await waitUntil(() => (byPath(staleWith(ghAnswering([])), path).processes ?? 0) > 0, {
        message: 'sleep to hold the cwd',
      });
      const listed = byPath(staleWith(ghAnswering([])), path);
      expect(listed.deliveredBy).toBe('changes-in-default');
      expect(listed.keep[0]).toMatch(/live process/);
      const result = staleWith(ghAnswering([]), { remove: true });
      expect(result.removed).toEqual([]);
      expect(existsSync(path)).toBe(true);
      expect(git(checkout, 'worktree', 'list', '--porcelain')).toContain(
        agentReason('agent-squashed'),
      );
      // Signal 0 throws when the process is gone.
      expect(process.kill(child.pid, 0)).toBe(true);
      child.kill();
      await child.exited;
    },
  );

  scenarios.scenario(
    'removeWorktree never ends the processes in a locked worktree, and refuses for them',
    async () => {
      const path = lockedAgent('agent-directbusy');
      const tip = git(path, 'rev-parse', 'HEAD');
      const child = spawnWithHangGuard(['sleep', '60'], { cwd: path });
      children.push(child);
      await waitUntil(() => (byPath(staleWith(ghAnswering([])), path).processes ?? 0) > 0, {
        message: 'sleep to hold the cwd',
      });
      expect(() =>
        removeWorktree(
          {
            configPath,
            name: path,
            keepRemote: true,
            deliveredTip: tip,
            deliveredBranch: 'work/agent-directbusy',
            endProcesses: true,
          },
          { checkout, runner: ghAnswering([]) },
        ),
      ).toThrow('processes are inside it');
      expect(process.kill(child.pid, 0)).toBe(true);
      expect(existsSync(path)).toBe(true);
      expect(git(checkout, 'worktree', 'list', '--porcelain')).toContain(
        agentReason('agent-directbusy'),
      );
      child.kill();
      await child.exited;
    },
  );

  scenarios.scenario('removeWorktree refuses a delivered Agent worktree with ignored files', () => {
    const path = lockedAgent('agent-directignored');
    const tip = git(path, 'rev-parse', 'HEAD');
    mkdirSync(join(path, 'tmp'));
    writeFileSync(join(path, 'tmp', 'notes.txt'), 'keep me\n');
    expect(() =>
      removeWorktree(
        { configPath, name: path, keepRemote: true, deliveredTip: tip },
        { checkout, runner: ghAnswering([]) },
      ),
    ).toThrow('ignored files: tmp/');
    expect(existsSync(join(path, 'tmp', 'notes.txt'))).toBe(true);
    expect(git(checkout, 'worktree', 'list', '--porcelain')).toContain(
      agentReason('agent-directignored'),
    );
  });

  scenarios.scenario('a thrown error after the unlock locks the worktree again', () => {
    const path = lockedAgent('agent-thrown');
    const tip = git(path, 'rev-parse', 'HEAD');
    const throwing: Runner = (command, options) => {
      if (command[0] === 'git' && command[1] === 'worktree' && command[2] === 'remove')
        throw new Error('simulated crash');
      return defaultRunner(command, options);
    };
    expect(() =>
      removeWorktree(
        { configPath, name: path, keepRemote: true, deliveredTip: tip },
        { checkout, runner: throwing },
      ),
    ).toThrow('simulated crash');
    expect(git(checkout, 'worktree', 'list', '--porcelain')).toContain(
      `locked ${agentReason('agent-thrown')}`,
    );
  });

  scenarios.scenario('a lock that cannot be restored is reported as left unlocked', () => {
    const path = lockedAgent('agent-unlocked');
    ledger(path);
    const failing: Runner = (command, options) => {
      if (command[0] === 'git' && command[1] === 'worktree' && command[2] === 'remove')
        throw new Error('simulated crash');
      if (command[0] === 'git' && command[1] === 'worktree' && command[2] === 'lock')
        return { code: 1, stdout: '', stderr: 'cannot lock' };
      return ghAnswering([])(command, options);
    };
    const result = staleWorktrees(
      { configPath, remove: true, currentDirectory: sandbox },
      { checkout, runner: failing, now: hoursLater(7) },
    );
    expect(result.removed).toEqual([]);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]?.path).toBe(path);
    expect(result.refused[0]?.reason).toContain('left unlocked');
    expect(existsSync(path)).toBe(true);
  });

  scenarios.scenario('keeps a lock with any other reason, even on a delivered worktree', () => {
    const other = lockedAgent('agent-other1', 'live session');
    const lookalike = lockedAgent('agent-other2', 'claude agent agent-other2 (pid x)');
    const wrongId = lockedAgent('agent-other3', agentReason('agent-someoneelse'));
    for (const path of [other, lookalike, wrongId]) ledger(path);
    const result = staleWith(ghAnswering([]), { remove: true });
    expect(result.removed).toEqual([]);
    for (const kept of [other, lookalike, wrongId]) {
      expect(byPath(result, kept).keep).toEqual(['locked']);
      expect(existsSync(kept)).toBe(true);
    }
  });

  scenarios.scenario('keeps a just-started Agent worktree, whose tip is a commit of main', () => {
    const path = join(roots.claude, 'agent-fresh');
    git(checkout, 'worktree', 'add', '-q', '-b', 'work/agent-fresh', path, 'origin/main');
    git(checkout, 'worktree', 'lock', '--reason', agentReason('agent-fresh'), path);
    const result = staleWith(ghAnswering([]), { remove: true });
    expect(byPath(result, path)).toMatchObject({ deliveredBy: 'ancestor', keep: ['locked'] });
    expect(result.removed).toEqual([]);
    expect(existsSync(path)).toBe(true);
  });

  scenarios.scenario('keeps an undelivered worktree with an Agent lock, and its branch', () => {
    const path = lockedAgent('agent-undelivered');
    const result = staleWith(ghAnswering([]), { remove: true });
    expect(result.removed).toEqual([]);
    expect(byPath(result, path).keep).toEqual(['locked', 'branch not delivered']);
    expect(existsSync(path)).toBe(true);
    expect(git(checkout, 'worktree', 'list', '--porcelain')).toContain(
      agentReason('agent-undelivered'),
    );
    expect(git(checkout, 'branch', '--list', 'work/agent-undelivered')).not.toBe('');
  });

  scenarios.scenario('keeps a dirty or untracked delivered worktree with an Agent lock', () => {
    const dirty = lockedAgent('agent-dirty');
    const untracked = lockedAgent('agent-untracked');
    ledger(dirty);
    ledger(untracked);
    writeFileSync(join(dirty, 'dirty-agent.txt'), 'changed\n');
    git(dirty, 'add', '.');
    writeFileSync(join(untracked, 'new.txt'), 'new\n');
    const result = staleWith(ghAnswering([]), { remove: true });
    expect(result.removed).toEqual([]);
    expect(byPath(result, dirty).keep).toEqual(['uncommitted or untracked changes']);
    expect(byPath(result, untracked).keep).toEqual(['uncommitted or untracked changes']);
    expect(existsSync(dirty) && existsSync(untracked)).toBe(true);
  });

  scenarios.scenario('keeps a delivered Agent worktree with a live process inside', async () => {
    const path = lockedAgent('agent-busy');
    ledger(path);
    const child = spawnWithHangGuard(['sleep', '60'], { cwd: path });
    children.push(child);
    await waitUntil(() => (byPath(staleWith(ghAnswering([])), path).processes ?? 0) > 0, {
      message: 'sleep to hold the cwd',
    });
    const result = staleWith(ghAnswering([]), { remove: true });
    expect(result.removed).toEqual([]);
    expect(existsSync(path)).toBe(true);
    child.kill();
    await child.exited;
  });

  scenarios.scenario('removeWorktree refuses a locked worktree it is not told is delivered', () => {
    const path = lockedAgent('agent-direct');
    const tip = git(path, 'rev-parse', 'HEAD');
    const attempt = (deliveredTip?: string) =>
      removeWorktree(
        { configPath, name: path, keepRemote: true, deliveredTip },
        { checkout, runner: ghAnswering([]) },
      );
    expect(() => attempt()).toThrow('locked');
    expect(() => attempt('f'.repeat(40))).toThrow('locked');
    expect(existsSync(path)).toBe(true);
    expect(attempt(tip).path).toBe(path);
    expect(existsSync(path)).toBe(false);
  });

  scenarios.scenario('a removal that fails after the unlock locks the worktree again', () => {
    const path = lockedAgent('agent-relock');
    const tip = git(path, 'rev-parse', 'HEAD');
    const failing: Runner = (command, options) =>
      command[0] === 'git' && command[1] === 'worktree' && command[2] === 'remove'
        ? { code: 1, stdout: '', stderr: 'simulated failure' }
        : defaultRunner(command, options);
    expect(() =>
      removeWorktree(
        { configPath, name: path, keepRemote: true, deliveredTip: tip },
        { checkout, runner: failing },
      ),
    ).toThrow('simulated failure');
    expect(git(checkout, 'worktree', 'list', '--porcelain')).toContain(
      `locked ${agentReason('agent-relock')}`,
    );
  });
});

await scenarios.settled();
