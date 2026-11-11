/**
 * CSS-serving parity: does the playground serve the same CSS before and after a change?
 *
 * The playground serves Cinder's stylesheets twice, from its dev server and from its static export,
 * and a browser follows every `@import`. A refactor that moves, renames, or deletes stylesheets can
 * leave the source tree fine and still serve a broken or different cascade. This script records
 * what a browser would fetch and compares two recordings. It stores no snapshot in the repository.
 *
 * ```sh
 * # Record a base: run THIS script against a worktree of the base commit.
 * bun scripts/css-serving-parity.ts --record <dir> --root <worktree-of-base>
 *
 * # Check the current tree against it.
 * bun scripts/css-serving-parity.ts --check <dir>
 * ```
 *
 * `--root <checkout>` names the tree whose playground is served (the current checkout by default),
 * so a base that predates this script is still recorded: run the branch's script with `--root`
 * pointed at the base. `--modes dev,static` limits the run (both by default).
 *
 * The entry set is computed, never hard-coded: every `<link rel="stylesheet">` the served tree
 * renders on every route (the shell, the theme builder and its preview frame, and each component
 * page in its documentation and preview-only forms; the static export renders the documentation
 * pages) plus the target of the `/styles.css` redirect. From the entries the script follows every
 * `@import`, and writes each URL and its bytes under `<dir>/<mode>/`. `--check` records the same
 * on the current tree and prints every difference; the exit code is 1 when there is one.
 * `css-serving-parity-compare.ts` defines what counts as equal. `--check <dir> --against <dir>` compares two
 * recordings already on disk instead of recording the current tree (a long run can be split in two).
 */

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { collectStylesheets, stylesheetLinks } from './css-serving-parity-collect.ts';
import {
  compareRecords,
  formatDifferences,
  normalizeStylesheetUrl,
  SERVING_MODES,
  type ParityRecord,
  type ServingMode,
  type StylesheetRecord,
} from './css-serving-parity-compare.ts';

const REPOSITORY_ROOT = resolve(import.meta.dir, '..', '..', '..');
const READY_DEADLINE_MILLISECONDS = 15 * 60_000;
const REQUEST_CONCURRENCY = 8;
const STYLES_ENTRY_ROUTE = '/styles.css';
const FALLBACK_STYLES_ENTRY = '/styles/index.css';

function playgroundRoot(root: string): string {
  return join(root, 'applications', 'playground');
}

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response('') });
  const port = probe.port;
  if (port === undefined) throw new Error('could not reserve a port');
  await probe.stop(true);
  return port;
}

async function mapConcurrently<Input, Output>(
  inputs: readonly Input[],
  work: (input: Input) => Promise<Output>,
): Promise<Output[]> {
  const results: Output[] = [];
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= inputs.length) return;
      results[index] = await work(inputs[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(REQUEST_CONCURRENCY, inputs.length) }, worker));
  return results;
}

