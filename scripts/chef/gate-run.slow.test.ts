import { describe, expect } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGateLog, run, runControl, runGate, UsageError } from './gate-run.ts';
import { defaultRunner, type Runner } from './process-runner.ts';
import { createScenarios } from './scenario.test-support.ts';

/**
 * `runGate` and `runControl` run real shells and a real Git repository, so each case runs at
 * module scope in the slow lane rather than on the five-second per-test clock.
 */

let sandbox = '';
let repository = '';
let configPath = '';

const gitEnvironment = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

function writeConfig(overrides: Record<string, unknown> = {}) {
  writeFileSync(
    configPath,
    JSON.stringify({
      repository: 'o/n',
      defaultBranch: 'main',
      worktreeRoots: { claude: join(sandbox, 'c'), codex: join(sandbox, 'x') },
      manifestName: 'n',
      installCommand: 'true',
      gateCommand: 'echo gate-output',
      affectedCheckCommand: 'true',
      mergeMethod: 'squash',
      ...overrides,
    }),
  );
}

const scenarios = createScenarios({
  setUp() {
    sandbox = mkdtempSync(join(tmpdir(), 'gate-run-'));
    repository = join(sandbox, 'repository');
    mkdirSync(repository);
    defaultRunner(['git', 'init', '-q', '-b', 'main'], { cwd: repository });
    writeFileSync(join(repository, 'file.txt'), 'x');
    defaultRunner(['git', 'add', '.'], { cwd: repository });
    defaultRunner(['git', 'commit', '-q', '-m', 'initial'], {
      cwd: repository,
      env: gitEnvironment,
    });
    configPath = join(sandbox, 'config.json');
    writeConfig();
  },
  tearDown() {
    rmSync(sandbox, { recursive: true, force: true });
  },
});

function repositoryHead(): string {
  return defaultRunner(['git', 'rev-parse', 'HEAD'], { cwd: repository }).stdout.trim();
}

