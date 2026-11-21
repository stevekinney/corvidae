import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { outcomeOf, rethrow } from '../module-scope-scenario.test-support.ts';
import { acceptMovedBase, mergeHeadOnto } from './moved-base.ts';
import { defaultRunner, type Runner } from './process-runner.ts';

/**
 * The moved-base rule against real Git (owner decision, 2026-11-21): a head that merges into the
 * current `main` without a conflict lands, including when `main` and the head edited the same file
 * at different places, and a conflict is refused with its paths. The fake-Git unit tests cannot say
 * what Git calls a conflict.
 */

const isolated: Runner = (command, options) =>
  defaultRunner(command, {
    ...options,
    env: {
      ...options?.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
  });

const scratch: string[] = [];
afterAll(() => {
  for (const directory of scratch) rmSync(directory, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const result = isolated(['git', ...args], { cwd });
  if (result.code !== 0)
    throw new Error(`git ${args.join(' ')} failed (${result.code}): ${result.stderr}`);
  return result.stdout.trim();
}

function commit(cwd: string, file: string, content: string, message: string): string {
  writeFileSync(join(cwd, file), content);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

/**
 * A repository whose `main` holds `shared.txt` and a non-ASCII file, a `head` branch that edits line
 * one of `shared.txt` (and the non-ASCII file when `headTouchesQuoted`), and the attested identity
 * taken before `main` moved.
 */
function world(headTouchesQuoted = false) {
  const directory = mkdtempSync(join(tmpdir(), 'moved-base-'));
  scratch.push(directory);
  git(directory, 'init', '-q', '-b', 'main');
  git(directory, 'config', 'user.name', 'Test Author');
  git(directory, 'config', 'user.email', 'author@example.test');
  git(directory, 'config', 'commit.gpgsign', 'false');
  commit(directory, 'naïve.txt', 'one\n', 'Base, with a path Git quotes');
  const attestedBase = commit(directory, 'shared.txt', 'one\ntwo\nthree\n', 'Base');
  git(directory, 'checkout', '-q', '-b', 'head');
  if (headTouchesQuoted) commit(directory, 'naïve.txt', 'head\n', 'Head edits the quoted path');
  const head = commit(directory, 'shared.txt', 'head\ntwo\nthree\n', 'Head edits line one');
  git(directory, 'checkout', '-q', 'main');
  const attested = {
    base: attestedBase,
    tree: (
      mergeHeadOnto(
        (...args) => isolated(['git', ...args], { cwd: directory }),
        attestedBase,
        head,
      ) as {
        tree: string;
      }
    ).tree,
  };
  const input = (base: string) => {
    const merged = mergeHeadOnto(
      (...args) => isolated(['git', ...args], { cwd: directory }),
      base,
      head,
    );
    return {
      runner: isolated,
      worktree: directory,
      head,
      base,
      tree: 'tree' in merged ? merged.tree : '0'.repeat(40),
      attested,
    };
  };
  return { directory, attested, input };
}

// Each scenario starts processes, so it runs once at module scope, where no per-test clock applies,
// and its test rethrows what it recorded.
const sameFileWithoutConflict = await outcomeOf(async () => {
  const w = world();
  const first = commit(w.directory, 'shared.txt', 'one\ntwo\nmain\n', 'Main edits line three');
  const second = commit(w.directory, 'other.txt', 'other\n', 'Main adds a file');
  expect(acceptMovedBase(w.input(second))).toEqual({ mergedIn: [first, second] });
});

const conflictNamesPaths = await outcomeOf(async () => {
  const w = world(true);
  writeFileSync(join(w.directory, 'naïve.txt'), 'main\n');
  git(w.directory, 'add', 'naïve.txt');
  git(w.directory, 'commit', '-q', '-m', 'Main edits the quoted path');
  const base = commit(w.directory, 'shared.txt', 'main\ntwo\nthree\n', 'Main edits line one');
  const refused = acceptMovedBase(w.input(base));
  expect(refused).toHaveProperty('problem');
  const { problem } = refused as { problem: string };
  expect(problem).toContain('conflicts with main at naïve.txt, shared.txt');
});

const notAnAncestor = await outcomeOf(async () => {
  const w = world();
  // A root commit holding main's tree: the history was rewritten, so no old commit is its ancestor.
  const base = git(
    w.directory,
    'commit-tree',
    git(w.directory, 'rev-parse', 'main^{tree}'),
    '-m',
    'Rewritten main',
  );
  expect(acceptMovedBase(w.input(base))).toEqual({
    problem: expect.stringContaining('is not an ancestor of main'),
  });
});

describe('acceptMovedBase against real Git', () => {
  test('lands when main and the head edited the same file at different lines', () => {
    rethrow(sameFileWithoutConflict);
  });

  test('refuses a conflict, naming the path, and a non-ASCII path verbatim', () => {
    rethrow(conflictNamesPaths);
  });

  test('refuses a main the attested base is not an ancestor of', () => {
    rethrow(notAnAncestor);
  });
});