/** Start the checkout's own dev server, run `use` against it, and stop it. */
async function withDevServer<Result>(
  root: string,
  use: (origin: string) => Promise<Result>,
): Promise<Result> {
  const scratch = await mkdtemp(join(tmpdir(), 'css-serving-parity-'));
  const portFile = join(scratch, 'port');
  const port = await freePort();
  const child = Bun.spawn([process.execPath, 'src/playground-server.ts'], {
    cwd: playgroundRoot(root),
    env: { ...process.env, PORT: String(port), PLAYGROUND_PORT_FILE: portFile },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  try {
    const origin = await waitUntilReady(portFile, child);
    return await use(origin);
  } finally {
    child.kill('SIGTERM');
    const exited = await Promise.race([
      child.exited.then(() => true),
      Bun.sleep(10_000).then(() => false),
    ]);
    if (!exited) child.kill('SIGKILL');
    await rm(scratch, { recursive: true, force: true });
  }
}

async function waitUntilReady(portFile: string, child: Bun.Subprocess): Promise<string> {
  const deadline = Date.now() + READY_DEADLINE_MILLISECONDS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error('the playground dev server exited before it was ready');
    if (existsSync(portFile)) {
      const portText = await readFile(portFile, 'utf8');
      const port = portText.trim();
      const origin = `http://localhost:${port}`;
      try {
        const ready = await fetch(`${origin}/ready`);
        if (ready.status === 200) return origin;
      } catch {
        // Not accepting connections yet.
      }
    }
    await Bun.sleep(500);
  }
  throw new Error('the playground dev server was not ready before the deadline');
}

async function fetchText(origin: string, route: string): Promise<string> {
  const response = await fetch(`${origin}${route}`);
  if (response.status !== 200) throw new Error(`${route} answered ${response.status}`);
  return response.text();
}

/** The routes whose HTML the dev server renders, derived from the served tree's own manifest. */
async function devRoutes(origin: string): Promise<string[]> {
  const manifests = JSON.parse(await fetchText(origin, '/api/manifest')) as { kebabName: string }[];
  return [
    '/',
    '/theme-builder',
    '/theme-builder/preview',
    ...manifests.flatMap(({ kebabName }) => [`/page/${kebabName}`, `/page/${kebabName}?preview=1`]),
  ];
}

async function recordDev(root: string): Promise<{ record: StylesheetRecord; stylesEntry: string }> {
  return withDevServer(root, async (origin) => {
    const documents = await mapConcurrently(await devRoutes(origin), (route) =>
      fetchText(origin, route),
    );
    const redirect = await fetch(`${origin}${STYLES_ENTRY_ROUTE}`, { redirect: 'manual' });
    const location = redirect.headers.get('location');
    const stylesEntry =
      location === null ? FALLBACK_STYLES_ENTRY : normalizeStylesheetUrl(location);
    const entries = [...documents.flatMap(stylesheetLinks), stylesEntry];
    const record = await collectStylesheets(entries, async (url) => {
      const response = await fetch(`${origin}${url}`);
      return response.status === 200 ? response.text() : undefined;
    });
    return { record, stylesEntry };
  });
}

async function filesBelow(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await filesBelow(path)));
    else found.push(path);
  }
  return found;
}

async function exportStatically(root: string): Promise<string> {
  const playground = playgroundRoot(root);
  const child = Bun.spawn([process.execPath, 'scripts/static-export.ts'], {
    cwd: playground,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PLAYGROUND_BASE_URL: 'https://cinder.website',
      TZ: 'UTC',
      LANG: 'en_US.UTF-8',
    },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  const [status, errors] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (status !== 0)
    throw new Error(`the static export failed (${status}):\n${errors.slice(-2000)}`);
  return join(playground, 'build');
}

async function recordStatic(root: string, stylesEntry: string): Promise<StylesheetRecord> {
  const build = await exportStatically(root);
  const files = await filesBelow(build);
  const documents = await Promise.all(
    files.filter((file) => file.endsWith('.html')).map((file) => readFile(file, 'utf8')),
  );
  const entries = [...documents.flatMap(stylesheetLinks), stylesEntry];
  // The export serves `/assets/<digest>/<path>`; the digest is the one directory under `assets/`.
  const assetDirectories = await readdir(join(build, 'assets'));
  const digest = assetDirectories.find((name) => /^[0-9a-f]{64}$/.test(name));
  return collectStylesheets(entries, async (url) => {
    for (const candidate of [
      join(build, url),
      ...(digest ? [join(build, 'assets', digest, url)] : []),
    ]) {
      if (existsSync(candidate)) return readFile(candidate, 'utf8');
    }
    return undefined;
  });
}

/** Record the requested serving modes of the checkout at `root`. */
export async function recordParity(
  root: string,
  modes: readonly ServingMode[],
): Promise<Partial<ParityRecord>> {
  const record: Partial<ParityRecord> = {};
  let stylesEntry = FALLBACK_STYLES_ENTRY;
  if (modes.includes('dev')) {
    const dev = await recordDev(root);
    record.dev = dev.record;
    stylesEntry = dev.stylesEntry;
  }
  if (modes.includes('static')) record.static = await recordStatic(root, stylesEntry);
  return record;
}

type StoredRecord = {
  version: 1;
  modes: Partial<Record<ServingMode, { entries: string[]; missing: string[]; urls: string[] }>>;
};

/** Write each URL's bytes under `<directory>/<mode>/` and an index of what was recorded. */
export async function writeParityRecord(
  directory: string,
  record: Partial<ParityRecord>,
): Promise<void> {
  const stored: StoredRecord = { version: 1, modes: {} };
  for (const mode of SERVING_MODES) {
    const modeRecord = record[mode];
    if (modeRecord === undefined) continue;
    stored.modes[mode] = {
      entries: modeRecord.entries,
      missing: modeRecord.missing,
      urls: [...modeRecord.files.keys()].toSorted(),
    };
    for (const [url, text] of modeRecord.files) {
      const path = join(directory, mode, url);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text);
    }
  }
  await writeFile(join(directory, 'record.json'), `${JSON.stringify(stored, null, 2)}\n`);
}

