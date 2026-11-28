import { buildProduction } from '@lostgradient/velveteen/build';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { routes, velveteenRouteId } from '../src/app/routes.ts';
import { UNOWNED_DOCUMENT_ROUTE } from '../src/host/native-document-path.ts';
import { curatedShikiPlugin, wasmPlugin } from './browser-build.ts';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));

/** Build the native document graph from the live app registry, outside the tracked route tree. */
export async function buildNativeDocuments(
  outputDirectory: string,
  options: Pick<Parameters<typeof buildProduction>[0], 'mode' | 'onBuildMetadata'> = {},
) {
  const scratch = join(projectDirectory, '.cache');
  await mkdir(scratch, { recursive: true });
  const routesDirectory = await mkdtemp(join(scratch, 'native-documents-'));
  try {
    const nativeDocument = join(projectDirectory, 'src/app/native-document.svelte');
    await Bun.write(
      join(routesDirectory, '+layout.svelte'),
      `<script lang="ts">import NativeDocument from ${JSON.stringify(nativeDocument)};</script>\n<NativeDocument />\n`,
    );
    await Bun.write(join(routesDirectory, '+layout.server.ts'), 'export const ssr = false;\n');
    const routeIds = routes.map(({ pattern }) => velveteenRouteId(pattern));
    for (const routeId of [...routeIds, UNOWNED_DOCUMENT_ROUTE]) {
      const directory = join(routesDirectory, routeId.slice(1));
      await mkdir(directory, { recursive: true });
      await Bun.write(
        join(directory, '+page.svelte'),
        '<!-- The application layout renders the view selected by this native route. -->\n',
      );
    }
    return await buildProduction({
      projectDirectory,
      routesDirectory,
      outputDirectory,
      ...options,
      browserConditions: ['unwasm'],
      browserPlugins: [wasmPlugin, curatedShikiPlugin],
    });
  } finally {
    await rm(routesDirectory, { force: true, recursive: true });
  }
}
