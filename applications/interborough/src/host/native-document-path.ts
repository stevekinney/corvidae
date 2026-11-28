import { readProductionGeneration } from '@lostgradient/velveteen/build/publication';
import { createApplication } from '@lostgradient/velveteen/server';
import { join } from 'node:path';

import { displayedCommit, publishedBrowserBuildDirectory, readBuildInfo } from './build-info.ts';
import { injectDevReloadClient } from './dev-reload.ts';

export const NATIVE_DOCUMENT_DIRECTORY = 'documents';
export const UNOWNED_DOCUMENT_ROUTE = '/[...unowned]';

const unownedPath = '/__unowned-interborough-document';

/** Preserve Interborough's literal static segments and existing nonempty plugin paths. */
function nativeDocumentPath(url: URL): string {
  const pathname = url.pathname.replace(/\/{2,}/g, '/');
  try {
    decodeURIComponent(pathname);
  } catch {
    return unownedPath;
  }
  if (/^\/plugins\/[^/]+\/?$/.test(pathname)) return unownedPath;
  // Velveteen normally decodes before picking a route. Keep escapes until it has picked one so an
  // encoded dynamic identifier cannot become a literal static segment such as "new".
  return pathname.replaceAll('%', '%25');
}

/** The existing App reads the runtime configuration before mounting its shell. */
function documentTemplate(buildLabel: string) {
  const configuration = JSON.stringify({
    baseUrl: '',
    eventTransport: 'auto',
    buildCommit: buildLabel,
  }).replaceAll('<', '\\u003c');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Interborough</title>
    %sveltekit.head%
  </head>
  <body>
    <script type="application/json" id="weft-ui-config">
      ${configuration}
    </script>
    %sveltekit.body%
  </body>
</html>`;
}

/** Open the generated document graph without taking over the listener or its authority. */
export function openNativeDocuments(
  generation: Parameters<typeof createApplication>[0]['generation'],
  development = false,
  buildLabel = '',
) {
  const template = documentTemplate(buildLabel);
  return createApplication({
    generation,
    template: development ? injectDevReloadClient(template) : template,
    hooks: {
      reroute: ({ url }) => nativeDocumentPath(url),
      async handle({ event, resolve }) {
        // Velveteen already checked published assets before invoking document hooks.
        const { pathname } = event.url;
        if (pathname === '/_assets' || pathname.startsWith('/_assets/')) {
          return new Response('Not found', { status: 404 });
        }
        const response = await resolve(event);
        if (
          event.route.id !== UNOWNED_DOCUMENT_ROUTE ||
          response.status !== 200 ||
          !response.headers.get('content-type')?.startsWith('text/html')
        )
          return response;
        return new Response(response.body, { status: 404, headers: response.headers });
      },
    },
  });
}

/** Open the published native graph from this build. Never fall back to a shell document. */
export async function openPublishedNativeDocuments(buildDirectory: string, development = false) {
  const generation = await readProductionGeneration(
    join(buildDirectory, NATIVE_DOCUMENT_DIRECTORY),
  );
  const source = readBuildInfo(buildDirectory);
  return openNativeDocuments(
    generation,
    development,
    source === undefined ? '' : displayedCommit(source),
  );
}

/** Follow completed publications in the development process without interrupting in-flight pages. */
export async function openDevelopmentNativeDocuments(buildDirectory: string) {
  const read = () => {
    const current = publishedBrowserBuildDirectory(buildDirectory);
    if (current === undefined) throw new Error('Published browser generation is missing');
    return current;
  };
  let directory = read();
  let active = await openPublishedNativeDocuments(directory, true);
  let previousAssets: (typeof active)['routes'] = {};
  const retiring = new Map<typeof active, Promise<unknown>>();
  const failures: unknown[] = [];
  let closed = false;

  return {
    async fetch(request: Request) {
      const { pathname } = new URL(request.url);
      if (
        (request.method === 'GET' || request.method === 'HEAD') &&
        !Object.hasOwn(active.routes, pathname)
      ) {
        const previousAsset = Object.hasOwn(previousAssets, pathname)
          ? previousAssets[pathname]
          : undefined;
        if (previousAsset) return previousAsset(request);
      }
      return active.fetch(request);
    },
    async refresh() {
      if (closed) return;
      if (failures.length) throw new AggregateError(failures, 'Document retirement failed');
      const nextDirectory = read();
      if (nextDirectory === directory) return;
      const next = await openPublishedNativeDocuments(nextDirectory, true);
      if (closed) {
        await next.dispose();
        return;
      }
      const previous = active;
      active = next;
      // A tab finishing navigation after the swap can still request the preceding hashed chunks.
      previousAssets = previous.routes;
      directory = nextDirectory;
      const finished = previous
        .retire()
        .then(() => previous.dispose())
        .catch((error: unknown) => failures.push(error))
        .then(() => {
          return retiring.delete(previous);
        });
      retiring.set(previous, finished);
    },
    async dispose() {
      closed = true;
      await active.dispose();
      await Promise.all([...retiring.keys()].map((application) => application.dispose()));
      await Promise.all(retiring.values());
      if (failures.length) throw new AggregateError(failures, 'Document retirement failed');
    },
  };
}
