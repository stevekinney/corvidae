import { describe, expect } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnWithHangGuard } from '../hang-guard.ts';
import { defaultRunner, type Runner } from './process-runner.ts';
import { createScenarios } from './scenario.test-support.ts';
import { createWorktree, Refusal, removeWorktree, run, UsageError } from './worktree.ts';

/**
 * Worktree creation and removal against real Git repositories (a bare origin and a clone) and a
 * real `sleep` child, so each case runs at module scope in the slow lane. The main checkout is
 * injected; resolving it from Git is covered with a fake runner in `worktree.test.ts`.
 */

let sandbox = '';
let checkout = '';
let origin = '';
let roots = { claude: '', codex: '' };
let configPath = '';
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

function writeConfig(overrides: Record<string, unknown> = {}) {
  writeFileSync(
    configPath,
    JSON.stringify({
      repository: 'o/n',
      defaultBranch: 'main',
      worktreeRoots: roots,
      manifestName: 'demo',
      installCommand: 'echo installed; touch installed.flag',
      gateCommand: 'true',
      affectedCheckCommand: 'true',
      mergeMethod: 'squash',
      ...overrides,
    }),
  );
}

const scenarios = createScenarios({
  setUp() {
    sandbox = mkdtempSync(join(tmpdir(), 'worktree-'));
    origin = join(sandbox, 'origin.git');
    checkout = join(sandbox, 'checkout');
    roots = { claude: join(sandbox, 'roots', 'claude'), codex: join(sandbox, 'roots', 'codex') };
    configPath = join(sandbox, 'config.json');
    mkdirSync(origin);
    git(origin, 'init', '-q', '--bare', '-b', 'main');
    git(sandbox, 'clone', '-q', origin, checkout);
    mkdirSync(join(checkout, 'src'));
    writeFileSync(join(checkout, 'src', 'file.txt'), 'x');
    writeFileSync(join(checkout, 'package.json'), JSON.stringify({ name: 'demo' }));
    // The install in these tests writes a marker the way a real install writes `node_modules`.
    writeFileSync(join(checkout, '.gitignore'), 'installed.flag\n');
    git(checkout, 'add', '.');
    git(checkout, 'commit', '-q', '-m', 'initial');
    git(checkout, 'push', '-q', 'origin', 'HEAD:main');
    writeConfig();
  },
  async tearDown() {
    for (const child of children.splice(0)) {
      child.kill();
      await child.exited;
    }
    rmSync(sandbox, { recursive: true, force: true });
  },
});

function create(name = 'alpha', branch = 'feature/alpha', extra: Record<string, unknown> = {}) {
  return createWorktree({ configPath, provider: 'claude', name, branch, ...extra }, { checkout });
}

function runCli(argv: string[]) {
  return run(argv, { checkout });
}

describe('createWorktree', () => {
  scenarios.scenario('adds the worktree from origin/<default>, installs, and reports head', () => {
    const result = create();
    expect(result.path).toBe(join(roots.claude, 'alpha'));
    expect(result.head).toBe(git(checkout, 'rev-parse', 'origin/main'));
    expect(result.installCode).toBe(0);
    expect(result.installLog).toBe(join(roots.claude, 'alpha-install.log'));
    expect(readFileSync(result.installLog, 'utf8')).toContain('installed');
    expect(existsSync(join(result.path, 'installed.flag'))).toBe(true);
    expect(git(result.path, 'branch', '--show-current')).toBe('feature/alpha');
    expect(result.captureId).toBeUndefined();
  });

  scenarios.scenario('never attaches the default branch', () => {
    expect(() => create('main-copy', 'main')).toThrow(Refusal);
    expect(() => create('main-copy', 'main')).toThrow('default branch');
    expect(existsSync(join(roots.claude, 'main-copy'))).toBe(false);
    expect(git(checkout, 'worktree', 'list', '--porcelain')).not.toContain('main-copy');
  });

  scenarios.scenario('names the owner of the default branch in the refusal', () => {
    try {
      create('main-copy', 'main');
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as Error).message).toContain(checkout.replace(/^\/private/, ''));
    }
  });

  scenarios.scenario('stops before install when the manifest name differs', () => {
    writeConfig({ manifestName: 'something-else' });
    expect(() => create()).toThrow('not "something-else"');
    expect(existsSync(join(roots.claude, 'alpha', 'installed.flag'))).toBe(false);
    expect(existsSync(join(roots.claude, 'alpha-install.log'))).toBe(false);
  });

  scenarios.scenario('reports an install failure as a non-zero install code', () => {
    writeConfig({ installCommand: 'echo broken; exit 5' });
    const result = create();
    expect(result.installCode).toBe(5);
    expect(readFileSync(result.installLog, 'utf8')).toContain('broken');
    expect(
      runCli([
        'create',
        '--config',
        configPath,
        '--provider',
        'claude',
        '--name',
        'beta',
        '--branch',
        'b2',
      ]).code,
    ).toBe(1);
  });

  scenarios.scenario('honors --base and --install-log', () => {
    git(checkout, 'branch', 'other');
    const log = join(sandbox, 'custom-install.log');
    const result = create('alpha', 'feature/alpha', { base: 'other', installLog: log });
    expect(result.installLog).toBe(log);
    expect(existsSync(log)).toBe(true);
  });

  scenarios.scenario('captures a scope baseline when scope paths are given', () => {
    const output = join(sandbox, 'scope.json');
    const result = create('alpha', 'feature/alpha', { scopePaths: ['src'], scopeOutput: output });
    expect(result.captureId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(readFileSync(output, 'utf8')).captureId).toBe(result.captureId);
  });

  scenarios.scenario(
    'scope paths and output must come together, and a bad name or provider is a usage error',
    () => {
      expect(() => create('alpha', 'feature/alpha', { scopePaths: ['src'] })).toThrow(UsageError);
      expect(() => create('../escape')).toThrow(UsageError);
      expect(() => create('alpha', '--bad')).toThrow(UsageError);
      expect(() =>
        createWorktree({ configPath, provider: 'other', name: 'a', branch: 'b' }, { checkout }),
      ).toThrow(UsageError);
    },
  );

  scenarios.scenario('refuses an existing path and an existing branch', () => {
    create();
    expect(() => create()).toThrow('already exists');
    expect(() => create('beta', 'feature/alpha')).toThrow(Refusal);
  });
});

