/**
 * Merges the shards of one design-review capture into the directory a reviewer opens
 * (`.github/workflows/design-review-capture.yml`: every scheme runs `SHARD_COUNT` shards, each
 * uploads its own artifact, and this runs once over all of them).
 *
 *   bun scripts/design-review-merge.ts --out <dir> --schemes light,dark --shards 6 <directory of shard directories>
 *
 * Each subdirectory of the last argument is one shard's output, named `…-<scheme>-<index>`, with its
 * own `manifest.jsonl` and `summary.json` (the names repeat in every shard, which is why they are
 * downloaded apart). The merge copies their screenshots and geometry facts beside one
 * `manifest.jsonl`, writes one `summary.json`, and audits the geometry once over the whole set,
 * so `geometry-report.md` covers every capture.
 *
 * The verdict belongs here and not to a shard, because a shard cannot see the run. It exits 1 when
 * a planned shard is missing (the gap a cut-short run left in the dark half), when nothing was
 * captured, when two captures share a file, or when a screen exists in one scheme and not the
 * other. A specification that failed an assertion of its own is recorded in `summary.json`
 * (`clean: false`) and is not a failure of the merge: its captures were taken before the assertion.
 */
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { auditGeometry } from './design-review-geometry.ts';

/** The manifest fields the merge reads; every other field travels with the line untouched. */
export interface MergedEntry {
  readonly source: string;
  readonly world?: string;
  readonly route: string;
  readonly tab?: string;
  readonly state: string;
  readonly width: number;
  readonly colorScheme: 'light' | 'dark';
  readonly viewport: string;
  readonly full?: string;
}

/** The files two or more entries claim, each with the number of entries that claim it. */
export function duplicatePaths(entries: readonly MergedEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    for (const path of [entry.viewport, entry.full]) {
      if (path !== undefined) counts.set(path, (counts.get(path) ?? 0) + 1);
    }
  }
  return new Map([...counts].filter(([, count]) => count > 1));
}

/** A screen as both schemes should have it: everything about the entry but the scheme. */
function screenKey(entry: MergedEntry): string {
  return [entry.source, entry.world ?? '', entry.route, entry.tab ?? '', entry.state, entry.width]
    .map(String)
    .join('\u0000');
}

/**
 * The screens one scheme has and the other lacks, as readable names with the scheme they are
 * missing from. Empty when the run captured one scheme only.
 */
export function schemeGaps(entries: readonly MergedEntry[]): string[] {
  const light = new Set(
    entries.filter((entry) => entry.colorScheme === 'light').map((entry) => screenKey(entry)),
  );
  const dark = new Set(
    entries.filter((entry) => entry.colorScheme === 'dark').map((entry) => screenKey(entry)),
  );
  if (light.size === 0 || dark.size === 0) return [];
  const gaps: string[] = [];
  for (const [have, lack, missing] of [
    [light, dark, 'dark'],
    [dark, light, 'light'],
  ] as const) {
    for (const key of have) {
      if (!lack.has(key)) gaps.push(`${key.split('\u0000').join(' / ')}: no ${missing} capture`);
    }
  }
  return gaps.toSorted();
}

/** The planned shards no directory is named for: `<scheme>-<index>` is the end of a shard's directory name. */
export function missingShards(
  directories: readonly string[],
  schemes: readonly string[],
  count: number,
): string[] {
  const missing: string[] = [];
  for (const scheme of schemes) {
    for (let index = 1; index <= count; index += 1) {
      const suffix = `-${scheme}-${String(index)}`;
      if (!directories.some((directory) => directory.endsWith(suffix))) {
        missing.push(`${scheme} shard ${String(index)}`);
      }
    }
  }
  return missing;
}

/** One shard as its `summary.json` reports it. */
interface ShardSummary {
  readonly captures?: number;
  readonly clean?: boolean;
}

/** What the merge found, for `summary.json` and the exit code. */
export interface MergeResult {
  readonly captures: number;
  readonly shards: readonly { name: string; captures: number; clean: boolean | null }[];
  readonly problems: readonly string[];
  readonly clean: boolean;
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

async function readEntries(path: string): Promise<MergedEntry[]> {
  try {
    const text = await readFile(path, 'utf8');
    return text
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as MergedEntry);
  } catch {
    return [];
  }
}

