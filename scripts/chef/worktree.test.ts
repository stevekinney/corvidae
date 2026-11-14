import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Runner } from './process-runner.ts';
import {
  branchOwner,
  createWorktree,
  endProcessesInside,
  isAgentLockReason,
  parseWorktreeList,
  Refusal,
  removeWorktree,
  run,
} from './worktree.ts';

describe('parseWorktreeList', () => {
  const listing = [
    'worktree /repo with space',
    'HEAD aaaa',
    'branch refs/heads/main',
    '',
    'worktree /roots/detached',
    'HEAD bbbb',
    'detached',
    '',
    'worktree /roots/feature',
    'HEAD cccc',
    'branch refs/heads/feature/x',
    '',
  ].join('\n');

  test('pairs each branch line with the worktree line of its own block', () => {
    const entries = parseWorktreeList(listing);
    expect(entries.map((entry) => entry.path)).toEqual([
      '/repo with space',
      '/roots/detached',
      '/roots/feature',
    ]);
    expect(entries[1]?.detached).toBe(true);
    expect(entries[1]?.branch).toBeUndefined();
    expect(branchOwner(entries, 'main')?.path).toBe('/repo with space');
    expect(branchOwner(entries, 'feature/x')?.path).toBe('/roots/feature');
    expect(branchOwner(entries, 'absent')).toBeUndefined();
  });

  test("a detached block does not lend its neighbour's branch to the wrong path", () => {
    const entries = parseWorktreeList(
      [
        'worktree /a',
        'HEAD 1',
        'detached',
        '',
        'worktree /b',
        'HEAD 2',
        'branch refs/heads/main',
        '',
      ].join('\n'),
    );
    expect(branchOwner(entries, 'main')?.path).toBe('/b');
  });
});

