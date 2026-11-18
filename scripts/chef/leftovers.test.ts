import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  callerAncestors,
  findLeftovers,
  findLockProcesses,
  findWorktreeProcesses,
  parseLsofFields,
  parsePgrep,
  ProbeError,
  renderLeftovers,
  run,
  UsageError,
} from './leftovers.ts';
import type { Runner } from './process-runner.ts';

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'leftovers-'));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function fakeRunner(stdout: string, record?: string[][]): Runner {
  return (command) => {
    record?.push(command);
    return { code: stdout === '' ? 1 : 0, stdout, stderr: '', pid: 50 };
  };
}

describe('parsers', () => {
  test('parsePgrep reads pid and command line', () => {
    expect(parsePgrep('123 bun /x/run-exclusively.ts validate\n456 sh -c y\n')).toEqual([
      { pid: 123, command: 'bun /x/run-exclusively.ts validate' },
      { pid: 456, command: 'sh -c y' },
    ]);
    expect(parsePgrep('')).toEqual([]);
  });

  test('parseLsofFields pairs each pid with its command and merges repeats', () => {
    expect(parseLsofFields('p10\nR1\ncsleep\np11\nR10\ncbun\np10\ncsleep\n')).toEqual([
      { pid: 10, parent: 1, command: 'sleep' },
      { pid: 11, parent: 10, command: 'bun' },
    ]);
  });

  test('caller ancestors exclude only the caller chain', () => {
    const parents = new Map([
      [10, 9],
      [9, 1],
      [11, 10],
      [12, 2],
    ]);
    expect(callerAncestors(10, (pid) => parents.get(pid))).toEqual(new Set([9]));
    expect(callerAncestors(11, (pid) => parents.get(pid))).toEqual(new Set([10, 9]));
  });
});

describe('lookups with a fake runner', () => {
  test('findLockProcesses asks pgrep for the pattern and drops this process', () => {
    const calls: string[][] = [];
    const found = findLockProcesses('^pattern', fakeRunner('5 a\n6 b\n', calls), 5);
    expect(calls).toEqual([['pgrep', '-fl', '^pattern']]);
    expect(found).toEqual([{ pid: 6, command: 'b' }]);
  });

  test('findLeftovers reports found only when something is there', () => {
    const empty = findLeftovers(
      { lockPattern: 'x', worktrees: [sandbox], pids: [999] },
      {
        runner: fakeRunner(''),
        isAlive: () => false,
      },
    );
    expect(empty.found).toBe(false);
    const lock = findLeftovers({ lockPattern: 'x' }, { runner: fakeRunner('7 held\n') });
    expect(lock.found).toBe(true);
    const alive = findLeftovers({ pids: [1] }, { runner: fakeRunner(''), isAlive: () => true });
    expect(alive.found).toBe(true);
  });

  test('no lock pattern means no pgrep call', () => {
    const calls: string[][] = [];
    findLeftovers({}, { runner: fakeRunner('', calls) });
    expect(calls).toEqual([]);
  });
});

describe('run', () => {
  test('exits 0 when nothing is found', () => {
    const result = run(['--worktree', sandbox, '--pids', '999999999'], {
      runner: fakeRunner(''),
      isAlive: () => false,
    });
    expect(result.code).toBe(0);
    expect(result.output).toContain('pids alive: none');
    expect(result.output).toContain('Nothing found.');
  });

  test('reads the lock pattern from a configuration', () => {
    const configPath = join(sandbox, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        repository: 'o/n',
        defaultBranch: 'main',
        worktreeRoots: { claude: '/a', codex: '/b' },
        manifestName: 'n',
        installCommand: 'i',
        gateCommand: 'g',
        affectedCheckCommand: 'a',
        lockPattern: '^held',
        mergeMethod: 'squash',
      }),
    );
    const calls: string[][] = [];
    const result = run(['--config', configPath], { runner: fakeRunner('42 held thing\n', calls) });
    expect(calls[0]).toEqual(['pgrep', '-fl', '^held']);
    expect(result.code).toBe(1);
    expect(result.output).toContain('42 held thing');
  });

  test('rejects bad usage', () => {
    expect(() => run(['--pids', 'abc'])).toThrow(UsageError);
    expect(() => run(['stray'])).toThrow(UsageError);
    expect(() => run(['--bogus'])).toThrow(UsageError);
  });

  test('renderLeftovers is compact', () => {
    const text = renderLeftovers({
      lockProcesses: [{ pid: 1, command: 'x'.repeat(300) }],
      worktrees: [{ path: '/w', processes: [{ pid: 2, command: 'bun' }] }],
      pids: [{ pid: 3, alive: false }],
      found: true,
    });
    expect(text.split('\n').length).toBeLessThanOrEqual(8);
    expect(text).toContain('...');
    expect(text).toContain('pids gone: 3');
  });
});

