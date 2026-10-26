import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fakeSignals,
  fakeTree,
  finishedGate,
  manualTimer,
  pendingGate,
} from './gate-child.test-support.ts';
import {
  isProcessLive,
  readGateLog,
  renderGateSummary,
  run,
  runCommand,
  runGate,
} from './gate-run.ts';
import type { Runner } from './process-runner.ts';
import { quietFor } from '../wait-until.ts';

describe('readGateLog', () => {
  test('a log with no exit code reports none, never a pass', () => {
    const summary = readGateLog('HEAD abc LOAD 1.50\nstill going\n');
    expect(summary.exitCode).toBeUndefined();
    expect(renderGateSummary(summary)).toContain('exit code: none');
  });

  test('recognizes GATE_RC, VALIDATE_RC and validate exit=', () => {
    expect(readGateLog('x\nGATE_RC=0\n').exitCode).toBe(0);
    expect(readGateLog('x\nVALIDATE_RC=3\n').exitCode).toBe(3);
    expect(readGateLog('x\nvalidate exit=1\n').exitCode).toBe(1);
  });

  test('ignores an exit-code lookalike that is not on its own line, and takes the last one', () => {
    expect(readGateLog('the GATE_RC=0 string inside output\n').exitCode).toBeUndefined();
    expect(readGateLog('GATE_RC=1\nmore\nGATE_RC=0\n').exitCode).toBe(0);
    expect(readGateLog('GATE_RC=0\nmore\n').exitCode).toBeUndefined();
  });

  test('withholds the head and exit code from a log that holds two runs', () => {
    // Pairing the first run's failing head with the second run's passing code is the defect.
    const summary = readGateLog('HEAD aaa LOAD 1\nGATE_RC=1\nHEAD bbb LOAD 2\nGATE_RC=0\n');
    expect(summary.head).toBeUndefined();
    expect(summary.load).toBeUndefined();
    expect(summary.exitCode).toBeUndefined();
    expect(summary.problem).toContain('2 HEAD lines');
    expect(renderGateSummary(summary)).toContain('2 HEAD lines');
    expect(readGateLog('HEAD aaa LOAD 1\nGATE_RC=0\n').problem).toBeUndefined();
  });

  test('takes the exit code only from the last non-empty line', () => {
    // The gate printed an exit-code lookalike and then more output, or was cut off after it.
    expect(
      readGateLog('HEAD a LOAD 1\nGATE_RC=0\nthe gate kept printing\n').exitCode,
    ).toBeUndefined();
    expect(readGateLog('HEAD a LOAD 1\nvalidate exit=0\n(fail) later\n').exitCode).toBeUndefined();
    expect(readGateLog('HEAD a LOAD 1\nGATE_RC=3\n\n  \n').exitCode).toBe(3);
  });

  test('reads the tree state at the start and end, and only from exactly one line of each', () => {
    const log = [
      'HEAD abc LOAD 1',
      'TREE_START clean=true head=abc',
      'output',
      'TREE_END clean=false head=def',
      'GATE_RC=0',
    ].join('\n');
    const summary = readGateLog(log);
    expect(summary.treeStart).toEqual({ clean: true, head: 'abc' });
    expect(summary.treeEnd).toEqual({ clean: false, head: 'def' });
    expect(renderGateSummary(summary)).toContain('tree: start clean at abc, end dirty at def');
    expect(readGateLog('TREE_START clean=unknown head=abc\nGATE_RC=0\n').treeStart).toEqual({
      clean: undefined,
      head: 'abc',
    });
    const duplicated = readGateLog(
      'HEAD abc LOAD 1\nTREE_START clean=true head=abc\nTREE_START clean=true head=abc\nGATE_RC=0\n',
    );
    expect(duplicated.treeStart).toBeUndefined();
    expect(readGateLog('HEAD abc LOAD 1\nGATE_RC=0\n').treeEnd).toBeUndefined();
  });

  test('reads head and load from the first line', () => {
    const summary = readGateLog('HEAD 0123abc LOAD 4.25\nWAIT x\nGATE_RC=0\n');
    expect(summary.head).toBe('0123abc');
    expect(summary.load).toBe(4.25);
  });

  test('collects failed tasks from Failed: and ERROR command lines, deduplicated', () => {
    const summary = readGateLog(
      [
        '@lostgradient/weft:test: ERROR: command finished with error: command (/w/packages/weft) /bin/bun run test exited (1)',
        ' ERROR  run failed: command  exited (1)',
        ' Failed:    @lostgradient/weft#test',
        ' Failed:    @lostgradient/weft#test',
        'GATE_RC=1',
      ].join('\n'),
    );
    expect(summary.failedTasks).toEqual([
      '@lostgradient/weft:test exited (1)',
      '@lostgradient/weft#test',
    ]);
  });

  test('keeps the first ten failing tests with the package prefix and timing stripped', () => {
    const lines = Array.from(
      { length: 14 },
      (_, index) => `@lostgradient/weft:test: (fail) suite > case ${index} [${index}.5ms]`,
    );
    const summary = readGateLog([...lines, ...lines, '(fail) bare name', 'GATE_RC=1'].join('\n'));
    expect(summary.failedTests).toHaveLength(10);
    expect(summary.failedTests[0]).toBe('suite > case 0');
    expect(summary.failedTestCount).toBe(15);
    expect(renderGateSummary(summary)).toContain('first 10 of 15');
  });

  test('counts over-budget lines and strips ANSI', () => {
    const summary = readGateLog(
      '\x1b[31mover budget: a\x1b[0m\nover budget: b\n\x1b[31mGATE_RC=2\x1b[0m\n',
    );
    expect(summary.overBudget).toBe(2);
    expect(summary.exitCode).toBe(2);
  });
});