function withConfiguration<T>(body: (configPath: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), 'worktree-fast-'));
  try {
    const configPath = join(directory, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        repository: 'o/n',
        defaultBranch: 'main',
        worktreeRoots: { claude: join(directory, 'claude'), codex: join(directory, 'codex') },
        manifestName: 'demo',
        installCommand: 'true',
        gateCommand: 'true',
        affectedCheckCommand: 'true',
        mergeMethod: 'squash',
      }),
    );
    return body(configPath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('createWorktree with a fake runner', () => {
  const owned = [
    'worktree /home/dev/corvidae',
    'HEAD aaaa',
    'branch refs/heads/main',
    '',
    'worktree /home/dev/other',
    'HEAD bbbb',
    'branch refs/heads/feature/x',
    '',
  ].join('\n');

  test('resolves the main checkout from git and runs the ownership preflight there', () => {
    const calls: { command: string[]; cwd: string | undefined }[] = [];
    const runner: Runner = (command, options) => {
      calls.push({ command, cwd: options?.cwd });
      if (command.includes('--git-common-dir'))
        return { code: 0, stdout: '/home/dev/corvidae/.git\n', stderr: '' };
      return { code: 0, stdout: owned, stderr: '' };
    };
    withConfiguration((configPath) => {
      const attempt = () =>
        createWorktree(
          { configPath, provider: 'claude', name: 'copy', branch: 'main' },
          { runner },
        );
      expect(attempt).toThrow(Refusal);
      expect(attempt).toThrow('which /home/dev/corvidae already owns');
    });
    expect(calls[0]?.command).toEqual([
      'git',
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ]);
    const listing = calls.find((call) => call.command.includes('worktree'));
    expect(listing?.cwd).toBe('/home/dev/corvidae');
    // Refused before any fetch or add.
    expect(calls.some((call) => call.command.includes('fetch'))).toBe(false);
    expect(calls.some((call) => call.command.includes('add'))).toBe(false);
  });

  test('an injected checkout skips the lookup', () => {
    const calls: string[][] = [];
    const runner: Runner = (command) => {
      calls.push(command);
      return { code: 0, stdout: owned, stderr: '' };
    };
    withConfiguration((configPath) => {
      expect(() =>
        createWorktree(
          { configPath, provider: 'claude', name: 'copy', branch: 'main' },
          { runner, checkout: '/injected' },
        ),
      ).toThrow(Refusal);
    });
    expect(calls.some((command) => command.includes('--git-common-dir'))).toBe(false);
  });
});

describe('createWorktree --install-log', () => {
  const listing = 'worktree /home/dev/corvidae\nHEAD aaaa\nbranch refs/heads/main\n\n';

  test('resolves a relative log against the caller, and a refused creation leaves none behind', () => {
    const calls: string[][] = [];
    const runner: Runner = (command) => {
      calls.push(command);
      return { code: 0, stdout: listing, stderr: '' };
    };
    const caller = mkdtempSync(join(tmpdir(), 'worktree-caller-'));
    const previous = process.cwd();
    try {
      process.chdir(caller);
      withConfiguration((configPath) => {
        // The fake `git worktree add` creates no manifest, so creation is refused before the
        // install; the probe of the log must not outlive the refusal.
        expect(() =>
          createWorktree(
            {
              configPath,
              provider: 'claude',
              name: 'alpha',
              branch: 'feature/alpha',
              installLog: join('logs', 'install.log'),
            },
            { runner, checkout: '/home/dev/corvidae' },
          ),
        ).toThrow(Refusal);
      });
      expect(existsSync(join(caller, 'logs', 'install.log'))).toBe(false);
    } finally {
      process.chdir(previous);
      rmSync(caller, { recursive: true, force: true });
    }
  });

  test('a relative log reaches the install command as an absolute path', () => {
    const installs: string[] = [];
    withConfiguration((configPath) => {
      const root = JSON.parse(readFileSync(configPath, 'utf8')).worktreeRoots.claude as string;
      const caller = mkdtempSync(join(tmpdir(), 'worktree-caller-'));
      const previous = process.cwd();
      const runner: Runner = (command) => {
        if (command.includes('add')) {
          mkdirSync(join(root, 'alpha'), { recursive: true });
          writeFileSync(join(root, 'alpha', 'package.json'), JSON.stringify({ name: 'demo' }));
        }
        if (command[0] === 'sh') installs.push(command[2] ?? '');
        return { code: 0, stdout: listing, stderr: '' };
      };
      try {
        process.chdir(caller);
        createWorktree(
          {
            configPath,
            provider: 'claude',
            name: 'alpha',
            branch: 'feature/alpha',
            installLog: join('logs', 'install.log'),
          },
          { runner, checkout: '/home/dev/corvidae' },
        );
        expect(installs[0]).toContain(join(realpathSync(caller), 'logs', 'install.log'));
      } finally {
        process.chdir(previous);
        rmSync(caller, { recursive: true, force: true });
      }
    });
  });

  test('an unwritable log is a refusal naming the path, before any worktree is added', () => {
    const calls: string[][] = [];
    const runner: Runner = (command) => {
      calls.push(command);
      return { code: 0, stdout: listing, stderr: '' };
    };
    const caller = mkdtempSync(join(tmpdir(), 'worktree-caller-'));
    try {
      const blocker = join(caller, 'blocker');
      writeFileSync(blocker, 'a file, not a directory');
      const log = join(blocker, 'install.log');
      withConfiguration((configPath) => {
        const attempt = () =>
          createWorktree(
            {
              configPath,
              provider: 'claude',
              name: 'alpha',
              branch: 'feature/alpha',
              installLog: log,
            },
            { runner, checkout: '/home/dev/corvidae' },
          );
        expect(attempt).toThrow(Refusal);
        expect(attempt).toThrow(log);
      });
      expect(calls.some((command) => command.includes('add'))).toBe(false);
    } finally {
      rmSync(caller, { recursive: true, force: true });
    }
  });
});

describe('removeWorktree delivery guard with a fake runner', () => {
  const TIP = 'a'.repeat(40);
  const MERGED_HEAD = 'b'.repeat(40);

  interface World {
    /** `git merge-base --is-ancestor <tip> origin/main`: 0 delivered by history, 1 not, 2 error. */
    ancestor?: number;
    fetchCode?: number;
    /** What `gh pr view <branch>` answers; `undefined` means gh found no pull request. */
    pullRequest?: { state: string; headRefOid: string } | undefined;
    ghCode?: number;
    /** What `lsof +D` answers; the default is exit 1 with no output, which means no process. */
    lsof?: { code: number; stdout: string; stderr: string };
    /**
     * What each host-wide working-directory `lsof` answers, in turn, as `pid cwd` pairs under the
     * worktree's path (`{}` stands for it); the last answer repeats.
     */
    workingDirectories?: string[][];
  }

  type Remove = (options?: {
    keepRemote?: boolean;
    retired?: boolean;
    endProcesses?: boolean;
    deliveredTip?: string;
    deliveredBranch?: string | undefined;
  }) => {
    path: string;
    branch: string | undefined;
    remoteDeleted: boolean;
    ended: { pid: number; command: string; cwd: string }[];
  };

  function removal(
    world: World,
    body: (
      remove: Remove,
      calls: string[][],
      path: string,
      signals: [number, NodeJS.Signals][],
    ) => void,
  ): void {
    const calls: string[][] = [];
    const signals: [number, NodeJS.Signals][] = [];
    withConfiguration((configPath) => {
      const root = JSON.parse(readFileSync(configPath, 'utf8')).worktreeRoots.claude as string;
      const path = join(root, 'alpha');
      const listings = [...(world.workingDirectories ?? [[]])];
      const runner: Runner = (command) => {
        calls.push(command);
        const [program, ...rest] = command;
        if (program === 'lsof' && command.includes('cwd')) {
          const listing = (listings.length > 1 ? listings.shift() : listings[0]) ?? [];
          const stdout = listing
            .map((entry) => {
              const [pid, cwd = ''] = entry.split(' ');
              return `p${pid}\ncbun\nn${cwd.replace('{}', path)}\n`;
            })
            .join('');
          return { code: 0, stdout, stderr: '' };
        }
        if (program === 'lsof') return world.lsof ?? { code: 1, stdout: '', stderr: '' };
        if (program === 'gh') {
          if (world.ghCode !== undefined)
            return { code: world.ghCode, stdout: '', stderr: 'gh: not available' };
          return world.pullRequest === undefined
            ? { code: 1, stdout: '', stderr: 'no pull requests found for branch' }
            : { code: 0, stdout: JSON.stringify(world.pullRequest), stderr: '' };
        }
        if (rest[0] === 'worktree' && rest[1] === 'list')
          return {
            code: 0,
            stdout: `worktree ${path}\nHEAD ${TIP}\nbranch refs/heads/feature/alpha\n\n`,
            stderr: '',
          };
        if (rest[0] === 'rev-parse') return { code: 0, stdout: `${TIP}\n`, stderr: '' };
        if (rest[0] === 'fetch') {
          const code = world.fetchCode ?? 0;
          return { code, stdout: '', stderr: code === 0 ? '' : 'offline' };
        }
        if (rest[0] === 'merge-base') return { code: world.ancestor ?? 1, stdout: '', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      };
      const remove: Remove = (options = {}) =>
        removeWorktree(
          { configPath, provider: 'claude', name: 'alpha', keepRemote: false, ...options },
          {
            runner,
            checkout: '/home/dev/corvidae',
            endProcesses: {
              signal: (pid, signal) => signals.push([pid, signal]),
              sleep: () => {},
              exclude: new Set([1]),
            },
          },
        );
      body(remove, calls, path, signals);
    });
  }

  test('ends the processes whose working directory is inside the worktree, and only those', () => {
    removal(
      {
        ancestor: 0,
        // A sibling sharing the prefix (`alpha-2`), the worktree itself, a directory inside it,
        // and an excluded ancestor inside it; then, after SIGTERM, nothing is left inside.
        workingDirectories: [['10 {}', '11 {}/packages/a', '12 {}-2', '13 /elsewhere', '1 {}'], []],
      },
      (remove, calls, path, signals) => {
        const result = remove({
          endProcesses: true,
          deliveredTip: TIP,
          deliveredBranch: 'feature/alpha',
        });
        expect(result.ended.map((item) => item.pid)).toEqual([10, 11]);
        expect(signals).toEqual([
          [10, 'SIGTERM'],
          [11, 'SIGTERM'],
        ]);
        expect(result.path).toBe(path);
        expect(mutations(calls)).toEqual(['worktree remove', 'branch -D', 'push origin']);
      },
    );
  });

  test('sends SIGKILL to what a fresh listing still shows inside after the grace', () => {
    removal(
      {
        ancestor: 0,
        // 11 ignores SIGTERM for the whole grace: twelve looks a quarter second apart.
        workingDirectories: [
          ['10 {}', '11 {}/x'],
          ...Array.from({ length: 12 }, () => ['11 {}/x']),
          [],
        ],
      },
      (remove, _calls, _path, signals) => {
        remove({ endProcesses: true, deliveredTip: TIP, deliveredBranch: 'feature/alpha' });
        expect(signals).toEqual([
          [10, 'SIGTERM'],
          [11, 'SIGTERM'],
          [11, 'SIGKILL'],
        ]);
      },
    );
  });

  test('ends no process when anything else refuses the removal', () => {
    removal(
      {
        ancestor: 1,
        pullRequest: { state: 'OPEN', headRefOid: TIP },
        workingDirectories: [['10 {}']],
      },
      (remove, calls, _path, signals) => {
        expect(() => remove({ endProcesses: true })).toThrow('is not delivered');
        expect(signals).toEqual([]);
        expect(mutations(calls)).toEqual([]);
      },
    );
  });

  test('a worktree reused since the listing, now at a commit of main, is refused and signalled to nothing', () => {
    removal({ ancestor: 0, workingDirectories: [['10 {}']] }, (remove, calls, _path, signals) => {
      // The recorded tip is an old delivered commit; the path's head is TIP now.
      expect(() =>
        remove({
          endProcesses: true,
          deliveredTip: 'c'.repeat(40),
          deliveredBranch: 'feature/alpha',
        }),
      ).toThrow('not the ones recorded as delivered');
      expect(signals).toEqual([]);
      expect(mutations(calls)).toEqual([]);
    });
  });

  test('a worktree whose branch changed since the listing is refused and signalled to nothing', () => {
    removal({ ancestor: 0, workingDirectories: [['10 {}']] }, (remove, calls, _path, signals) => {
      expect(() =>
        remove({ endProcesses: true, deliveredTip: TIP, deliveredBranch: 'feature/other' }),
      ).toThrow('not the ones recorded as delivered');
      expect(signals).toEqual([]);
      expect(mutations(calls)).toEqual([]);
    });
  });

  test('ending processes with no recorded tip is refused', () => {
    removal({ ancestor: 0, workingDirectories: [['10 {}']] }, (remove, _calls, _path, signals) => {
      expect(() => remove({ endProcesses: true })).toThrow('not the ones recorded as delivered');
      expect(signals).toEqual([]);
    });
  });

  test('never signals its parent when the process table cannot be read', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-parent-')));
    try {
      const signals: number[] = [];
      const runner: Runner = (command) =>
        command[0] === 'lsof'
          ? {
              code: 0,
              stdout: `p${process.ppid}\ncbun\nn${root}\np${process.pid}\ncbun\nn${root}\np999999\ncbun\nn${root}\n`,
              stderr: '',
            }
          : { code: 1, stdout: '', stderr: 'ps: unavailable' };
      const ended = endProcessesInside(root, runner, {
        parents: undefined,
        signal: (pid) => signals.push(pid),
        sleep: () => {},
      });
      expect(ended.map((item) => item.pid)).toEqual([999999]);
      expect(signals).toContain(999999);
      expect(signals).not.toContain(process.ppid);
      expect(signals).not.toContain(process.pid);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('without endProcesses a process inside still refuses the removal', () => {
    removal(
      { ancestor: 0, lsof: { code: 0, stdout: 'p10\ncbun\n', stderr: '' } },
      (remove, calls, _path, signals) => {
        expect(() => remove()).toThrow('processes are inside it: 10 bun');
        expect(signals).toEqual([]);
        expect(mutations(calls)).toEqual([]);
      },
    );
  });

  /** The destructive commands a refusal must never have reached. */
  const mutations = (calls: string[][]) =>
    calls
      .filter(
        (command) =>
          (command[1] === 'worktree' && command[2] === 'remove') ||
          (command[1] === 'branch' && command[2] === '-D') ||
          (command[1] === 'push' && command.includes('--delete')),
      )
      .map((command) => command.slice(1, 3).join(' '));

  test('refuses a branch that is not in the default branch and whose pull request is open', () => {
    removal({ ancestor: 1, pullRequest: { state: 'OPEN', headRefOid: TIP } }, (remove, calls) => {
      expect(() => remove()).toThrow(Refusal);
      expect(() => remove()).toThrow('is not delivered');
      expect(() => remove()).toThrow('its pull request is OPEN');
      expect(() => remove({ keepRemote: true })).toThrow('--retired');
      expect(mutations(calls)).toEqual([]);
    });
  });

  test('refuses when lsof cannot be run, because "no processes" would be a guess', () => {
    removal(
      {
        ancestor: 0,
        lsof: { code: 127, stdout: '', stderr: 'could not start the command (Error ENOENT)' },
      },
      (remove, calls) => {
        expect(() => remove()).toThrow(Refusal);
        expect(() => remove()).toThrow('lsof could not check');
        expect(mutations(calls)).toEqual([]);
      },
    );
  });

  test('refuses a branch with no pull request at all', () => {
    removal({ ancestor: 1, pullRequest: undefined }, (remove, calls) => {
      expect(() => remove()).toThrow('no pull request was found');
      expect(mutations(calls)).toEqual([]);
    });
  });

  test('accepts a tip that is an ancestor of origin/<default> without asking GitHub', () => {
    removal({ ancestor: 0 }, (remove, calls, path) => {
      expect(remove()).toEqual({ path, branch: 'feature/alpha', remoteDeleted: true, ended: [] });
      expect(calls.some((command) => command[0] === 'gh')).toBe(false);
      expect(calls).toContainEqual(['git', 'merge-base', '--is-ancestor', TIP, 'origin/main']);
    });
  });

  test('accepts a squash-merged pull request whose merged head is the local tip', () => {
    removal(
      { ancestor: 1, pullRequest: { state: 'MERGED', headRefOid: TIP } },
      (remove, calls, path) => {
        expect(remove()).toEqual({ path, branch: 'feature/alpha', remoteDeleted: true, ended: [] });
        expect(mutations(calls)).toEqual(['worktree remove', 'branch -D', 'push origin']);
        expect(calls).toContainEqual([
          'gh',
          'pr',
          'view',
          'feature/alpha',
          '--repo',
          'o/n',
          '--json',
          'state,headRefOid',
        ]);
      },
    );
  });

  test('refuses a merged pull request whose head is not the local tip', () => {
    removal(
      { ancestor: 1, pullRequest: { state: 'MERGED', headRefOid: MERGED_HEAD } },
      (remove, calls) => {
        expect(() => remove()).toThrow('merged bbbbbbbbbbbb, not the local tip aaaaaaaaaaaa');
        expect(mutations(calls)).toEqual([]);
      },
    );
  });

  test('--retired removes an undelivered branch without running the delivery check', () => {
    removal(
      { ancestor: 1, pullRequest: { state: 'OPEN', headRefOid: TIP } },
      (remove, calls, path) => {
        expect(remove({ retired: true })).toEqual({
          path,
          branch: 'feature/alpha',
          remoteDeleted: true,
          ended: [],
        });
        expect(calls.some((command) => command[0] === 'gh' || command[1] === 'merge-base')).toBe(
          false,
        );
      },
    );
  });

  test('fails closed when the default branch cannot be fetched or compared, or GitHub is unreachable', () => {
    removal({ fetchCode: 128 }, (remove, calls) => {
      expect(() => remove()).toThrow('could not be checked against origin/main');
      expect(mutations(calls)).toEqual([]);
    });
    removal({ ancestor: 2 }, (remove, calls) => {
      expect(() => remove()).toThrow('could not be checked against origin/main');
      expect(mutations(calls)).toEqual([]);
    });
    removal({ ancestor: 1, ghCode: 127 }, (remove, calls) => {
      expect(() => remove()).toThrow('no pull request was found');
      expect(mutations(calls)).toEqual([]);
    });
  });

  test('the command line takes --retired, and --json prints a refusal as an object', () => {
    withConfiguration((configPath) => {
      const runner: Runner = () => ({ code: 0, stdout: '', stderr: '' });
      const argv = ['remove', '--config', configPath, '--provider', 'claude', '--name', 'ghost'];
      const result = run([...argv, '--json', '--retired'], { runner, checkout: '/home/dev/x' });
      expect(result.code).toBe(1);
      expect(JSON.parse(result.output)).toEqual({
        ok: false,
        error: expect.stringContaining('is not a worktree under'),
      });
    });
  });
});

describe('removeWorktree under the Agent tool directory and a locked worktree', () => {
  const TIP = 'a'.repeat(40);
  const CHECKOUT = '/home/dev/corvidae';
  const agentPath = `${CHECKOUT}/.claude/worktrees/agent-1`;

  function removal(
    listed: string,
    name: string,
    locked: boolean,
    body: (remove: () => { path: string }, calls: string[][]) => void,
  ): void {
    const calls: string[][] = [];
    const runner: Runner = (command) => {
      calls.push(command);
      const [program, ...rest] = command;
      if (program === 'lsof') return { code: 1, stdout: '', stderr: '' };
      if (rest[0] === 'worktree' && rest[1] === 'list')
        return {
          code: 0,
          stdout: `worktree ${listed}\nHEAD ${TIP}\nbranch refs/heads/feature/one\n${locked ? 'locked claude agent\n' : ''}\n`,
          stderr: '',
        };
      if (rest[0] === 'rev-parse') return { code: 0, stdout: `${TIP}\n`, stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    withConfiguration((configPath) =>
      body(
        () =>
          removeWorktree(
            { configPath, provider: 'claude', name, keepRemote: true },
            { runner, checkout: CHECKOUT },
          ),
        calls,
      ),
    );
  }

  const removed = (calls: string[][]) =>
    calls.some((command) => command[1] === 'worktree' && command[2] === 'remove');

  test('parseWorktreeList marks a locked worktree, with or without a reason', () => {
    const entries = parseWorktreeList(
      'worktree /a\nHEAD 1\nlocked\n\nworktree /b\nHEAD 2\nlocked because\n\nworktree /c\nHEAD 3\n\n',
    );
    expect(entries.map((entry) => entry.locked)).toEqual([true, true, false]);
    expect(entries.map((entry) => entry.lockReason)).toEqual([undefined, 'because', undefined]);
  });

  test('isAgentLockReason accepts the Agent tool form for its own directory only', () => {
    const reason = 'claude agent agent-a1b2c3 (pid 86565 start Tue Nov 10 19:59:31 2026)';
    expect(isAgentLockReason(reason, '/r/.claude/worktrees/agent-a1b2c3')).toBe(true);
    expect(isAgentLockReason(reason, '/r/.claude/worktrees/agent-other')).toBe(false);
    expect(isAgentLockReason('live session', '/r/agent-a1b2c3')).toBe(false);
    expect(isAgentLockReason(undefined, '/r/agent-a1b2c3')).toBe(false);
    expect(isAgentLockReason(`${reason} extra`, '/r/agent-a1b2c3')).toBe(false);
    expect(isAgentLockReason('claude agent agent-a1b2c3 (pid x)', '/r/agent-a1b2c3')).toBe(false);
  });

  test('removes a worktree the Agent tool made, by name', () => {
    removal(agentPath, 'agent-1', false, (remove, calls) => {
      expect(remove().path).toBe(agentPath);
      expect(removed(calls)).toBe(true);
    });
  });

  test('removes it by absolute path too', () => {
    removal(agentPath, agentPath, false, (remove, calls) => {
      expect(remove().path).toBe(agentPath);
      expect(removed(calls)).toBe(true);
    });
  });

  test('refuses a locked worktree and changes nothing', () => {
    removal(agentPath, 'agent-1', true, (remove, calls) => {
      expect(() => remove()).toThrow('locked');
      expect(removed(calls)).toBe(false);
    });
  });

  test('still refuses a path under neither root', () => {
    removal('/elsewhere/agent-1', '/elsewhere/agent-1', false, (remove, calls) => {
      expect(() => remove()).toThrow('is not a worktree under');
      expect(removed(calls)).toBe(false);
    });
  });
});
