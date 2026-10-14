/**
 * A static host for the exported Playground that behaves like the Vercel project serving it.
 *
 * It serves one directory and nothing else: no development server, no compiler. Routing comes
 * from `applications/playground/vercel.json`, read at startup rather than copied, so a change to
 * the deployed `cleanUrls`, `rewrites`, `redirects`, or `headers` changes what the gate checks.
 * Vercel's order applies: redirects first, then the filesystem (with clean URLs), then rewrites,
 * and a path that matches no file is a 404 (the export writes no `404.html`). Configured headers
 * apply to every matching response, including redirects and 404s.
 *
 * `scripts/check-static-playground.ts` runs this as its own child process, so the server's death
 * is a real event the runner must notice:
 *
 *   bun scripts/static-playground-server.ts --directory build --port-file <file>
 */
import { realpathSync, statSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';

const PLAYGROUND_ROOT = join(import.meta.dirname, '..');
export const VERCEL_CONFIGURATION_PATH = join(PLAYGROUND_ROOT, 'vercel.json');

type HeaderPair = { key: string; value: string };
type HeaderRule = { source: string; headers: HeaderPair[] };
type RedirectRule = { source: string; destination: string; statusCode: number };
type RewriteRule = { source: string; destination: string };

export type StaticHostConfiguration = {
  cleanUrls: boolean;
  rewrites: RewriteRule[];
  redirects: RedirectRule[];
  headers: HeaderRule[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(rule: Record<string, unknown>, field: string, owner: string): string {
  const value = rule[field];
  if (typeof value !== 'string' || !value.startsWith('/')) {
    throw new Error(`[static-playground] vercel.json ${owner}.${field} must be a path`);
  }
  return value;
}

function listField(configuration: Record<string, unknown>, field: string): unknown[] {
  const value = configuration[field] ?? [];
  if (!Array.isArray(value))
    throw new Error(`[static-playground] vercel.json ${field} is not a list`);
  return value;
}

/** Read the routing half of a `vercel.json` value, rejecting any shape this host cannot honor. */
export function parseStaticHostConfiguration(value: unknown): StaticHostConfiguration {
  if (!isRecord(value)) throw new Error('[static-playground] vercel.json must contain an object');
  const records = (field: string) =>
    listField(value, field).map((rule) => {
      if (!isRecord(rule)) throw new Error(`[static-playground] vercel.json ${field} entry`);
      return rule;
    });
  return {
    cleanUrls: value['cleanUrls'] === true,
    rewrites: records('rewrites').map((rule) => ({
      source: stringField(rule, 'source', 'rewrites'),
      destination: stringField(rule, 'destination', 'rewrites'),
    })),
    redirects: records('redirects').map((rule) => {
      const statusCode = rule['statusCode'] ?? (rule['permanent'] === false ? 307 : 308);
      if (typeof statusCode !== 'number' || statusCode < 300 || statusCode > 399) {
        throw new Error('[static-playground] vercel.json redirects.statusCode must be 3xx');
      }
      return {
        source: stringField(rule, 'source', 'redirects'),
        destination: stringField(rule, 'destination', 'redirects'),
        statusCode,
      };
    }),
    headers: records('headers').map((rule) => {
      const pairs = rule['headers'];
      if (
        !Array.isArray(pairs) ||
        !pairs.every(
          (pair): pair is HeaderPair =>
            isRecord(pair) && typeof pair['key'] === 'string' && typeof pair['value'] === 'string',
        )
      ) {
        throw new Error('[static-playground] vercel.json headers entries need key/value pairs');
      }
      return { source: stringField(rule, 'source', 'headers'), headers: pairs };
    }),
  };
}

export async function loadStaticHostConfiguration(
  path = VERCEL_CONFIGURATION_PATH,
): Promise<StaticHostConfiguration> {
  return parseStaticHostConfiguration(await Bun.file(path).json());
}

/**
 * Compile a Vercel `source` (path-to-regexp syntax: `:name` parameters and `(...)` groups) into an
 * anchored expression whose named groups carry the parameters.
 */
export function compileRouteSource(source: string): RegExp {
  let pattern = '';
  let index = 0;
  while (index < source.length) {
    const character = source[index]!;
    if (character === ':') {
      const name = /^[A-Za-z_]\w*/.exec(source.slice(index + 1))?.[0];
      if (name === undefined) throw new Error(`[static-playground] bad route source ${source}`);
      pattern += `(?<${name}>[^/]+)`;
      index += name.length + 1;
    } else if (character === '(') {
      const end = source.indexOf(')', index);
      if (end === -1) throw new Error(`[static-playground] bad route source ${source}`);
      pattern += source.slice(index, end + 1);
      index = end + 1;
    } else {
      pattern += character.replace(/[.*+?^${}|[\]\\/]/g, '\\$&');
      index += 1;
    }
  }
  return new RegExp(`^${pattern}$`);
}

function substitute(destination: string, match: RegExpExecArray): string {
  return destination.replace(/:([A-Za-z_]\w*)/g, (_whole, name: string) => {
    return match.groups?.[name] ?? `:${name}`;
  });
}

export function headersFor(configuration: StaticHostConfiguration, pathname: string): Headers {
  const headers = new Headers();
  for (const rule of configuration.headers) {
    if (!compileRouteSource(rule.source).test(pathname)) continue;
    for (const { key, value } of rule.headers) headers.set(key, value);
  }
  return headers;
}

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml; charset=utf-8',
};

/** The file a decoded path names inside `root`, or undefined when it escapes or is not a file. */
function fileInside(root: string, pathname: string): string | undefined {
  if (pathname.includes('\0') || pathname.split('/').includes('..')) return undefined;
  const candidate = resolve(root, `.${pathname}`);
  try {
    if (!statSync(candidate).isFile()) return undefined;
    const real = relative(realpathSync(root), realpathSync(candidate));
    if (real === '..' || real.startsWith(`..${sep}`)) return undefined;
    return candidate;
  } catch {
    return undefined;
  }
}

function filesystemMatch(
  configuration: StaticHostConfiguration,
  root: string,
  pathname: string,
): string | undefined {
  const trimmed = pathname.replace(/\/+$/, '');
  const candidates = configuration.cleanUrls
    ? [pathname, `${trimmed}.html`, `${trimmed}/index.html`]
    : [pathname, `${trimmed}/index.html`];
  for (const candidate of candidates) {
    if (!candidate.startsWith('/') || candidate.endsWith('/')) continue;
    const file = fileInside(root, candidate);
    if (file !== undefined) return file;
  }
  return undefined;
}

/** Answer one request the way the deployed host would. */
export function respondStatically(
  configuration: StaticHostConfiguration,
  root: string,
  request: Request,
): Response {
  const url = new URL(request.url);
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return new Response('Bad Request', { status: 400, headers: headersFor(configuration, '/') });
  }
  const headers = headersFor(configuration, url.pathname);
  for (const redirect of configuration.redirects) {
    const match = compileRouteSource(redirect.source).exec(url.pathname);
    if (match === null) continue;
    headers.set('Location', substitute(redirect.destination, match));
    return new Response(null, { status: redirect.statusCode, headers });
  }
  if (configuration.cleanUrls && pathname.endsWith('.html')) {
    const clean = pathname.replace(/(?:\/index)?\.html$/, '') || '/';
    headers.set('Location', `${clean}${url.search}`);
    return new Response(null, { status: 308, headers });
  }
  let file = filesystemMatch(configuration, root, pathname);
  if (file === undefined) {
    for (const rewrite of configuration.rewrites) {
      const match = compileRouteSource(rewrite.source).exec(url.pathname);
      if (match === null) continue;
      file = fileInside(root, decodeURIComponent(substitute(rewrite.destination, match)));
      if (file !== undefined) break;
    }
  }
  if (file === undefined) return new Response('Not Found', { status: 404, headers });
  headers.set(
    'Content-Type',
    CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
  );
  return new Response(Bun.file(file), { status: 200, headers });
}

export type StaticServer = { origin: string; port: number; stop: () => Promise<void> };

export function startStaticServer(options: {
  directory: string;
  configuration: StaticHostConfiguration;
  port?: number;
}): StaticServer {
  const root = resolve(options.directory);
  if (!statSync(root).isDirectory()) {
    throw new Error(`[static-playground] ${root} is not a directory`);
  }
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: options.port ?? 0,
    fetch: (request) => respondStatically(options.configuration, root, request),
  });
  const port = server.port;
  if (port === undefined) throw new Error('[static-playground] the static server bound no port');
  return { origin: `http://127.0.0.1:${port}`, port, stop: () => server.stop(true) };
}

/** Write the port through a rename, so a reader never sees a partial file. */
export async function writePortFile(path: string, port: number): Promise<void> {
  const partial = `${path}.partial`;
  await Bun.write(partial, `${port}\n`);
  await rename(partial, path);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      directory: { type: 'string' },
      'port-file': { type: 'string' },
      'vercel-config': { type: 'string' },
    },
    strict: true,
  });
  if (values.directory === undefined || values['port-file'] === undefined) {
    throw new Error('usage: static-playground-server.ts --directory <dir> --port-file <file>');
  }
  const server = startStaticServer({
    directory: values.directory,
    configuration: await loadStaticHostConfiguration(values['vercel-config']),
  });
  await writePortFile(values['port-file'], server.port);
  process.stdout.write(`[static-playground] static server listening at ${server.origin}\n`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
