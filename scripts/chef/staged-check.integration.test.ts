import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
let invalidSeen = '';
let referenceMatches = false;
let indexMatches = false;
let deletedGuards = false;
try {
  git('init');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.test');
  writeFileSync(join(directory, 'package.json'), '{"name":"fixture","workspaces":[]}\n');
  mkdirSync(join(directory, 'nested'));
  writeFileSync(join(directory, 'nested', 'example.ts'), 'valid\n');
  git('add', '.');
  git('commit', '-m', 'fixture');
  const base = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', base);
  writeFileSync(join(directory, '.gitattributes'), '* export-ignore export-subst\n');
  writeFileSync(join(directory, 'nested', '.gitattributes'), '* export-ignore export-subst\n');
  writeFileSync(join(directory, 'nested', 'example.ts'), 'invalid $Format:%H$\n');
  git('add', '.gitattributes', 'nested');
  writeFileSync(join(directory, 'nested', 'example.ts'), 'valid unstaged\n');
  const beforeIndex = readFileSync(join(directory, '.git', 'index'));
  const beforeWorktree = readFileSync(join(directory, 'nested', 'example.ts'));
  const runner: Runner = (command, options) => {
    if (command[0] === 'bun' && command[1] === 'install')
      return { code: 0, stdout: '', stderr: '' };
    if (command[0] === 'bun' && command[1] === 'run') return { code: 0, stdout: '', stderr: '' };
    if (command[0] === 'bun' && command[1] === 'scripts/guard-wiring.ts')
      return { code: 0, stdout: '', stderr: '' };
    if (command[0] === 'bunx') {
      seen = readFileSync(join(options!.cwd!, 'nested', 'example.ts'), 'utf8');
      referenceMatches =
        defaultRunner(['git', 'rev-parse', 'origin/main'], options).stdout.trim() === base;
      indexMatches = defaultRunner(['git', 'show', ':nested/example.ts'], options).stdout === seen;
      return { code: seen.startsWith('invalid') ? 1 : 0, stdout: '', stderr: '' };
    }
    return defaultRunner(command, options);
  };
  invalidResult = stagedCheck(directory, runner);
  invalidSeen = seen;
  unchangedIndex = beforeIndex.equals(readFileSync(join(directory, '.git', 'index')));
  unchangedWorktree = beforeWorktree.equals(readFileSync(join(directory, 'nested', 'example.ts')));
  writeFileSync(join(directory, 'nested', 'example.ts'), 'clean staged\n');
  git('add', 'nested/example.ts');
  cleanResult = stagedCheck(directory, runner);
  git('reset', 'HEAD', '--', '.gitattributes', 'nested/.gitattributes');
  git('rm', '-f', 'nested/example.ts');
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
  expect(invalidSeen).toBe('invalid $Format:%H$\n');
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
