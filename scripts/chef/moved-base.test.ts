import { describe, expect, test } from 'bun:test';

import {
  acceptMovedBase,
  acceptMovedMain,
  describeConflicts,
  mergeHeadOnto,
} from './moved-base.ts';
import type { Runner } from './process-runner.ts';

const HEAD = 'h'.repeat(40);
const ATTESTED_BASE = 'a'.repeat(40);
const ATTESTED_TREE = '1'.repeat(40);
const CURRENT_BASE = 'b'.repeat(40);
const CURRENT_TREE = '2'.repeat(40);
const C1 = '3'.repeat(40);
const C2 = '4'.repeat(40);

interface Repository {
  /** Whether the attested base is an ancestor of the current base. */
  ancestor?: boolean;
  /** The tree the head merged onto the attested base gives; the attested tree by default. */
  reproduced?: string;
  /** The paths the head conflicts with the current base at; any makes the merge exit 1. */
  conflicts?: string[];
  /** The tree the head merged onto the current base gives. */
  merged?: string;
  /** The commits of main since the attested base. */
  gained?: string[];
}

/** A fake Git whose answers are the described repository's; `calls` records every command. */
function repository(spec: Repository = {}) {
  const calls: string[][] = [];
  const git = (...args: string[]): ReturnType<Runner> => {
    calls.push(args);
    const [verb, ...rest] = args;
    if (verb === 'merge-base')
      return { code: spec.ancestor === false ? 1 : 0, stdout: '', stderr: '' };
    if (verb === 'merge-tree') {
      const onto = rest.at(-2);
      if (onto === ATTESTED_BASE)
        return { code: 0, stdout: `${spec.reproduced ?? ATTESTED_TREE}\0`, stderr: '' };
      const conflicts = spec.conflicts ?? [];
      return {
        code: conflicts.length === 0 ? 0 : 1,
        stdout: [spec.merged ?? CURRENT_TREE, ...conflicts].join('\0') + '\0',
        stderr: '',
      };
    }
    if (verb === 'rev-list')
      return { code: 0, stdout: `${(spec.gained ?? []).join('\n')}\n`, stderr: '' };
    return { code: 1, stdout: '', stderr: `unexpected ${args.join(' ')}` };
  };
  return { git, calls };
}

const attested = { base: ATTESTED_BASE, tree: ATTESTED_TREE };

function accept(spec: Repository = {}, tree = CURRENT_TREE) {
  return acceptMovedMain(repository(spec).git, attested, HEAD, CURRENT_BASE, tree);
}

describe('mergeHeadOnto', () => {
  const merge = (stdout: string, code = 0, stderr = '') =>
    mergeHeadOnto(() => ({ code, stdout, stderr }), CURRENT_BASE, HEAD);

  test('a clean merge is its tree', () => {
    expect(merge(`${CURRENT_TREE}\0`)).toEqual({ tree: CURRENT_TREE });
  });

  test('a conflict is its paths, read verbatim', () => {
    expect(merge(`${CURRENT_TREE}\0a.txt\0naïve.txt\0`, 1)).toEqual({
      conflicts: ['a.txt', 'naïve.txt'],
    });
  });

  test('anything else is a failure, never a clean merge', () => {
    expect(merge('', 128, 'fatal: bad object')).toEqual({
      failure: 'git merge-tree failed (exit 128): fatal: bad object',
    });
    expect(merge('not a tree\0')).toMatchObject({ failure: expect.stringContaining('exit 0') });
  });

  test('asks for the paths without the messages, NUL-separated', () => {
    const { git, calls } = repository();
    mergeHeadOnto(git, CURRENT_BASE, HEAD);
    expect(calls[0]).toEqual([
      'merge-tree',
      '--write-tree',
      '--name-only',
      '--no-messages',
      '-z',
      CURRENT_BASE,
      HEAD,
    ]);
  });

  test('describeConflicts names the first paths and counts the rest', () => {
    expect(describeConflicts([])).toBe('');
    expect(describeConflicts(['a.ts', 'b.ts'])).toBe(' at a.ts, b.ts');
    expect(describeConflicts(['1', '2', '3', '4', '5', '6', '7'])).toBe(
      ' at 1, 2, 3, 4, 5 and 2 more',
    );
  });
});

describe('acceptMovedMain', () => {
  test('a clean merge lands, naming the commits merged onto', () => {
    expect(accept({ gained: [C1, C2] })).toEqual({ mergedIn: [C1, C2] });
  });

  test('main moving never asks for a new evidence run: no CI read, no plan, only Git', () => {
    const { git, calls } = repository({ gained: [C1] });
    acceptMovedMain(git, attested, HEAD, CURRENT_BASE, CURRENT_TREE);
    expect(calls.map((call) => call[0]).toSorted()).toEqual([
      'merge-base',
      'merge-tree',
      'merge-tree',
      'rev-list',
    ]);
  });

  test('a conflict is refused, naming the paths', () => {
    const result = accept({ conflicts: ['shared.txt', 'src/a.ts'], gained: [C1] });
    expect(result).toHaveProperty('problem');
    const { problem } = result as { problem: string };
    expect(problem).toContain('conflicts with main at shared.txt, src/a.ts');
    expect(problem).not.toContain('new evidence run');
  });

  test('a base that is not an ancestor is refused', () => {
    expect(accept({ ancestor: false })).toEqual({
      problem: expect.stringContaining(
        `the attested base ${ATTESTED_BASE.slice(0, 12)} is not an ancestor of main`,
      ),
    });
  });

  test('a head that no longer reproduces the attested tree is refused', () => {
    expect(accept({ reproduced: '9'.repeat(40) })).toEqual({
      problem: expect.stringContaining('does not give the attested tree'),
    });
  });

  test('a tree about to land that is not the clean merge is refused', () => {
    expect(accept({}, '7'.repeat(40))).toEqual({
      problem: expect.stringContaining('is not the head merged into main'),
    });
  });

  test('a main that gained nothing the head did not already hold still lands', () => {
    expect(accept({ gained: [] })).toEqual({ mergedIn: [] });
  });
});

describe('acceptMovedBase', () => {
  /** A runner over the fake Git: the command is `git ...args`, run in the worktree. */
  function runnerOver(spec: Repository): { runner: Runner; cwds: (string | undefined)[] } {
    const { git } = repository(spec);
    const cwds: (string | undefined)[] = [];
    const runner: Runner = (command, options) => {
      cwds.push(options?.cwd);
      return git(...command.slice(1));
    };
    return { runner, cwds };
  }
  const input = (runner: Runner) => ({
    runner,
    worktree: '/worktree',
    head: HEAD,
    base: CURRENT_BASE,
    tree: CURRENT_TREE,
    attested,
  });

  test('accepts a clean merge into a moved base, running Git in the worktree', () => {
    const { runner, cwds } = runnerOver({ gained: [C1] });
    expect(acceptMovedBase(input(runner))).toEqual({ mergedIn: [C1] });
    expect(new Set(cwds)).toEqual(new Set(['/worktree']));
  });

  test('refuses a conflict, naming the paths', () => {
    const { runner } = runnerOver({ conflicts: ['shared.txt'] });
    expect(acceptMovedBase(input(runner))).toEqual({
      problem: expect.stringContaining('conflicts with main at shared.txt'),
    });
  });

  test('refuses a base that is not an ancestor', () => {
    const { runner } = runnerOver({ ancestor: false });
    expect(acceptMovedBase(input(runner))).toEqual({
      problem: expect.stringContaining('is not an ancestor of main'),
    });
  });
});