describe('findWorktreeProcesses fails closed', () => {
  const answer =
    (code: number, stdout: string, stderr: string): Runner =>
    () => ({ code, stdout, stderr, pid: 50 });

  test('lsof exiting 1 with no output at all means nothing is there', () => {
    expect(findWorktreeProcesses(sandbox, answer(1, '', ''), 0)).toEqual([]);
  });

  test('lsof output is parsed whether it exited 0 or 1 with warnings', () => {
    const found = [{ pid: 10, command: 'sleep' }];
    expect(findWorktreeProcesses(sandbox, answer(0, 'p10\ncsleep\n', ''), 0)).toEqual(found);
    expect(findWorktreeProcesses(sandbox, answer(1, 'p10\ncsleep\n', 'lsof: WARNING'), 0)).toEqual(
      found,
    );
  });

  test('does not report a caller ancestor but keeps an owned background child', () => {
    const calls: string[][] = [];
    const runner: Runner = (command) => {
      calls.push(command);
      if (command[0] === 'lsof')
        return { code: 0, stdout: 'p9\nczsh\np11\ncbun\n', stderr: '', pid: 50 };
      if (command.at(-1) === '10') return { code: 0, stdout: '9\n', stderr: '' };
      if (command.at(-1) === '9') return { code: 0, stdout: '1\n', stderr: '' };
      return { code: 1, stdout: '', stderr: '', pid: 51 };
    };
    expect(findWorktreeProcesses(sandbox, runner, 10)).toEqual([{ pid: 11, command: 'bun' }]);
    expect(calls.filter((call) => call[0] === 'ps')).toHaveLength(2);
  });

  test('fails closed when the runner cannot identify its lsof probe', () => {
    expect(() =>
      findWorktreeProcesses(sandbox, () => ({ code: 0, stdout: 'p10\ncbun\n', stderr: '' }), 1),
    ).toThrow(ProbeError);
  });

  test('a missing lsof (exit 127) or an error on stderr is unknown, not empty', () => {
    for (const runner of [
      answer(127, '', 'could not start the command (Error ENOENT)'),
      answer(1, '', 'lsof: no pwd entry for UID 501'),
      answer(2, '', ''),
    ]) {
      const error = (() => {
        try {
          findWorktreeProcesses(sandbox, runner, 0);
        } catch (reason) {
          return reason;
        }
        return undefined;
      })();
      expect(error).toBeInstanceOf(ProbeError);
      expect((error as Error).message).toContain('lsof could not check');
    }
  });

  test('findLeftovers reports an unchecked worktree as found, with the reason', () => {
    const report = findLeftovers(
      { worktrees: [sandbox] },
      { runner: answer(127, '', 'could not start the command (Error ENOENT)') },
    );
    expect(report.found).toBe(true);
    expect(report.worktrees[0]?.processes).toEqual([]);
    expect(report.worktrees[0]?.error).toContain('lsof could not check');
    const text = renderLeftovers(report);
    expect(text).toContain('could not be checked');
    expect(text).toContain('Leftovers found.');
    expect(run(['--worktree', sandbox], { runner: answer(127, '', 'x') }).code).toBe(1);
  });
});
