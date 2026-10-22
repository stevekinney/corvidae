import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findLeftovers,
  findLockProcesses,
  parseLsofFields,
  parsePgrep,
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
    return { code: stdout === '' ? 1 : 0, stdout, stderr: '' };
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
    expect(parseLsofFields('p10\ncsleep\np11\ncbun\np10\ncsleep\n')).toEqual([
      { pid: 10, command: 'sleep' },
      { pid: 11, command: 'bun' },
    ]);
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