describe('runGate', () => {
  scenarios.scenario(
    "writes head and load first, the output, and GATE_RC, and returns the gate's code",
    () => {
      writeConfig({ gateCommand: 'echo gate-output; echo to-stderr >&2; exit 3' });
      const log = join(sandbox, 'logs', 'gate.log');
      const result = runGate({ configPath, worktree: repository, log }, { load: () => 2.5 });
      expect(result.code).toBe(3);
      expect(result.head).toBe(repositoryHead());
      const lines = readFileSync(log, 'utf8').split('\n');
      expect(lines[0]).toBe(`HEAD ${repositoryHead()} LOAD 2.50`);
      expect(lines).toContain('gate-output');
      expect(lines).toContain('to-stderr');
      expect(lines).toContain('GATE_RC=3');
      expect(readGateLog(readFileSync(log, 'utf8')).exitCode).toBe(3);
    },
  );

  scenarios.scenario(
    'records a clean tree at both ends, ignoring a log under an ignored directory',
    () => {
      writeFileSync(join(repository, '.gitignore'), 'tmp/\n');
      defaultRunner(['git', 'add', '.'], { cwd: repository });
      defaultRunner(['git', 'commit', '-q', '-m', 'ignore tmp'], {
        cwd: repository,
        env: gitEnvironment,
      });
      const log = join(repository, 'tmp', 'gate.log');
      const result = runGate({
        configPath,
        worktree: repository,
        log,
        command: 'echo built > tmp/artifact',
      });
      expect(result.startClean).toBe(true);
      expect(result.endClean).toBe(true);
      expect(result.endHead).toBe(repositoryHead());
      const summary = readGateLog(readFileSync(log, 'utf8'));
      expect(summary.treeStart).toEqual({ clean: true, head: repositoryHead() });
      expect(summary.treeEnd).toEqual({ clean: true, head: repositoryHead() });
    },
  );

  scenarios.scenario(
    'records a dirty start, a gate that dirties the tree, and a gate that moves HEAD',
    () => {
      writeFileSync(join(repository, 'untracked.txt'), 'dirt');
      const dirtyStart = runGate({ configPath, worktree: repository, log: join(sandbox, 'a.log') });
      expect(dirtyStart.startClean).toBe(false);
      expect(readGateLog(readFileSync(join(sandbox, 'a.log'), 'utf8')).treeStart?.clean).toBe(
        false,
      );
      rmSync(join(repository, 'untracked.txt'));

      const dirtied = runGate({
        configPath,
        worktree: repository,
        log: join(sandbox, 'b.log'),
        command: 'echo changed > file.txt',
      });
      expect(dirtied.startClean).toBe(true);
      expect(dirtied.endClean).toBe(false);
      defaultRunner(['git', 'checkout', '--', 'file.txt'], { cwd: repository });

      const before = repositoryHead();
      const moved = runGate({
        configPath,
        worktree: repository,
        log: join(sandbox, 'c.log'),
        command: 'git -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m moved',
      });
      expect(moved.head).toBe(before);
      expect(moved.endHead).toBe(repositoryHead());
      expect(moved.endHead).not.toBe(before);
      const summary = readGateLog(readFileSync(join(sandbox, 'c.log'), 'utf8'));
      expect(summary.treeStart?.head).toBe(before);
      expect(summary.treeEnd?.head).toBe(repositoryHead());
    },
  );

  scenarios.scenario('--command overrides the configured gate, and the wrapper prefixes it', () => {
    writeConfig({ gateWrapper: 'env CHEF_WRAPPED=yes' });
    const log = join(sandbox, 'gate.log');
    const result = runGate({
      configPath,
      worktree: repository,
      log,
      command: 'echo "wrapped=$CHEF_WRAPPED"',
    });
    expect(result.code).toBe(0);
    expect(readFileSync(log, 'utf8')).toContain('wrapped=yes');
  });

  scenarios.scenario(
    "puts GATE_RC on its own line when the gate's output has no trailing newline",
    () => {
      const log = join(sandbox, 'gate.log');
      runGate({ configPath, worktree: repository, log, command: 'printf partial' });
      expect(readFileSync(log, 'utf8')).toMatch(
        /partial\nTREE_END clean=true head=[0-9a-f]{40}\nGATE_RC=0\n$/,
      );
    },
  );

  scenarios.scenario(
    'waits while the lock pattern matches, logging each wait to the log and none to stdout',
    () => {
      writeConfig({ lockPattern: '^held' });
      const log = join(sandbox, 'gate.log');
      let pgrepCalls = 0;
      const sleeps: number[] = [];
      const runner: Runner = (command, options) => {
        if (command[0] === 'pgrep') {
          pgrepCalls += 1;
          return pgrepCalls <= 2
            ? { code: 0, stdout: '77 held lock\n', stderr: '' }
            : { code: 1, stdout: '', stderr: '' };
        }
        return defaultRunner(command, options);
      };
      const result = runGate(
        { configPath, worktree: repository, log },
        { runner, sleep: (milliseconds) => sleeps.push(milliseconds) },
      );
      expect(result.waits).toBe(2);
      expect(sleeps).toEqual([15_000, 15_000]);
      const text = readFileSync(log, 'utf8');
      expect(text.split('\n')[0]).toStartWith('HEAD ');
      expect(text.match(/^WAIT /gm)).toHaveLength(2);
      expect(text).toContain('lock held by 77');
    },
  );

  scenarios.scenario('rejects a directory that is not a worktree', () => {
    const plain = join(sandbox, 'plain');
    mkdirSync(plain);
    expect(() => runGate({ configPath, worktree: plain, log: join(sandbox, 'gate.log') })).toThrow(
      UsageError,
    );
    expect(() =>
      runGate({ configPath, worktree: join(sandbox, 'missing'), log: join(sandbox, 'gate.log') }),
    ).toThrow('No such worktree');
  });
});