describe('removeWorktree', () => {
  const remove = (name = 'alpha', keepRemote = false) =>
    removeWorktree({ configPath, provider: 'claude', name, keepRemote }, { checkout });

  scenarios.scenario('removes a clean worktree and its local and remote branch', () => {
    const created = create();
    git(created.path, 'push', '-q', 'origin', 'feature/alpha');
    const result = remove();
    expect(result).toEqual({ path: created.path, branch: 'feature/alpha', remoteDeleted: true });
    expect(existsSync(created.path)).toBe(false);
    expect(git(checkout, 'branch', '--list', 'feature/alpha')).toBe('');
    expect(git(checkout, 'ls-remote', '--heads', 'origin', 'feature/alpha')).toBe('');
  });

  scenarios.scenario(
    '--keep-remote leaves the remote branch, and a branch never pushed is fine',
    () => {
      const created = create();
      git(created.path, 'push', '-q', 'origin', 'feature/alpha');
      expect(remove('alpha', true).remoteDeleted).toBe(false);
      expect(git(checkout, 'ls-remote', '--heads', 'origin', 'feature/alpha')).not.toBe('');
      create('beta', 'feature/beta');
      expect(remove('beta').remoteDeleted).toBe(false);
    },
  );

  scenarios.scenario('refuses a dirty worktree and changes nothing', () => {
    const created = create();
    writeFileSync(join(created.path, 'untracked.txt'), 'x');
    expect(() => remove()).toThrow('uncommitted or untracked');
    expect(existsSync(created.path)).toBe(true);
    expect(git(checkout, 'branch', '--list', 'feature/alpha')).not.toBe('');
  });

  /** Real Git; GitHub is answered by `pullRequest` so no test reaches the network. */
  function removeWith(
    pullRequest: { state: string; headRefOid: string } | undefined,
    retired = false,
  ) {
    const runner: Runner = (command, options) =>
      command[0] === 'gh'
        ? pullRequest === undefined
          ? { code: 1, stdout: '', stderr: 'no pull requests found' }
          : { code: 0, stdout: JSON.stringify(pullRequest), stderr: '' }
        : defaultRunner(command, options);
    return removeWorktree(
      { configPath, provider: 'claude', name: 'alpha', keepRemote: false, retired },
      { checkout, runner },
    );
  }

  function commitInWorktree(path: string) {
    writeFileSync(join(path, 'src', 'work.txt'), 'unmerged work');
    git(path, 'add', '.');
    git(path, 'commit', '-q', '-m', 'work');
    git(path, 'push', '-q', 'origin', 'feature/alpha');
    return git(path, 'rev-parse', 'HEAD');
  }

  scenarios.scenario('refuses a branch with unmerged work and destroys nothing', () => {
    const created = create();
    const tip = commitInWorktree(created.path);
    expect(() => removeWith({ state: 'OPEN', headRefOid: tip })).toThrow('is not delivered');
    expect(existsSync(created.path)).toBe(true);
    expect(git(checkout, 'rev-parse', 'refs/heads/feature/alpha')).toBe(tip);
    expect(git(checkout, 'ls-remote', '--heads', 'origin', 'feature/alpha')).toContain(tip);
  });

  scenarios.scenario('removes a branch whose commits reached the default branch', () => {
    const created = create();
    const tip = commitInWorktree(created.path);
    git(created.path, 'push', '-q', 'origin', `${tip}:main`);
    expect(removeWith(undefined).branch).toBe('feature/alpha');
    expect(git(checkout, 'branch', '--list', 'feature/alpha')).toBe('');
  });

  scenarios.scenario('removes a squash-merged branch only at the merged head', () => {
    const created = create();
    const tip = commitInWorktree(created.path);
    // A squash merge puts the same content on main as a different commit.
    git(checkout, 'fetch', '-q', 'origin');
    const squash = join(sandbox, 'squash');
    git(sandbox, 'clone', '-q', origin, squash);
    mkdirSync(join(squash, 'src'), { recursive: true });
    writeFileSync(join(squash, 'src', 'work.txt'), 'unmerged work');
    git(squash, 'add', '.');
    git(squash, 'commit', '-q', '-m', 'squashed');
    git(squash, 'push', '-q', 'origin', 'HEAD:main');
    expect(() => removeWith({ state: 'MERGED', headRefOid: 'f'.repeat(40) })).toThrow(
      'not the local tip',
    );
    expect(existsSync(created.path)).toBe(true);
    expect(removeWith({ state: 'MERGED', headRefOid: tip }).branch).toBe('feature/alpha');
    expect(existsSync(created.path)).toBe(false);
  });

  scenarios.scenario('--retired removes a branch with unmerged work', () => {
    const created = create();
    commitInWorktree(created.path);
    expect(removeWith({ state: 'OPEN', headRefOid: 'x' }, true).remoteDeleted).toBe(true);
    expect(git(checkout, 'branch', '--list', 'feature/alpha')).toBe('');
  });

  scenarios.scenario('refuses a name that is not a worktree', () => {
    expect(() => remove('ghost')).toThrow('is not a worktree under the claude root');
  });

  scenarios.scenario(
    "refuses a worktree reached through a link that leaves the provider's root",
    () => {
      const outside = join(sandbox, 'outside', 'wt');
      git(checkout, 'worktree', 'add', '-q', '-b', 'outside-branch', outside, 'origin/main');
      mkdirSync(roots.claude, { recursive: true });
      symlinkSync(outside, join(roots.claude, 'linked'));
      expect(() => remove('linked')).toThrow('is not a worktree under the claude root');
      expect(existsSync(outside)).toBe(true);
      expect(git(checkout, 'branch', '--list', 'outside-branch')).not.toBe('');
    },
  );

  scenarios.scenario('refuses to delete the default branch', () => {
    mkdirSync(roots.codex, { recursive: true });
    git(checkout, 'checkout', '-q', '--detach');
    git(checkout, 'worktree', 'add', '-q', join(roots.codex, 'main-tree'), 'main');
    expect(() =>
      removeWorktree(
        { configPath, provider: 'codex', name: 'main-tree', keepRemote: false },
        { checkout },
      ),
    ).toThrow('default branch');
    expect(existsSync(join(roots.codex, 'main-tree'))).toBe(true);
  });
});

