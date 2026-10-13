/**
 * Serves the static export in `build/` the way the hosting configuration does: clean URLs
 * (`/theme-builder` answers from `theme-builder/index.html`) and literal files. It exists so
 * the browser tests can drive the exported site; it is not a deployment.
 *
 * Usage: bun scripts/serve-static-export.ts --port 54232
 */

import { stat } from 'node:fs/promises';
import { join, normalize, sep } from 'node:path';

const buildDirectory = join(import.meta.dirname, '..', 'build');

function parsePort(): number {
  const flag = process.argv.indexOf('--port');
  const port = Number(flag === -1 ? Number.NaN : process.argv[flag + 1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('serve-static-export: pass --port <1-65535>');
  }
  return port;
}

async function isFile(path: string): Promise<boolean> {
  try {
    const entry = await stat(path);
    return entry.isFile();
  } catch {
    return false;
  }
}

async function resolveFile(pathname: string): Promise<ReturnType<typeof Bun.file> | null> {
  const target = normalize(join(buildDirectory, decodeURIComponent(pathname)));
  if (target !== buildDirectory && !target.startsWith(buildDirectory + sep)) return null;
  for (const candidate of [target, join(target, 'index.html'), `${target}.html`]) {
    if (await isFile(candidate)) return Bun.file(candidate);
  }
  return null;
}

const port = parsePort();
Bun.serve({
  hostname: '127.0.0.1',
  port,
  async fetch(request) {
    const file = await resolveFile(new URL(request.url).pathname);
    if (file === null) return new Response('Not Found', { status: 404 });
    return new Response(file);
  },
});
process.stdout.write(`[serve-static-export] http://127.0.0.1:${port}\n`);