describe('runControl', () => {
  function trees() {
    const candidate = join(sandbox, 'candidate');
    const base = join(sandbox, 'base');
    mkdirSync(candidate);
    mkdirSync(base);
    return { candidate, base };
  }

  scenarios.scenario("a failure only the candidate has is the candidate's: exit 1", () => {
    const { candidate, base } = trees();
    writeFileSync(join(base, 'marker'), '');
    const log = join(sandbox, 'control.tsv');
    const result = runControl(
      {
        candidate,
        base,
        command: "test -f marker || { echo '(fail) pkg > broken [1ms]'; exit 1; }",
        iterations: 3,
        log,
      },
      { load: () => 1 },
    );
    expect(result.candidateFailures).toBe(3);
    expect(result.baseFailures).toBe(0);
    expect(result.shared).toBe(false);
    const rows = readFileSync(log, 'utf8').trim().split('\n');
    expect(rows[0]).toBe('iteration\ttree\tload\texit\tfailing_tests');
    expect(rows).toHaveLength(7);
    expect(rows[1]).toBe('1\tcandidate\t1.00\t1\tpkg > broken');
    expect(rows[2]).toBe('1\tbase\t1.00\t0\t');
  });

  scenarios.scenario('alternates trees and records load before each run', () => {
    const { candidate, base } = trees();
    const visited: string[] = [];
    let loadReads = 0;
    const runner: Runner = (_command, options) => {
      visited.push(options?.cwd ?? '');
      return { code: 0, stdout: '', stderr: '' };
    };
    const result = runControl(
      { candidate, base, command: 'true', iterations: 2, log: join(sandbox, 'c.tsv') },
      { runner, load: () => ++loadReads },
    );
    expect(visited).toEqual([candidate, base, candidate, base]);
    expect(result.rows.map((row) => row.load)).toEqual([1, 2, 3, 4]);
  });

  scenarios.scenario('a failure both trees share exits 0 through run', () => {
    const { candidate, base } = trees();
    const result = run([
      'control',
      '--candidate',
      candidate,
      '--base',
      base,
      '--command',
      'exit 1',
      '--iterations',
      '2',
      '--log',
      join(sandbox, 'c.tsv'),
    ]);
    expect(result.code).toBe(0);
    expect(result.output).toContain('candidate failed 2 of 2');
    expect(result.output).toContain('base failed 2 of 2');
  });

  scenarios.scenario('a base that fails less than the candidate exits 1', () => {
    const { candidate, base } = trees();
    writeFileSync(join(base, 'marker'), '');
    const result = run([
      'control',
      '--candidate',
      candidate,
      '--base',
      base,
      '--command',
      'test -f marker',
      '--iterations',
      '1',
      '--log',
      join(sandbox, 'c.tsv'),
    ]);
    expect(result.code).toBe(1);
  });
});

describe('run', () => {
  scenarios.scenario("run exits with the gate's code and prints a short line", () => {
    const log = join(sandbox, 'gate.log');
    const result = run([
      'run',
      '--config',
      configPath,
      '--worktree',
      repository,
      '--log',
      log,
      '--command',
      'exit 4',
    ]);
    expect(result.code).toBe(4);
    expect(result.output.split('\n')).toHaveLength(1);
  });

  scenarios.scenario('read exits 0 only for a log holding exit code 0, and 1 for none', () => {
    const passing = join(sandbox, 'pass.log');
    const failing = join(sandbox, 'fail.log');
    const unfinished = join(sandbox, 'unfinished.log');
    writeFileSync(passing, 'HEAD a LOAD 1\nGATE_RC=0\n');
    writeFileSync(failing, 'HEAD a LOAD 1\nGATE_RC=1\n');
    writeFileSync(unfinished, 'HEAD a LOAD 1\nrunning\n');
    expect(run(['read', passing]).code).toBe(0);
    expect(run(['read', failing]).code).toBe(1);
    const open = run(['read', unfinished, '--json']);
    expect(open.code).toBe(1);
    expect(JSON.parse(open.output).exitCode).toBeUndefined();
  });

  scenarios.scenario(
    'a missing log, an unknown command and bad iterations are usage errors',
    () => {
      expect(() => run(['read', join(sandbox, 'missing.log')])).toThrow(UsageError);
      expect(() => run(['bogus'])).toThrow(UsageError);
      expect(() => run([])).toThrow(UsageError);
      expect(() =>
        run([
          'control',
          '--candidate',
          sandbox,
          '--base',
          sandbox,
          '--command',
          'true',
          '--iterations',
          '0',
          '--log',
          'x',
        ]),
      ).toThrow('--iterations');
      expect(existsSync(join(sandbox, 'x'))).toBe(false);
    },
  );
});

await scenarios.settled();