describe('run', () => {
  scenarios.scenario('create then remove through the command line', () => {
    const created = runCli([
      'create',
      '--config',
      configPath,
      '--provider',
      'claude',
      '--name',
      'alpha',
      '--branch',
      'feature/alpha',
    ]);
    expect(created.code).toBe(0);
    expect(created.output).toContain('install: exit 0');
    const removed = runCli([
      'remove',
      '--config',
      configPath,
      '--provider',
      'claude',
      '--name',
      'alpha',
      '--json',
    ]);
    expect(removed.code).toBe(0);
    expect(JSON.parse(removed.output).branch).toBe('feature/alpha');
  });

  scenarios.scenario('a refusal is exit 1 with the reason; bad usage throws', () => {
    const refused = runCli([
      'create',
      '--config',
      configPath,
      '--provider',
      'claude',
      '--name',
      'm',
      '--branch',
      'main',
    ]);
    expect(refused.code).toBe(1);
    expect(refused.output).toContain('default branch');
    expect(() => runCli([])).toThrow(UsageError);
    expect(() => runCli(['create', '--config', configPath])).toThrow(UsageError);
  });
});

/**
 * Last on purpose. Observed on Bun 1.4.2: in every run of this file, and in none when this
 * scenario is removed, a command that starts about five seconds after the `sleep` child below was
 * spawned is killed with SIGTERM by something outside the test (the cause is not identified). A
 * scenario that ran after it would see a random `git` or `lsof` die, so nothing runs after it.
 */
describe('removeWorktree with a busy worktree', () => {
  const remove = (name = 'alpha', keepRemote = false) =>
    removeWorktree({ configPath, provider: 'claude', name, keepRemote }, { checkout });

  scenarios.scenario(
    'refuses while a process has its working directory inside the worktree',
    async () => {
      const created = create();
      const child = spawnWithHangGuard(['sleep', '30'], { cwd: join(created.path, 'src') });
      children.push(child);
      await Bun.sleep(150);
      expect(() => remove()).toThrow(`${child.pid} sleep`);
      expect(existsSync(created.path)).toBe(true);
      child.kill();
      await child.exited;
      expect(remove().path).toBe(created.path);
    },
  );
});

await scenarios.settled();
