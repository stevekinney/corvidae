import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultRunner, type Runner } from './process-runner.ts';
import { contractChecks, stagedCheck } from './staged-check.ts';

const directory = mkdtempSync(join(tmpdir(), 'staged-check-test-'));
const git = (...argumentsList: string[]) => {
  const result = defaultRunner(['git', ...argumentsList], { cwd: directory });
  if (result.code !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};
let invalidResult = 0;
let cleanResult = 1;
let unchangedIndex = false;
let unchangedWorktree = false;
let seen = '';
let referenceMatches = false;
let indexMatches = false;
let deletedGuards = false;
try {
  git('init');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.test');
  writeFileSync(join(directory, 'package.json'), '{"name":"fixture","workspaces":[]}\n');
  writeFileSync(join(directory, 'example.ts'), 'valid\n');
  git('add', '.');
  git('commit', '-m', 'fixture');
  const base = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', base);
  writeFileSync(join(directory, 'example.ts'), 'invalid\n');
  git('add', 'example.ts');
  writeFileSync(join(directory, 'example.ts'), 'valid unstaged\n');
  const beforeIndex = readFileSync(join(directory, '.git', 'index'));
  const beforeWorktree = readFileSync(join(directory, 'example.ts'));
  const runner: Runner = (command, options) => {
    if (command[0] === 'bun' && command[1] === 'install')
      return { code: 0, stdout: '', stderr: '' };
    if (command[0] === 'bun' && command[1] === 'run') return { code: 0, stdout: '', stderr: '' };
    if (command[0] === 'bun' && command[1] === 'scripts/guard-wiring.ts')
      return { code: 0, stdout: '', stderr: '' };
    if (command[0] === 'bunx') {
      seen = readFileSync(join(options!.cwd!, 'example.ts'), 'utf8');
      referenceMatches =
        defaultRunner(['git', 'rev-parse', 'origin/main'], options).stdout.trim() === base;
      indexMatches = defaultRunner(['git', 'show', ':example.ts'], options).stdout === seen;
      return { code: seen === 'invalid\n' ? 1 : 0, stdout: '', stderr: '' };
    }
    return defaultRunner(command, options);
  };
  invalidResult = stagedCheck(directory, runner);
  unchangedIndex = beforeIndex.equals(readFileSync(join(directory, '.git', 'index')));
  unchangedWorktree = beforeWorktree.equals(readFileSync(join(directory, 'example.ts')));
  writeFileSync(join(directory, 'example.ts'), 'clean staged\n');
  git('add', 'example.ts');
  cleanResult = stagedCheck(directory, runner);
  git('rm', '-f', 'example.ts');
  const deleteRunner: Runner = (command, options) => {
    if (command[0] === 'bun' && command[1] === 'run') deletedGuards = true;
    return runner(command, options);
  };
  stagedCheck(directory, deleteRunner);
} finally {
  rmSync(directory, { recursive: true, force: true });
}

test('checks the captured index, leaving the index and unstaged bytes untouched', () => {
  expect(invalidResult).toBe(1);
  expect(unchangedIndex).toBe(true);
  expect(unchangedWorktree).toBe(true);
  expect(cleanResult).toBe(0);
  expect(seen).toBe('clean staged\n');
  expect(referenceMatches).toBe(true);
  expect(indexMatches).toBe(true);
  expect(deletedGuards).toBe(true);
});

test('selects the production Chef guards and keeps the full suite for other changes', () => {
  expect(contractChecks(['scripts/chef/example.ts'])).toEqual([
    ['bun', 'scripts/check-combined-signal-listeners.ts'],
    ['bun', 'scripts/check-gh-run-watch.ts'],
    ['bun', 'scripts/check-workflow-dispatch.ts'],
  ]);
  expect(contractChecks(['scripts/chef/example.test.ts'])).toContainEqual([
    'bun',
    'run',
    'lint:guards',
  ]);
  expect(contractChecks(['scripts/chef/example.ts', 'package.json'])).toContainEqual([
    'bun',
    'run',
    'lint:guards',
  ]);
});
