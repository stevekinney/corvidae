import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Runner } from './process-runner.ts';
import {
  branchOwner,
  createWorktree,
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

  test('resolves a relative log against the caller and creates it before the worktree', () => {
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
        // The fake `git worktree add` creates nothing, so creation stops at the manifest read;
        // the log must already exist where the caller named it.
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
      expect(readFileSync(join(caller, 'logs', 'install.log'), 'utf8')).toBe('');
    } finally {
      process.chdir(previous);
      rmSync(caller, { recursive: true, force: true });
    }
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
    /** What `lsof` answers; the default is exit 1 with no output, which means no process. */
    lsof?: { code: number; stdout: string; stderr: string };
  }

  type Remove = (options?: { keepRemote?: boolean; retired?: boolean }) => {
    path: string;
    branch: string | undefined;
    remoteDeleted: boolean;
  };

  function removal(
    world: World,
    body: (remove: Remove, calls: string[][], path: string) => void,
  ): void {
    const calls: string[][] = [];
    withConfiguration((configPath) => {
      const root = JSON.parse(readFileSync(configPath, 'utf8')).worktreeRoots.claude as string;
      const path = join(root, 'alpha');
      const runner: Runner = (command) => {
        calls.push(command);
        const [program, ...rest] = command;
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
          { runner, checkout: '/home/dev/corvidae' },
        );
      body(remove, calls, path);
    });
  }

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
      expect(remove()).toEqual({ path, branch: 'feature/alpha', remoteDeleted: true });
      expect(calls.some((command) => command[0] === 'gh')).toBe(false);
      expect(calls).toContainEqual(['git', 'merge-base', '--is-ancestor', TIP, 'origin/main']);
    });
  });

  test('accepts a squash-merged pull request whose merged head is the local tip', () => {
    removal(
      { ancestor: 1, pullRequest: { state: 'MERGED', headRefOid: TIP } },
      (remove, calls, path) => {
        expect(remove()).toEqual({ path, branch: 'feature/alpha', remoteDeleted: true });
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
        error: expect.stringContaining('is not a worktree under the claude root'),
      });
    });
  });
});
