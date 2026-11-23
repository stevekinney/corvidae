import { describe, expect, test } from 'bun:test';

import { rejectionOf } from '../../testing/testing/src/helpers/promise-outcome.ts';

import { formatVerdict, landQueueVerdict, run, UsageError } from './land-queue.ts';
import type { Runner } from './process-runner.ts';

const EVIDENCE = 'e'.repeat(40);
const MERGE_BASE = 'b'.repeat(40);
const MAIN_HEAD = 'a'.repeat(40);
const TREE = 'c'.repeat(40);
const C1 = '1'.repeat(40);
const C2 = '2'.repeat(40);

interface Repository {
  /** Commits `main` gained since the merge base, oldest first. */
  commits?: string[];
  /** The paths `git merge-tree` reports as conflicting; any makes it exit 1. */
  conflicts?: string[];
  /** `git merge-tree` fails for another reason (a missing object). */
  mergeTreeFails?: boolean;
}

/** A repository whose `main` gained `commits`, and whose merge of the evidence is as described. */
function repository(spec: Repository = {}): { runner: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: Runner = (command) => {
    calls.push(command);
    const [, verb, ...rest] = command;
    const out = (stdout: string) => ({ code: 0, stdout: `${stdout}\n`, stderr: '' });
    if (verb === 'fetch') return out('');
    if (verb === 'rev-parse')
      return out(rest.includes(`${EVIDENCE}^{commit}`) ? EVIDENCE : MAIN_HEAD);
    if (verb === 'merge-base') return out(MERGE_BASE);
    if (verb === 'rev-list') return out((spec.commits ?? []).join('\n'));
    if (verb === 'merge-tree') {
      if (spec.mergeTreeFails === true)
        return { code: 128, stdout: '', stderr: 'fatal: bad object' };
      const conflicts = spec.conflicts ?? [];
      return {
        code: conflicts.length === 0 ? 0 : 1,
        stdout: [TREE, ...conflicts].join('\0') + '\0',
        stderr: '',
      };
    }
    return { code: 1, stdout: '', stderr: `unexpected ${command.join(' ')}` };
  };
  return { runner, calls };
}

function verdict(spec: Repository = {}) {
  return landQueueVerdict({ runner: repository(spec).runner, evidence: EVIDENCE });
}

describe('land-queue verdict', () => {
  test('main has not moved: lands, with nothing merged in', () => {
    expect(verdict()).toMatchObject({ verdict: 'LAND', tree: TREE, mergedIn: [], conflicts: [] });
  });

  test('main moved and the head merges cleanly: lands, naming the commits merged onto', () => {
    expect(verdict({ commits: [C1, C2] })).toMatchObject({
      verdict: 'LAND',
      evidence: EVIDENCE,
      mergeBase: MERGE_BASE,
      mainHead: MAIN_HEAD,
      tree: TREE,
      mergedIn: [C1, C2],
    });
  });

  test('a conflict is the only refusal, naming the paths', () => {
    const result = verdict({ commits: [C1], conflicts: ['shared.txt', 'src/a.ts'] });
    expect(result).toMatchObject({
      verdict: 'CONFLICT',
      conflicts: ['shared.txt', 'src/a.ts'],
      mergedIn: [C1],
    });
    expect(result.tree).toBeUndefined();
  });

  test('merges the head onto main with the flags that name conflicts verbatim', () => {
    const { runner, calls } = repository();
    landQueueVerdict({ runner, evidence: EVIDENCE });
    expect(calls.find((call) => call[1] === 'merge-tree')).toEqual([
      'git',
      'merge-tree',
      '--write-tree',
      '--name-only',
      '--no-messages',
      '-z',
      MAIN_HEAD,
      EVIDENCE,
    ]);
  });

  test('only reads: it never merges, fetches or writes', () => {
    const { runner, calls } = repository({ commits: [C1] });
    landQueueVerdict({ runner, evidence: EVIDENCE });
    expect(calls.map((call) => call[1])).toEqual([
      'rev-parse',
      'rev-parse',
      'merge-base',
      'rev-list',
      'merge-tree',
    ]);
  });

  test('a git failure is refused as a usage error, never read as a clean merge', () => {
    expect(() => verdict({ mergeTreeFails: true })).toThrow(UsageError);
    expect(() =>
      landQueueVerdict({
        runner: () => ({ code: 128, stdout: '', stderr: 'fatal: not a repository' }),
        evidence: EVIDENCE,
      }),
    ).toThrow(UsageError);
  });

  test('the text names no new evidence run on LAND and the paths on a conflict', () => {
    expect(formatVerdict(verdict({ commits: [C1] }))).toContain('without a new evidence run');
    const text = formatVerdict(verdict({ conflicts: ['shared.txt'] }));
    expect(text.split('\n')[0]).toBe('CONFLICT');
    expect(text).toContain('conflicts with main at shared.txt');
    expect(text).toContain('  shared.txt');
  });
});

describe('land-queue command', () => {
  const dependencies = (spec: Repository = {}) => ({
    runner: repository(spec).runner,
    withLock: async <T>(_: unknown, action: () => T) => action(),
  });

  test('exit 0 on LAND and 3 on CONFLICT, with the paths in the output', async () => {
    const landed = await run(['--evidence', EVIDENCE], dependencies({ commits: [C1] }));
    expect(landed.code).toBe(0);
    expect(landed.output.split('\n')[0]).toBe('LAND');
    const conflicted = await run(
      ['--evidence', EVIDENCE, '--json'],
      dependencies({ conflicts: ['shared.txt'] }),
    );
    expect(conflicted.code).toBe(3);
    expect(JSON.parse(conflicted.output).conflicts).toEqual(['shared.txt']);
  });

  test('holds the lock while it reads main', async () => {
    const order: string[] = [];
    const base = dependencies();
    await run(['--evidence', EVIDENCE], {
      runner: (command, options) => {
        order.push(`git ${command[1]}`);
        return base.runner(command, options);
      },
      withLock: async (_, action) => {
        order.push('lock');
        const value = action();
        order.push('unlock');
        return value;
      },
    });
    expect(order[0]).toBe('lock');
    expect(order.at(-1)).toBe('unlock');
    expect(order).toContain('git merge-tree');
  });

  test('fetches main inside the lock before it reads it', async () => {
    const order: string[] = [];
    const base = dependencies();
    await run(['--evidence', EVIDENCE], {
      ...base,
      runner: (command, options) => {
        order.push(command.slice(1).join(' '));
        return base.runner(command, options);
      },
    });
    expect(order[0]).toBe('fetch origin main');
    expect(order.indexOf('fetch origin main')).toBeLessThan(
      order.findIndex((entry) => entry.startsWith('rev-parse')),
    );
  });

  test('requires --evidence and refuses a positional argument', async () => {
    expect(await rejectionOf(run([], dependencies()))).toBeInstanceOf(UsageError);
    expect(
      await rejectionOf(run(['--evidence', EVIDENCE, 'extra'], dependencies())),
    ).toBeInstanceOf(UsageError);
  });
});
