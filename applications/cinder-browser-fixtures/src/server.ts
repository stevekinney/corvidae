import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { Connect, Plugin, PreviewServer, ViteDevServer } from 'vite';

import { readManifest } from './manifest.ts';
import { resolveFixtureRequest } from './route-contract.ts';

function send(
  response: FixtureResponse,
  status: number,
  body: string,
  contentType = 'text/plain; charset=utf-8',
): void {
  response.statusCode = status;
  response.setHeader('content-type', contentType);
  response.end(body);
}

type RenderPage = (url: string) => Promise<string>;
type FixtureEndpoint = 'ready' | 'manifest' | 'page';
type FixtureRequest = Pick<Connect.IncomingMessage, 'url'>;
type FixtureResponse = {
  statusCode: number;
  setHeader: (name: string, value: string) => void;
  end: (body: string) => void;
};

function endpointFor(pathname: string): FixtureEndpoint | undefined {
  if (pathname === '/ready') return 'ready';
  if (pathname === '/api/manifest') return 'manifest';
  if (pathname.startsWith('/page/')) return 'page';
  return undefined;
}

function decodeComponent(url: URL): string | undefined {
  try {
    return decodeURIComponent(url.pathname.slice('/page/'.length));
  } catch {
    return undefined;
  }
}

async function respondToEndpoint(
  endpoint: FixtureEndpoint,
  url: URL,
  requestUrl: string,
  response: FixtureResponse,
  manifestPathValue: string,
  renderPage: RenderPage,
): Promise<void> {
  const manifest = readManifest(manifestPathValue);
  if (endpoint === 'ready') {
    send(response, 200, 'ready');
    return;
  }
  if (endpoint === 'manifest') {
    send(response, 200, JSON.stringify(manifest), 'application/json; charset=utf-8');
    return;
  }
  const component = decodeComponent(url);
  if (component === undefined) {
    send(response, 400, 'Invalid component URI.');
    return;
  }
  const result = resolveFixtureRequest(
    manifest.entries,
    component,
    url.searchParams.get('fixture'),
    url.searchParams.get('fixtureContentHash'),
  );
  if ('status' in result) {
    send(response, result.status, result.message);
    return;
  }
  const html = await renderPage(requestUrl);
  send(
    response,
    200,
    html.replace(
      '<html lang="en">',
      `<html lang="en"${url.searchParams.get('snapshot') === '1' ? ' data-snapshot-mode=""' : ''}>`,
    ),
    'text/html; charset=utf-8',
  );
}

export async function handleFixtureRequest(
  request: FixtureRequest,
  response: FixtureResponse,
  next: Connect.NextFunction,
  manifestPath: string,
  renderPage: RenderPage,
): Promise<void> {
  let url: URL;
  try {
    url = new URL(request.url ?? '/', 'http://localhost');
  } catch {
    send(response, 400, 'Invalid request URI.');
    return;
  }
  const endpoint = endpointFor(url.pathname);
  if (endpoint === undefined) {
    next();
    return;
  }
  if (endpoint === 'page' && decodeComponent(url) === undefined) {
    send(response, 400, 'Invalid component URI.');
    return;
  }
  try {
    await respondToEndpoint(endpoint, url, request.url ?? '/', response, manifestPath, renderPage);
  } catch (error) {
    next(error);
  }
}

export function fixtureHostPlugin(): Plugin {
  return {
    name: 'cinder-browser-fixtures-host',
    configureServer(server: ViteDevServer) {
      server.middlewares.use((request, response, next) =>
        handleFixtureRequest(request, response, next, developmentManifestPath(), async (url) =>
          server.transformIndexHtml(
            url,
            await readFile(resolve(server.config.root, 'index.html'), 'utf8'),
          ),
        ),
      );
    },
    configurePreviewServer(server: PreviewServer) {
      server.middlewares.use((request, response, next) =>
        handleFixtureRequest(
          request,
          response,
          next,
          resolve(server.config.root, server.config.build.outDir, '.playwright', 'manifest.json'),
          () =>
            readFile(resolve(server.config.root, server.config.build.outDir, 'index.html'), 'utf8'),
        ),
      );
    },
  };
}

function developmentManifestPath(): string {
  return resolve(import.meta.dirname, '..', '.playwright', 'manifest.json');
}
