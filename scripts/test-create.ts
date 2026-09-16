#!/usr/bin/env bun
import { cp, lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const sourceRoot = path.resolve(import.meta.dir, '..');
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'turbo-create-smoke-'));
const createRoot = path.join(temporaryRoot, '.bun-create');
const templateRoot = path.join(createRoot, 'turbo');
const applicationRoot = path.join(temporaryRoot, 'generated');
async function exists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch {
    return false;
  }
}
try {
  await cp(sourceRoot, templateRoot, {
    recursive: true,
    filter: (source) => !source.includes('/node_modules/'),
  });
  for (const relativePath of [
    'dist/sentinel',
    '.turbo/sentinel',
    'coverage/sentinel',
    '.env',
    '.env.production.local',
    '.claude/settings.local.json',
  ]) {
    const target = path.join(templateRoot, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await Bun.write(target, 'must not reach generated project\n');
  }
  await Bun.write(path.join(templateRoot, '.env.example'), 'EXAMPLE_VALUE=\n');
  const child = Bun.spawn(['bun', 'create', 'turbo', applicationRoot], {
    cwd: temporaryRoot,
    env: { ...Bun.env, HOME: temporaryRoot, BUN_CREATE_DIR: createRoot, CI: '1' },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if ((await child.exited) !== 0) throw new Error('bun create turbo failed.');
  for (const relativePath of [
    'dist',
    '.turbo',
    'coverage',
    '.env',
    '.env.production.local',
    '.claude/settings.local.json',
  ]) {
    if (await exists(path.join(applicationRoot, relativePath)))
      throw new Error(`Generated project copied create-only state: ${relativePath}`);
  }
  if (!(await exists(path.join(applicationRoot, '.env.example'))))
    throw new Error('Generated project did not retain .env.example.');
  const generated = (await Bun.file(path.join(applicationRoot, 'package.json')).json()) as {
    packageManager?: string;
    'bun-create'?: unknown;
  };
  if (generated['bun-create'] !== undefined)
    throw new Error('Generated project retained bun-create metadata.');
  if (generated.packageManager !== `bun@${Bun.version}`)
    throw new Error(
      `Generated project packageManager is ${generated.packageManager}, expected bun@${Bun.version}.`,
    );
  console.log('Fresh-create contamination and package metadata smoke passed.');
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
