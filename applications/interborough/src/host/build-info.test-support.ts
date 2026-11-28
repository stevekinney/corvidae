import { buildProduction } from '@lostgradient/velveteen/build';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import {
  BROWSER_BUILD_GENERATIONS,
  BUILD_INFO_FILE,
  UNKNOWN_COMMIT,
  type BuildInfo,
} from './build-info.ts';
import { NATIVE_DOCUMENT_DIRECTORY } from './native-document-path.ts';

/** Minimal publication record for a supervisor test that substitutes its own child entry. */
export function stubBrowserPublication(
  root: string,
  source: BuildInfo = { commit: UNKNOWN_COMMIT, changes: '' },
): string {
  const generation = crypto.randomUUID();
  const published = join(root, BROWSER_BUILD_GENERATIONS, generation);
  mkdirSync(published, { recursive: true });
  writeFileSync(join(root, BUILD_INFO_FILE), JSON.stringify({ ...source, generation }));
  return published;
}

/** Build only a few documents when a process test needs the real dispatcher. */
export async function buildTestDocuments(root: string, source?: BuildInfo): Promise<string> {
  const project = join(import.meta.dir, '../..');
  const cache = join(project, '.cache');
  await mkdir(cache, { recursive: true });
  const scratch = await mkdtemp(join(cache, 'test-documents-'));
  try {
    for (const route of ['', 'chats', 'runs/[run]']) {
      const directory = join(scratch, route);
      await mkdir(directory, { recursive: true });
      await Bun.write(join(directory, '+page.svelte'), '<main>Native test document</main>');
    }
    const published = stubBrowserPublication(root, source);
    await buildProduction({
      projectDirectory: project,
      routesDirectory: scratch,
      outputDirectory: join(published, NATIVE_DOCUMENT_DIRECTORY),
    });
    return published;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