/** Read a record written by {@link writeParityRecord}. */
export async function readParityRecord(directory: string): Promise<Partial<ParityRecord>> {
  const stored = JSON.parse(await readFile(join(directory, 'record.json'), 'utf8')) as StoredRecord;
  const record: Partial<ParityRecord> = {};
  for (const mode of SERVING_MODES) {
    const modeRecord = stored.modes[mode];
    if (modeRecord === undefined) continue;
    const files = new Map<string, string>();
    for (const url of modeRecord.urls) {
      files.set(url, await readFile(join(directory, mode, url), 'utf8'));
    }
    record[mode] = { entries: modeRecord.entries, files, missing: modeRecord.missing };
  }
  return record;
}

function parseModes(value: string | undefined): ServingMode[] {
  if (value === undefined) return [...SERVING_MODES];
  const modes = value.split(',').map((mode) => mode.trim());
  const unknown = modes.filter((mode) => !SERVING_MODES.includes(mode as ServingMode));
  if (unknown.length > 0) throw new Error(`unknown mode: ${unknown.join(', ')}`);
  return modes as ServingMode[];
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      record: { type: 'string' },
      check: { type: 'string' },
      against: { type: 'string' },
      root: { type: 'string' },
      modes: { type: 'string' },
    },
  });
  if ((values.record === undefined) === (values.check === undefined)) {
    process.stderr.write(
      'Usage: bun scripts/css-serving-parity.ts (--record <dir> | --check <dir> [--against <dir>]) [--root <checkout>] [--modes dev,static]\n',
    );
    return 2;
  }
  const root = resolve(values.root ?? REPOSITORY_ROOT);
  const modes = parseModes(values.modes);

  if (values.record !== undefined) {
    const directory = resolve(values.record);
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
    const record = await recordParity(root, modes);
    await writeParityRecord(directory, record);
    for (const mode of modes) {
      const modeRecord = record[mode]!;
      process.stdout.write(
        `[${mode}] recorded ${modeRecord.files.size} stylesheets from ${modeRecord.entries.length} entries` +
          `${modeRecord.missing.length > 0 ? ` (${modeRecord.missing.length} not served: ${modeRecord.missing.join(', ')})` : ''}\n`,
      );
    }
    return 0;
  }

  const before = await readParityRecord(resolve(values.check!));
  const after =
    values.against === undefined
      ? await recordParity(root, modes)
      : await readParityRecord(resolve(values.against));
  const complete = (record: Partial<ParityRecord>): ParityRecord => {
    const empty: StylesheetRecord = { entries: [], files: new Map(), missing: [] };
    return { dev: record.dev ?? empty, static: record.static ?? empty };
  };
  const checkedModes = modes.filter((mode) => before[mode] !== undefined);
  const differences = compareRecords(complete(before), complete(after)).filter((difference) =>
    checkedModes.includes(difference.mode),
  );
  const report = formatDifferences(differences);
  process.stdout.write(
    report === '' ? `CSS serving is identical (${checkedModes.join(', ')}).\n` : report,
  );
  return differences.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = await main();
}