/** Merges the shard directories under `shardsDirectory` into `out` and judges the run. */
export async function mergeShards(options: {
  readonly shardsDirectory: string;
  readonly out: string;
  readonly schemes: readonly string[];
  readonly shardCount: number;
}): Promise<MergeResult> {
  const listed = await readdir(options.shardsDirectory, { withFileTypes: true });
  const directories = listed
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();
  const problems = missingShards(directories, options.schemes, options.shardCount).map(
    (name) => `${name} is missing: its artifact was never uploaded or the leg never ran`,
  );
  await mkdir(options.out, { recursive: true });
  const entries: MergedEntry[] = [];
  const lines: string[] = [];
  const shards: MergeResult['shards'][number][] = [];
  for (const name of directories) {
    const directory = join(options.shardsDirectory, name);
    const summary = await readJson<ShardSummary>(join(directory, 'summary.json'));
    const shardEntries = await readEntries(join(directory, 'manifest.jsonl'));
    if (summary === undefined)
      problems.push(`${name} wrote no summary.json: its run never finished`);
    shards.push({ name, captures: shardEntries.length, clean: summary?.clean ?? null });
    entries.push(...shardEntries);
    const text = await readFile(join(directory, 'manifest.jsonl'), 'utf8').catch(() => '');
    lines.push(...text.split('\n').filter((line) => line.trim() !== ''));
    for (const folder of ['screens', 'geometry']) {
      const files = await readdir(join(directory, folder)).catch(() => [] as string[]);
      await mkdir(join(options.out, folder), { recursive: true });
      for (const file of files) {
        // Names are unique across shards, so a copy that finds the file taken is a real collision.
        await cp(join(directory, folder, file), join(options.out, folder, file), {
          force: false,
          errorOnExist: true,
        }).catch((error: unknown) => {
          problems.push(`${name}: ${folder}/${file} could not be merged: ${String(error)}`);
        });
      }
    }
  }
  await writeFile(join(options.out, 'manifest.jsonl'), lines.map((line) => `${line}\n`).join(''));
  if (entries.length === 0) problems.push('no capture was written by any shard');
  for (const [path, count] of duplicatePaths(entries)) {
    problems.push(`${path} is claimed by ${String(count)} captures`);
  }
  for (const gap of schemeGaps(entries)) problems.push(gap);
  const geometry = await auditGeometry(options.out);
  const result: MergeResult = {
    captures: entries.length,
    shards,
    problems,
    clean: problems.length === 0 && shards.every((shard) => shard.clean !== false),
  };
  await writeFile(
    join(options.out, 'summary.json'),
    `${JSON.stringify({ ...result, geometry }, null, 2)}\n`,
  );
  return result;
}

/** Reads the command line, runs the merge and answers the exit code. */
export async function runMerge(argv: readonly string[]): Promise<number> {
  const values = new Map<string, string>();
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';
    if (argument.startsWith('--')) {
      values.set(argument, argv[index + 1] ?? '');
      index += 1;
    } else positional.push(argument);
  }
  const out = values.get('--out');
  const schemes = values.get('--schemes')?.split(',').filter(Boolean);
  const shardCount = Number(values.get('--shards'));
  const [shardsDirectory] = positional;
  if (
    out === undefined ||
    schemes === undefined ||
    schemes.length === 0 ||
    !Number.isInteger(shardCount) ||
    shardCount < 1 ||
    shardsDirectory === undefined
  ) {
    process.stderr.write(
      'usage: design-review-merge.ts --out <dir> --schemes light,dark --shards <count> <shards directory>\n',
    );
    return 2;
  }
  const result = await mergeShards({
    shardsDirectory: resolve(shardsDirectory),
    out: resolve(out),
    schemes,
    shardCount,
  });
  for (const problem of result.problems.slice(0, 50)) {
    process.stderr.write(`design review merge: ${problem}\n`);
  }
  if (result.problems.length > 50) {
    process.stderr.write(`design review merge: and ${String(result.problems.length - 50)} more\n`);
  }
  process.stdout.write(
    `design review merge: ${String(result.captures)} captures from ${String(result.shards.length)} shards in ${resolve(out)}${result.clean ? '' : ' (not clean; see summary.json)'}\n`,
  );
  return result.problems.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exitCode = await runMerge(process.argv.slice(2));
