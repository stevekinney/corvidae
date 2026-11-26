/**
 * The shared machinery of the guards that turn a recurring owner rule into a failing check
 * (`documentation/repository/owner-rules.json` lists them).
 *
 * Each such guard scans source text, finds the sites that break its rule, and judges the count per
 * file against an allowlist of today's offenders: `{ "<path relative to the repository root>":
 * <count> }`. The allowlist only shrinks. A file with more sites than its entry (or any with no
 * entry) fails, a count above the same allowlist on `origin/main` fails, and an entry that names
 * more sites than remain is reported so it can be lowered or removed. The fix for an offender is
 * product work and never part of the change that adds the guard.
 */

import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

export const repositoryRoot = join(import.meta.dir, '..');

/** Installed dependencies and generated output, mirroring `.gitignore`. Dot directories are skipped. */
const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  'build',
  'dist',
  'artifacts',
  'coverage',
  'playwright-report',
  'test-results',
  'test-output',
]);

export type CountAllowlist = Record<string, number>;

/** Appends to `paths` every file under `directory` whose extension is in `extensions`. */
export function collectFiles(
  directory: string,
  extensions: ReadonlySet<string>,
  paths: string[],
  exclude?: RegExp,
): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || SKIPPED_DIRECTORIES.has(entry.name)) continue;
      collectFiles(path, extensions, paths, exclude);
    } else if (
      entry.isFile() &&
      extensions.has(entry.name.slice(entry.name.lastIndexOf('.'))) &&
      !(exclude?.test(entry.name) ?? false)
    ) {
      paths.push(path);
    }
  }
}

export type Verdict = { problems: string[]; stale: string[] };

/**
 * Judges the sites found per file (a path relative to the repository root) against the allowlist.
 * Each site is a short description with its location. A file with more sites than its entry allows
 * is a problem; an entry that names more sites than the file holds is stale.
 */
export function judgeCounts(
  found: ReadonlyMap<string, readonly string[]>,
  allowlist: CountAllowlist,
): Verdict {
  const problems: string[] = [];
  const stale: string[] = [];
  for (const [file, sites] of found) {
    const allowed = Object.hasOwn(allowlist, file) ? allowlist[file]! : 0;
    if (sites.length <= allowed) continue;
    for (const site of sites.slice(allowed)) problems.push(`${file}:${site}`);
  }
  for (const [file, count] of Object.entries(allowlist)) {
    const held = found.get(file)?.length ?? 0;
    if (held < count) stale.push(`${file} - lists ${count} but holds ${held}`);
  }
  return { problems, stale };
}

/** The entries of an allowlist that are higher than the same allowlist on `origin/main`. */
export function allowlistRaises(
  current: CountAllowlist,
  baseline: CountAllowlist | null,
): string[] {
  if (baseline === null) return [];
  return Object.entries(current)
    .filter(([file, count]) => count > (Object.hasOwn(baseline, file) ? baseline[file]! : 0))
    .map(
      ([file, count]) =>
        `${file} - the allowlist now allows ${count} where origin/main allows ${Object.hasOwn(baseline, file) ? baseline[file] : 0}: an allowlist only shrinks`,
    );
}

/** The allowlist at `path` on `origin/main`, or `null` when the file is new or there is no `origin/main`. */
export function baselineAllowlist(path: string): CountAllowlist | null {
  const shown = Bun.spawnSync(['git', 'show', `origin/main:${path}`], { cwd: repositoryRoot });
  if (shown.exitCode !== 0) return null;
  try {
    return JSON.parse(shown.stdout.toString()) as CountAllowlist;
  } catch {
    return null;
  }
}

export type CountGuard = {
  /** The guard's name, which prefixes every line it prints. */
  name: string;
  /** What to do instead, printed above the failures. */
  advice: string;
  /** What the pass line says. */
  passed: string;
  /** Directories scanned, relative to the repository root. */
  directories: readonly string[];
  extensions: ReadonlySet<string>;
  /** A file name the scan skips (tests and harnesses). */
  exclude?: RegExp;
  /** The allowlist's path relative to the repository root. */
  allowlistPath: string;
  /** Replaces the directory walk: the files to scan, as paths relative to the repository root. */
  listFiles?: () => string[];
  /** The sites in one file, each as `<line> - <text>`. */
  find: (source: string, relativePath: string) => string[];
};

export function shorten(text: string, length = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > length ? `${flat.slice(0, length - 3)}...` : flat;
}

/** Runs a count guard against the working tree and sets the exit code. */
export async function runCountGuard(guard: CountGuard): Promise<void> {
  const paths: string[] = [];
  if (guard.listFiles !== undefined) {
    for (const file of guard.listFiles()) paths.push(join(repositoryRoot, file));
  } else {
    for (const directory of guard.directories) {
      collectFiles(join(repositoryRoot, directory), guard.extensions, paths, guard.exclude);
    }
  }
  const found = new Map<string, string[]>();
  for (const path of paths.toSorted()) {
    const file = relative(repositoryRoot, path);
    const sites = guard.find(await Bun.file(path).text(), file);
    if (sites.length > 0) found.set(file, sites);
  }
  const allowlist = (await Bun.file(
    join(repositoryRoot, guard.allowlistPath),
  ).json()) as CountAllowlist;
  const { problems, stale } = judgeCounts(found, allowlist);
  problems.push(...allowlistRaises(allowlist, baselineAllowlist(guard.allowlistPath)));

  for (const note of stale) {
    process.stdout.write(`${guard.name} - stale allowlist entry, lower or remove: ${note}\n`);
  }
  if (problems.length === 0) {
    process.stdout.write(`${guard.name} - OK (${guard.passed}).\n`);
    return;
  }
  process.stderr.write(`${guard.name} - ${guard.advice}\n\n`);
  for (const problem of problems) process.stderr.write(`  ${problem}\n`);
  process.exitCode = 1;
}

/** The 1-based line of `index` in `source`. */
export function lineOf(source: string, index: number): number {
  let line = 1;
  for (let position = source.indexOf('\n'); position !== -1 && position < index;) {
    line += 1;
    position = source.indexOf('\n', position + 1);
  }
  return line;
}