describe('read exit code', () => {
  test('is 0 only for a log that holds exit code 0; a log with none, or a non-zero one, is 1', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'gate-run-read-'));
    try {
      const code = (text: string) => {
        const path = join(sandbox, 'gate.log');
        writeFileSync(path, text);
        return run(['read', path]).code;
      };
      expect(code('HEAD abc LOAD 1\nGATE_RC=0\n')).toBe(0);
      expect(code('HEAD abc LOAD 1\nGATE_RC=2\n')).toBe(1);
      // Still running, or cut off: never inferred to have passed.
      expect(code('HEAD abc LOAD 1\nstill going\n')).toBe(1);
      // Two runs in one file: neither exit code can be attributed to a head.
      expect(code('HEAD a LOAD 1\nGATE_RC=1\nHEAD b LOAD 1\nGATE_RC=0\n')).toBe(1);
      expect(run(['read', join(sandbox, 'gate.log')]).output).toContain('exit code: none');
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});

describe('runGate with a fake runner', () => {
  test('runs the affected-only check without waiting for the lock, which it runs beside', async () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'gate-run-shared-'));
    try {
      const configPath = join(sandbox, 'config.json');
      writeFileSync(
        configPath,
        JSON.stringify({
          repository: 'o/n',
          defaultBranch: 'main',
          worktreeRoots: { claude: '/c', codex: '/x' },
          manifestName: 'n',
          installCommand: 'true',
          gateCommand: 'the-check',
          affectedCheckCommand: 'the-check',
          lockPattern: '^held',
          mergeMethod: 'squash',
        }),
      );
      const commands: string[][] = [];
      const runner: Runner = (command) => {
        commands.push(command);
        if (command[0] === 'pgrep') return { code: 0, stdout: '77 held lock\n', stderr: '' };
        if (command[1] === 'status') return { code: 0, stdout: '', stderr: '' };
        if (command[0] === 'git') return { code: 0, stdout: 'abc123\n', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      };
      const result = await runGate(
        { configPath, worktree: sandbox, log: join(sandbox, 'gate.log') },
        { runner, load: () => 1, sleep: () => undefined, spawnGate: () => finishedGate(0) },
      );
      expect(result.waits).toBe(0);
      expect(commands.some((command) => command[0] === 'pgrep')).toBe(false);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test("this repository's lock pattern matches a locked stage and not a shared check", () => {
    const { lockPattern } = JSON.parse(
      readFileSync(join(import.meta.dir, 'repository.json'), 'utf8'),
    ) as { lockPattern: string };
    const pattern = new RegExp(lockPattern);
    expect(pattern.test('bun scripts/run-exclusively.ts bun run lint:root && turbo run lint')).toBe(
      true,
    );
    expect(pattern.test('bun scripts/run-exclusively.ts --shared bun run lint:root')).toBe(false);
  });

  test('records the head and load first, waits out the lock, and appends the final exit code', async () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'gate-run-fast-'));
    try {
      const configPath = join(sandbox, 'config.json');
      const worktree = sandbox;
      writeFileSync(
        configPath,
        JSON.stringify({
          repository: 'o/n',
          defaultBranch: 'main',
          worktreeRoots: { claude: '/c', codex: '/x' },
          manifestName: 'n',
          installCommand: 'true',
          gateCommand: 'the-gate',
          affectedCheckCommand: 'true',
          gateWrapper: 'wrap',
          lockPattern: '^held',
          mergeMethod: 'squash',
        }),
      );
      const commands: string[][] = [];
      let lockChecks = 0;
      let statusCalls = 0;
      let headCalls = 0;
      const runner: Runner = (command) => {
        commands.push(command);
        if (command[0] === 'pgrep') {
          lockChecks += 1;
          return lockChecks === 1
            ? { code: 0, stdout: '77 held lock\n', stderr: '' }
            : { code: 1, stdout: '', stderr: '' };
        }
        if (command[1] === 'status') {
          statusCalls += 1;
          // Clean before the gate, a modified file after it.
          return { code: 0, stdout: statusCalls === 1 ? '' : ' M changed.ts\n', stderr: '' };
        }
        if (command[0] === 'git') {
          headCalls += 1;
          // The gate moves HEAD: the first two reads precede it, the third follows it.
          return { code: 0, stdout: headCalls <= 2 ? 'abc123\n' : 'def456\n', stderr: '' };
        }
        return { code: 4, stdout: '', stderr: '' };
      };
      const log = join(sandbox, 'gate.log');
      const scripts: string[] = [];
      const result = await runGate(
        { configPath, worktree, log },
        {
          runner,
          load: () => 1.5,
          sleep: () => undefined,
          spawnGate: (script) => {
            scripts.push(script);
            return finishedGate(4);
          },
        },
      );
      expect(result).toEqual({
        code: 4,
        head: 'abc123',
        waits: 1,
        startClean: true,
        endClean: false,
        endHead: 'def456',
      });
      const text = readFileSync(log, 'utf8');
      expect(text.split('\n')[0]).toBe('HEAD abc123 LOAD 1.50');
      expect(text).toContain('lock held by 77');
      expect(text.endsWith('TREE_END clean=false head=def456\nGATE_RC=4\n')).toBe(true);
      expect(text).toContain('TREE_START clean=true head=abc123\n');
      const summary = readGateLog(text);
      expect(summary.treeStart).toEqual({ clean: true, head: 'abc123' });
      expect(summary.treeEnd).toEqual({ clean: false, head: 'def456' });
      expect(summary.exitCode).toBe(4);
      expect(scripts).toHaveLength(1);
      expect(scripts[0]).toStartWith("wrap sh -c 'the-gate' >> ");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});

describe('runGate and signals', () => {
  const quietRunner: Runner = (command) => {
    if (command[1] === 'status') return { code: 0, stdout: '', stderr: '' };
    if (command[0] === 'git') return { code: 0, stdout: 'abc123\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };

  function sandboxWithConfig(overrides: Record<string, unknown> = {}) {
    const sandbox = mkdtempSync(join(tmpdir(), 'gate-run-signal-'));
    const configPath = join(sandbox, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        repository: 'o/n',
        defaultBranch: 'main',
        worktreeRoots: { claude: '/c', codex: '/x' },
        manifestName: 'n',
        installCommand: 'true',
        gateCommand: 'the-gate',
        affectedCheckCommand: 'the-gate',
        batchCommand: 'the-batch',
        mergeMethod: 'squash',
        ...overrides,
      }),
    );
    return { sandbox, configPath, log: join(sandbox, 'gate.log') };
  }

  test('a signal kills the whole group, arms SIGKILL, and records a non-zero exit', async () => {
    const { sandbox, configPath, log } = sandboxWithConfig();
    try {
      const child = pendingGate(900);
      const tree = fakeTree([901]);
      const signals = fakeSignals();
      const timer = manualTimer();
      const kills: [number, string][] = [];
      const running = runGate(
        { configPath, worktree: sandbox, log },
        {
          runner: quietRunner,
          load: () => 1,
          spawnGate: () => child,
          killGroup: (pid, signal) => kills.push([pid, signal]),
          signals,
          ...tree.seams,
          schedule: timer.schedule,
          graceMilliseconds: 5_000,
        },
      );
      await Promise.resolve();
      await Promise.resolve();
      expect(signals.registered()).toBe(3);
      signals.emit('SIGTERM');
      expect(kills).toEqual([[900, 'SIGTERM']]);
      expect(timer.state.milliseconds).toBe(5_000);
      // The wrapper exits, but turbo (901, in a session of its own) is still draining.
      child.finish(143);
      await quietFor(10);
      expect(timer.state.cancelled).toBe(false);
      // The grace period passes: the group and every collected process get SIGKILL.
      timer.fire();
      expect(kills).toEqual([
        [900, 'SIGTERM'],
        [900, 'SIGKILL'],
      ]);
      const result = await running;
      expect(tree.signalled).toContainEqual([901, 'SIGKILL']);
      expect(tree.alive.size).toBe(0);
      expect(result.code).toBe(143);
      expect(result.interrupted).toBe('SIGTERM');
      expect(signals.registered()).toBe(0);
      expect(timer.state.cancelled).toBe(true);
      const text = readFileSync(log, 'utf8');
      expect(text).toContain('GATE_INTERRUPTED SIGTERM\n');
      expect(text.endsWith('GATE_RC=143\n')).toBe(true);
      expect(readGateLog(text).exitCode).toBe(143);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('an interrupted gate reports the signal code whatever the child exited with', async () => {
    for (const [signal, code, childCode] of [
      ['SIGINT', 130, 0],
      ['SIGINT', 130, 1],
      ['SIGHUP', 129, 143],
      ['SIGTERM', 143, 2],
    ] as const) {
      const { sandbox, configPath, log } = sandboxWithConfig();
      try {
        const child = pendingGate(901);
        const signals = fakeSignals();
        const kills: [number, string][] = [];
        const running = runGate(
          { configPath, worktree: sandbox, log },
          {
            runner: quietRunner,
            load: () => 1,
            spawnGate: () => child,
            killGroup: (pid, name) => kills.push([pid, name]),
            signals,
            ...fakeTree().seams,
            schedule: manualTimer().schedule,
          },
        );
        await Promise.resolve();
        await Promise.resolve();
        signals.emit(signal);
        signals.emit(signal);
        // A second signal escalates to SIGKILL at once.
        expect(kills).toEqual([
          [901, 'SIGTERM'],
          [901, 'SIGKILL'],
        ]);
        child.finish(childCode);
        const result = await running;
        expect(result.code).toBe(code);
        expect(readFileSync(log, 'utf8').endsWith(`GATE_RC=${code}\n`)).toBe(true);
      } finally {
        rmSync(sandbox, { recursive: true, force: true });
      }
    }
  });

  test('an exit with no signal records the child code, signals no group and leaves no handler', async () => {
    const { sandbox, configPath, log } = sandboxWithConfig();
    try {
      const signals = fakeSignals();
      const timer = manualTimer();
      const kills: [number, string][] = [];
      const result = await runGate(
        { configPath, worktree: sandbox, log },
        {
          runner: quietRunner,
          load: () => 1,
          spawnGate: () => finishedGate(7),
          killGroup: (pid, signal) => kills.push([pid, signal]),
          signals,
          ...fakeTree().seams,
          schedule: timer.schedule,
        },
      );
      expect(result.code).toBe(7);
      expect(result.interrupted).toBeUndefined();
      expect(kills).toEqual([]);
      expect(signals.registered()).toBe(0);
      expect(readFileSync(log, 'utf8')).not.toContain('GATE_INTERRUPTED');
      expect(readFileSync(log, 'utf8').endsWith('GATE_RC=7\n')).toBe(true);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('an interrupted batch validate is not recorded as the health of main', async () => {
    const { sandbox, configPath, log } = sandboxWithConfig();
    try {
      const healthFile = join(sandbox, 'health.json');
      const child = pendingGate(902);
      const signals = fakeSignals();
      const running = runGate(
        { configPath, worktree: sandbox, log, command: 'the-batch', healthFile },
        {
          runner: quietRunner,
          load: () => 1,
          spawnGate: () => child,
          killGroup: () => undefined,
          signals,
          ...fakeTree().seams,
          schedule: manualTimer().schedule,
        },
      );
      await Promise.resolve();
      await Promise.resolve();
      signals.emit('SIGTERM');
      child.finish(143);
      const interrupted = await running;
      expect(interrupted.code).toBe(143);
      expect(existsSync(healthFile)).toBe(false);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('the run command reports an interrupted gate and exits with the signal code', async () => {
    const { sandbox, configPath, log } = sandboxWithConfig();
    try {
      const child = pendingGate(903);
      const signals = fakeSignals();
      const running = runCommand(
        ['run', '--config', configPath, '--worktree', sandbox, '--log', log],
        {
          runner: quietRunner,
          load: () => 1,
          spawnGate: () => child,
          killGroup: () => undefined,
          signals,
          ...fakeTree().seams,
          schedule: manualTimer().schedule,
        },
      );
      await Promise.resolve();
      await Promise.resolve();
      signals.emit('SIGHUP');
      child.finish(129);
      const result = await running;
      expect(result.code).toBe(129);
      expect(result.output).toContain('interrupted by SIGHUP');
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});

describe('isProcessLive', () => {
  test('a zombie or an unlisted pid is gone, and any other state is live', () => {
    expect(isProcessLive(1, () => 'Z')).toBe(false);
    expect(isProcessLive(1, () => 'Z+')).toBe(false);
    expect(isProcessLive(1, () => '')).toBe(false);
    expect(isProcessLive(1, () => 'S')).toBe(true);
    expect(isProcessLive(1, () => 'Ss+')).toBe(true);
    expect(isProcessLive(1, () => 'R')).toBe(true);
  });

  test('the real reader sees this process as live', () => {
    expect(isProcessLive(process.pid)).toBe(true);
  });
});

describe('triage', () => {
  /** A repository with the named workspaces, and a gate log that failed the named tasks. */
  function repositoryWith(workspaces: Record<string, string>, failedTasks: string[]) {
    const sandbox = mkdtempSync(join(tmpdir(), 'gate-run-triage-'));
    for (const [directory, name] of Object.entries(workspaces)) {
      mkdirSync(join(sandbox, directory), { recursive: true });
      writeFileSync(join(sandbox, directory, 'package.json'), JSON.stringify({ name }));
    }
    const log = join(sandbox, 'gate.log');
    writeFileSync(
      log,
      [
        'HEAD abc LOAD 1',
        ...failedTasks.map((task) => ` Failed:    ${task}`),
        'GATE_RC=1',
        '',
      ].join('\n'),
    );
    return { sandbox, log };
  }

  /** A fake commit-history lookup that answers per pathspec directory, newest commit first. */
  function fakeHistory(history: Record<string, string[]>) {
    const calls: { command: string[]; cwd: string | undefined }[] = [];
    const runner: Runner = (command, options) => {
      calls.push({ command, cwd: options?.cwd });
      const directory = command.at(-1) ?? '';
      return { code: 0, stdout: (history[directory] ?? []).join('\n'), stderr: '' };
    };
    return { runner, calls };
  }

  test('maps each failed task to the pull requests that changed its package since the base', () => {
    const { sandbox, log } = repositoryWith(
      { 'packages/weft': '@lostgradient/weft', 'packages/chat': '@lostgradient/chat' },
      ['@lostgradient/weft#test', '@lostgradient/chat#lint'],
    );
    try {
      const fake = fakeHistory({
        'packages/weft': [
          `${'b'.repeat(40)}\tFix replay (#482)`,
          `${'a'.repeat(40)}\tStart durable runs in two phases (#467)`,
          `${'c'.repeat(40)}\tAnother pass on #467 (#482)`,
        ],
      });
      const result = run(['triage', log, '--base', 'base123', '--repository', sandbox], {
        runner: fake.runner,
      });
      // Oldest first, and a pull request that landed two commits is named once.
      expect(result.output).toBe(
        [
          '@lostgradient/weft#test: PR #482, #467',
          '@lostgradient/chat#lint: no change since base (pre-existing or flaky)',
        ].join('\n'),
      );
      expect(result.code).toBe(1);
      expect(fake.calls[0]).toEqual({
        command: [
          'git',
          'log',
          '--first-parent',
          '--format=%H%x09%s',
          'base123..HEAD',
          '--',
          'packages/weft',
        ],
        cwd: sandbox,
      });
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('exits 0 when no failed task changed since the base, and prints JSON on request', () => {
    const { sandbox, log } = repositoryWith({ 'packages/weft': '@lostgradient/weft' }, [
      '@lostgradient/weft#test',
    ]);
    try {
      const result = run(['triage', log, '--base', 'b', '--repository', sandbox, '--json'], {
        runner: fakeHistory({}).runner,
      });
      expect(result.code).toBe(0);
      expect(JSON.parse(result.output)).toEqual({
        base: 'b',
        tasks: [
          {
            task: '@lostgradient/weft#test',
            package: '@lostgradient/weft',
            directory: 'packages/weft',
            commits: [],
            prs: [],
          },
        ],
      });
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('names a commit without a pull request number, and a package that is no workspace', () => {
    const { sandbox, log } = repositoryWith({ 'packages/weft': '@lostgradient/weft' }, [
      '@lostgradient/weft#test',
      'ghost#test',
    ]);
    try {
      const result = run(['triage', log, '--base', 'b', '--repository', sandbox], {
        runner: fakeHistory({ 'packages/weft': [`${'d'.repeat(40)}\tdirect push`] }).runner,
      });
      expect(result.output).toBe(
        [
          '@lostgradient/weft#test: PR ddddddddd',
          'ghost#test: ghost is not a workspace here, so it cannot be mapped',
        ].join('\n'),
      );
      expect(result.code).toBe(1);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('skips failures that name no package and runs no command when there are none', () => {
    const { sandbox, log } = repositoryWith({}, []);
    try {
      writeFileSync(
        log,
        'HEAD a LOAD 1\n@lostgradient/weft:test: ERROR: command finished with error: command (/w/packages/weft) /bin/bun exited (1)\nGATE_RC=1\n',
      );
      const fake = fakeHistory({});
      const result = run(['triage', log, '--base', 'b', '--repository', sandbox], {
        runner: fake.runner,
      });
      expect(result).toEqual({
        code: 0,
        output: 'No failed turbo tasks (<package>#<task>) in the log.',
      });
      expect(fake.calls).toEqual([]);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('a failing history lookup is an error, and bad arguments are rejected', () => {
    const { sandbox, log } = repositoryWith({ 'packages/weft': '@lostgradient/weft' }, [
      '@lostgradient/weft#test',
    ]);
    try {
      expect(() =>
        run(['triage', log, '--base', 'nope', '--repository', sandbox], {
          runner: () => ({ code: 128, stdout: '', stderr: 'fatal: bad revision' }),
        }),
      ).toThrow('fatal: bad revision');
      expect(() => run(['triage', log, '--repository', sandbox])).toThrow('--base is required');
      expect(() => run(['triage', '--base', 'b'])).toThrow('Usage');
      expect(() => run(['triage', join(sandbox, 'missing.log'), '--base', 'b'])).toThrow(
        'No such log',
      );
      expect(() => run(['triage', log, '--base', 'b', '--repository', join(sandbox, 'x')])).toThrow(
        'No such repository',
      );
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
