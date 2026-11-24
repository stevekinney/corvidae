#!/usr/bin/env bun
// Check a snapshot of the index without changing the index or the working tree.
// Usage: bun scripts/chef/staged-check.ts

import { copyFileSync, existsSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { discoverWorkspaces } from '../affected-tests.ts';
import { defaultRunner, type Runner } from './process-runner.ts';

function required(
  runner: Runner,
  command: string[],
  cwd: string,
  env?: Record<string, string>,
): string {
  const result = runner(command, { cwd, env });
  if (result.code !== 0) throw new Error(`${command.join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

/** Chef production files reach these three source guards; tests and other paths use the full set. */
export function contractChecks(changed: readonly string[]): string[][] {
  const ordinaryChefSource = (path: string) =>
    /^scripts\/chef\/.*\.tsx?$/.test(path) &&
    !/(?:^|\/)(?:test|tests|testing|__tests__|fixtures)\//.test(path) &&
    !/\.(?:test|spec|bench|playwright|test-support)\.tsx?$/.test(path);
  if (changed.every(ordinaryChefSource))
    return [
      ['bun', 'scripts/check-combined-signal-listeners.ts'],
      ['bun', 'scripts/check-gh-run-watch.ts'],
      ['bun', 'scripts/check-workflow-dispatch.ts'],
    ];
  return [
    ['bun', 'run', 'lint:guards'],
    ['bun', 'scripts/guard-wiring.ts'],
  ];
}

export function stagedCheck(root: string, runner: Runner = defaultRunner): number {
  const directory = mkdtempSync(join(tmpdir(), 'corvidae-staged-'));
  try {
    const gitDirectory = required(runner, ['git', 'rev-parse', '--absolute-git-dir'], root).trim();
    const archive = join(directory, 'tree.tar');
    const archiveRepository = join(directory, 'archive.git');
    const index = join(directory, 'index');
    const snapshot = join(directory, 'tree');
    const originalIndex = required(
      runner,
      ['git', 'rev-parse', '--git-path', 'index'],
      root,
    ).trim();
    copyFileSync(resolve(root, originalIndex), index);
    const tree = required(runner, ['git', 'write-tree'], root, { GIT_INDEX_FILE: index }).trim();
    const environment = { GIT_DIR: gitDirectory, GIT_WORK_TREE: snapshot, GIT_INDEX_FILE: index };
    required(runner, ['mkdir', snapshot], root);
    const objects = required(
      runner,
      ['git', 'rev-parse', '--path-format=absolute', '--git-path', 'objects'],
      root,
    ).trim();
    const objectFormat = required(
      runner,
      ['git', 'rev-parse', '--show-object-format'],
      root,
    ).trim();
    required(
      runner,
      ['git', 'init', '--bare', '--quiet', `--object-format=${objectFormat}`, archiveRepository],
      root,
    );
    writeFileSync(join(archiveRepository, 'objects', 'info', 'alternates'), `${objects}\n`);
    writeFileSync(
      join(archiveRepository, 'info', 'attributes'),
      '* -export-ignore -export-subst\n',
    );
    required(
      runner,
      [
        'git',
        '-c',
        'core.attributesFile=/dev/null',
        'archive',
        '--format=tar',
        `--output=${archive}`,
        tree,
      ],
      root,
      { GIT_DIR: archiveRepository },
    );
    required(runner, ['tar', '-xf', archive, '-C', snapshot], root);
    writeFileSync(join(snapshot, '.git'), `gitdir: ${gitDirectory}\n`);
    required(runner, ['git', 'read-tree', tree], snapshot, environment);
    const changed = required(
      runner,
      ['git', 'diff', '--cached', '--name-only', '-z', '--no-renames'],
      snapshot,
      environment,
    )
      .split('\0')
      .filter(Boolean);
    if (changed.length === 0) return 0;
    const install = runner(['bun', 'install', '--frozen-lockfile'], {
      cwd: snapshot,
      env: environment,
    });
    if (install.code !== 0) {
      process.stderr.write(install.stderr + install.stdout);
      return install.code;
    }
    const readable = changed.filter(
      (path) =>
        existsSync(join(snapshot, path)) && !lstatSync(join(snapshot, path)).isSymbolicLink(),
    );
    const checks = contractChecks(changed);
    if (readable.length > 0)
      checks.unshift(['bunx', 'prettier', '--check', '--ignore-unknown', '--', ...readable]);
    const scripts = readable.filter(
      (path) => path.startsWith('scripts/') && /\.[cm]?[jt]sx?$/.test(path),
    );
    if (scripts.length > 0)
      checks.push([
        'bunx',
        'oxlint',
        '--deny-warnings',
        '--type-aware',
        '--tsconfig',
        './tsconfig.json',
        ...scripts,
      ]);
    const workspaces = discoverWorkspaces(snapshot).filter((workspace) =>
      changed.some((path) => path.startsWith(`${workspace.directory}/`)),
    );
    if (workspaces.length > 0)
      checks.push([
        'bunx',
        'turbo',
        'run',
        'lint',
        ...workspaces.map((workspace) => `--filter=${workspace.name}`),
      ]);
    let failed = false;
    for (const command of checks) {
      const result = runner(command, { cwd: snapshot, env: environment });
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      if (result.code !== 0) failed = true;
    }
    return failed ? 1 : 0;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    process.exitCode = stagedCheck(resolve('.'));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
// gh run watch
