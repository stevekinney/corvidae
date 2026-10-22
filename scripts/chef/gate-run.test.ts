import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGateLog, renderGateSummary, run, runGate } from './gate-run.ts';
import type { Runner } from './process-runner.ts';

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
      expect(run(['read', join(sandbox, 'gate.log')]).output).toContain('exit code: none');
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});

describe('runGate with a fake runner', () => {
  test('records the head and load first, waits out the lock, and appends the final exit code', () => {
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
      const runner: Runner = (command) => {
        commands.push(command);
        if (command[0] === 'pgrep') {
          lockChecks += 1;
          return lockChecks === 1
            ? { code: 0, stdout: '77 held lock\n', stderr: '' }
            : { code: 1, stdout: '', stderr: '' };
        }
        if (command[0] === 'git') return { code: 0, stdout: 'abc123\n', stderr: '' };
        return { code: 4, stdout: '', stderr: '' };
      };
      const log = join(sandbox, 'gate.log');
      const result = runGate(
        { configPath, worktree, log },
        { runner, load: () => 1.5, sleep: () => undefined },
      );
      expect(result).toEqual({ code: 4, head: 'abc123', waits: 1 });
      const text = readFileSync(log, 'utf8');
      expect(text.split('\n')[0]).toBe('HEAD abc123 LOAD 1.50');
      expect(text).toContain('lock held by 77');
      expect(text.endsWith('GATE_RC=4\n')).toBe(true);
      const gate = commands.at(-1) ?? [];
      expect(gate.slice(0, 2)).toEqual(['sh', '-c']);
      expect(gate[2]).toStartWith("wrap sh -c 'the-gate' >> ");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
