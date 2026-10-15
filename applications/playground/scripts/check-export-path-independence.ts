/**
 * Proves the static export's bytes do not depend on the checkout's absolute path.
 *
 *   bun scripts/check-export-path-independence.ts [--components button,tooltip | --components all]
 *
 * Clones the repository's committed `HEAD` twice, into directories whose absolute paths differ in
 * name and depth, installs each with `bun install --frozen-lockfile`, runs the same static export
 * in each, and compares the two build digests. On a mismatch it names every differing path and the
 * first differing bytes of each, then exits 1. Only committed source is compared, as the deployed
 * build sees it. The default component set keeps the run to a few minutes; `all` is the full export.
 *
 * Inside a clone it is also the export step itself (`--export-in-place`), so both sides run the
 * clone's own code.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { readScrubbedEnvironment } from '../src/environment-configuration.ts';
import { REPOSITORY_ROOT } from '../src/playground-paths.ts';
import {
  buildDigestOf,
  createDigestManifest,
  type DigestManifestEntry,
} from './static-playground-digest.ts';

const DEFAULT_COMPONENTS = ['button', 'tooltip', 'tabs'];
const PLAYGROUND = join('applications', 'playground');
/** Ceilings no healthy step reaches; one that does is stopped and fails the check. */
const INSTALL_MILLISECONDS = 10 * 60_000;
const EXPORT_MILLISECONDS = 60 * 60_000;

type ExportResult = { digest: string; manifest: DigestManifestEntry[] };

async function run(
  command: string[],
  cwd: string,
  milliseconds: number,
  env?: Record<string, string>,
): Promise<string> {
  const child = Bun.spawn(command, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: milliseconds,
    ...(env === undefined ? {} : { env }),
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (status !== 0) {
    throw new Error(
      `[path-independence] ${command.join(' ')} in ${cwd} exited ${status}\n${stderr.slice(-4_000)}`,
    );
  }
  return stdout;
}

/** Run inside a clone: export, then print the build digest and manifest as one JSON line. */
async function exportInPlace(components: string[] | 'all'): Promise<void> {
  const { runStaticExport } = await import('./static-export.ts');
  const outputDirectory = join(REPOSITORY_ROOT, PLAYGROUND, 'build');
  await runStaticExport({
    baseUrl: 'https://cinder.website',
    ...(components === 'all' ? {} : { sidebarComponents: components, allComponents: components }),
  });
  const manifest = await createDigestManifest(outputDirectory);
  process.stdout.write(
    `\n${JSON.stringify({ digest: buildDigestOf(manifest), manifest } satisfies ExportResult)}\n`,
  );
}

async function cloneAndExport(directory: string, components: string): Promise<ExportResult> {
  const head = await run(['git', 'rev-parse', 'HEAD'], REPOSITORY_ROOT, 60_000);
  const sha = head.trim();
  await run(
    ['git', 'clone', '--quiet', '--shared', '--no-checkout', REPOSITORY_ROOT, directory],
    tmpdir(),
    300_000,
  );
  await run(['git', 'checkout', '--quiet', '--detach', sha], directory, 300_000);
  await run(['bun', 'install', '--frozen-lockfile'], directory, INSTALL_MILLISECONDS);
  // From the Playground directory, as `bun run build` runs locally and on the host: Bun derives
  // bundle hashes and module comments from paths relative to the working directory.
  const stdout = await run(
    [
      'bun',
      join('scripts', 'check-export-path-independence.ts'),
      '--export-in-place',
      '--components',
      components,
    ],
    join(directory, PLAYGROUND),
    EXPORT_MILLISECONDS,
    // The time zone and locale `bun run build` pins, which server-rendered dates are formatted in.
    { ...readScrubbedEnvironment(), TZ: 'UTC', LANG: 'en_US.UTF-8' },
  );
  const last = stdout.trimEnd().split('\n').at(-1) ?? '';
  return JSON.parse(last) as ExportResult;
}

/** The first differing byte offset of two files, with some context from each. */
async function firstDifference(first: string, second: string): Promise<string> {
  const [left, right] = await Promise.all([readFile(first), readFile(second)]);
  let offset = 0;
  while (offset < left.length && offset < right.length && left[offset] === right[offset]) {
    offset += 1;
  }
  const context = (bytes: Buffer) =>
    JSON.stringify(bytes.subarray(Math.max(0, offset - 60), offset + 100).toString('utf8'));
  return `at byte ${offset}: ${context(left)} vs ${context(right)}`;
}

async function compare(firstRoot: string, secondRoot: string, components: string): Promise<number> {
  const [first, second] = await Promise.all([
    cloneAndExport(firstRoot, components),
    cloneAndExport(secondRoot, components),
  ]);
  process.stdout.write(
    `[path-independence] ${firstRoot}: ${first.digest}\n[path-independence] ${secondRoot}: ${second.digest}\n`,
  );
  if (first.digest === second.digest) {
    process.stdout.write(
      `[path-independence] identical: ${first.manifest.length} files, digest ${first.digest}\n`,
    );
    return 0;
  }
  const bySecond = new Map(second.manifest.map((entry) => [entry.path, entry.sha256]));
  const byFirst = new Map(first.manifest.map((entry) => [entry.path, entry.sha256]));
  const onlyFirst = first.manifest.filter((entry) => !bySecond.has(entry.path)).map((e) => e.path);
  const onlySecond = second.manifest.filter((entry) => !byFirst.has(entry.path)).map((e) => e.path);
  const changed = first.manifest.filter(
    (entry) => bySecond.has(entry.path) && bySecond.get(entry.path) !== entry.sha256,
  );
  process.stdout.write(
    `[path-independence] DIFFERENT: ${changed.length} changed, ${onlyFirst.length} only in the first, ${onlySecond.length} only in the second\n`,
  );
  for (const path of onlyFirst.slice(0, 20)) process.stdout.write(`  only first: ${path}\n`);
  for (const path of onlySecond.slice(0, 20)) process.stdout.write(`  only second: ${path}\n`);
  for (const entry of changed.slice(0, 40)) {
    const build = (root: string) => join(root, PLAYGROUND, 'build', entry.path);
    process.stdout.write(
      `  changed: ${entry.path} ${await firstDifference(build(firstRoot), build(secondRoot))}\n`,
    );
  }
  return 1;
}

const { values } = parseArgs({
  options: {
    components: { type: 'string', default: DEFAULT_COMPONENTS.join(',') },
    'export-in-place': { type: 'boolean', default: false },
    keep: { type: 'boolean', default: false },
  },
  strict: true,
  allowPositionals: false,
});
const components = values.components;

if (values['export-in-place']) {
  await exportInPlace(components === 'all' ? 'all' : components.split(','));
} else {
  const scratch = await mkdtemp(join(tmpdir(), 'cinder-path-independence-'));
  // Different names and depths, so a length- or depth-dependent byte shows up too.
  const firstRoot = join(scratch, 'first', 'corvidae');
  const secondRoot = join(scratch, 'second-checkout', 'nested', 'deeper', 'corvidae');
  try {
    process.exitCode = await compare(firstRoot, secondRoot, components);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    if (values.keep) process.stdout.write(`[path-independence] kept ${scratch}\n`);
    else await rm(scratch, { recursive: true, force: true });
  }
}
