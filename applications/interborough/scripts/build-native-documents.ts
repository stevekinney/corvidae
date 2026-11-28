import { buildProduction } from '@lostgradient/velveteen/build';
import { createApplication } from '@lostgradient/velveteen/server';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { routes, velveteenRouteId } from '../src/app/routes.ts';
import { nativeDocumentPath } from '../src/host/native-document-path.ts';
import { curatedShikiPlugin } from './browser-build.ts';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));

/** The existing App reads the runtime configuration before mounting its shell. */
const NATIVE_DOCUMENT_TEMPLATE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Interborough</title>
    %sveltekit.head%
  </head>
  <body>
    <script type="application/json" id="weft-ui-config">
      { "baseUrl": "", "eventTransport": "auto" }
    </script>
    %sveltekit.body%
  </body>
</html>`;

/** Build the opt-in document graph from the live app registry, outside the tracked route tree. */
export async function buildNativeDocuments(outputDirectory: string) {
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
    for (const { pattern } of routes) {
      const directory = join(routesDirectory, velveteenRouteId(pattern).slice(1));
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
      browserPlugins: [curatedShikiPlugin],
    });
  } finally {
    await rm(routesDirectory, { force: true, recursive: true });
  }
}

/** Open the generated document graph without taking over the listener or its authority. */
export function openNativeDocuments(
  generation: Parameters<typeof createApplication>[0]['generation'],
) {
  return createApplication({
    generation,
    template: NATIVE_DOCUMENT_TEMPLATE,
    hooks: { reroute: ({ url }) => nativeDocumentPath(url) },
  });
}
