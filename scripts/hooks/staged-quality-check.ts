#!/usr/bin/env bun
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();

async function stagedFiles(): Promise<string[]> {
  const process = Bun.spawn(
    ['git', 'diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'],
    { cwd: root, stdout: 'pipe', stderr: 'inherit' },
  );
  if ((await process.exited) !== 0) throw new Error('Could not read staged files.');
  return (await new Response(process.stdout).text()).split('\0').filter(Boolean);
}

async function check(): Promise<void> {
  for (const file of await stagedFiles()) {
    if (!/\.(?:ts|tsx|js|jsx|json|md)$/u.test(file)) continue;
    const staged = Bun.spawn(['git', 'show', `:${file}`], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'inherit',
    });
    if ((await staged.exited) !== 0) throw new Error(`Could not read staged file: ${file}`);
    const contents = await new Response(staged.stdout).arrayBuffer();
    const prettier = Bun.spawn(['bun', 'run', 'prettier', '--check', '--stdin-filepath', file], {
      cwd: root,
      stdin: contents,
      stdout: 'inherit',
      stderr: 'inherit',
    });
    if ((await prettier.exited) !== 0) throw new Error(`Staged formatting check failed: ${file}`);
    if (/\.(?:ts|tsx|js|jsx)$/u.test(file)) {
      const oxlint = Bun.spawn(
        ['bun', 'run', 'oxlint', '--stdin', '--stdin-filename', path.resolve(root, file)],
        { cwd: root, stdin: contents, stdout: 'inherit', stderr: 'inherit' },
      );
      if ((await oxlint.exited) !== 0) throw new Error(`Staged lint check failed: ${file}`);
    }
  }
}

if (Bun.argv.includes('--self-test')) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'turbo-staged-quality-'));
  try {
    Bun.spawnSync(['git', 'init', '--quiet'], { cwd: temporaryRoot });
    await Bun.write(
      path.join(temporaryRoot, 'package.json'),
      JSON.stringify({
        type: 'module',
        scripts: {
          prettier: `node ${path.join(root, 'node_modules/prettier/bin/prettier.cjs')}`,
          oxlint: `node ${path.join(root, 'node_modules/oxlint/bin/oxlint')}`,
        },
      }),
    );
    const fixture = path.join(temporaryRoot, 'fixture.json');
    await Bun.write(fixture, '{"value":1}\n');
    Bun.spawnSync(['git', 'add', 'fixture.json'], { cwd: temporaryRoot });
    await Bun.write(fixture, '{\n  "value": 1\n}\n');
    const dirty = Bun.spawnSync([process.execPath, import.meta.path], {
      cwd: temporaryRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (dirty.success) throw new Error('Staged-unformatted content must fail.');
    Bun.spawnSync(['git', 'add', 'fixture.json'], { cwd: temporaryRoot });
    await Bun.write(fixture, '{\n  "value": 1\n}\n\n');
    const clean = Bun.spawnSync([process.execPath, import.meta.path], {
      cwd: temporaryRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (!clean.success) throw new Error('Worktree-only edits must not fail staged checks.');
    console.log('Staged quality self-test passed.');
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
} else {
  await check();
}
