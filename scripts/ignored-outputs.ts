import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ignoredTemplatePaths = [
  'dist',
  '.turbo',
  'coverage',
  '.env',
  '.claude/settings.local.json',
] as const;

export async function scrubCreatedTemplateStateOnce(projectRoot: string): Promise<void> {
  const marker = path.join(projectRoot, '.bun-create-scrubbed');
  if (await Bun.file(marker).exists()) return;
  for (const relativePath of ignoredTemplatePaths) {
    await rm(path.join(projectRoot, relativePath), { recursive: true, force: true });
  }
  for (const entry of await readdir(projectRoot)) {
    if (entry.startsWith('.env.') && entry !== '.env.example') {
      await rm(path.join(projectRoot, entry), { recursive: true, force: true });
    }
  }
  await Bun.write(marker, 'create-only state scrubbed\n');
}

if (import.meta.main && Bun.argv.includes('--self-test')) {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'turbo-clean-retry-'));
  try {
    await mkdir(path.join(fixture, 'dist'), { recursive: true });
    await Bun.write(path.join(fixture, 'dist', 'stale.txt'), 'remove');
    await Bun.write(path.join(fixture, '.env.production.local'), 'remove');
    await Bun.write(path.join(fixture, '.env.example'), 'keep');
    await scrubCreatedTemplateStateOnce(fixture);
    if (await Bun.file(path.join(fixture, 'dist', 'stale.txt')).exists())
      throw new Error('Initial destination cleanup retained generated output.');
    if (await Bun.file(path.join(fixture, '.env.production.local')).exists())
      throw new Error('Initial destination cleanup retained a private environment file.');
    if (!(await Bun.file(path.join(fixture, '.env.example')).exists()))
      throw new Error('Initial destination cleanup removed .env.example.');
    await mkdir(path.join(fixture, 'dist'), { recursive: true });
    await Bun.write(path.join(fixture, 'dist', 'created.txt'), 'keep');
    await scrubCreatedTemplateStateOnce(fixture);
    if (!(await Bun.file(path.join(fixture, 'dist', 'created.txt')).exists()))
      throw new Error('Retry cleanup deleted newly created output.');
    console.log('Destination cleanup retry self-test passed.');
  } finally {
    await rm(fixture, { force: true, recursive: true });
  }
}
