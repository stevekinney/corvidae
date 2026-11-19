#!/usr/bin/env bun
// Measures how evenly the Chromium fixtures suite divides into the four shards of
// `.github/workflows/browser-suites.yml`, and, given a run, how long each shard took. A measurement,
// never a gate: the proposed target is 20 minutes per shard (2026-11-19, from about 40 minutes for
// shard 1/4 while one serial file held about half the cases), and nothing here fails on a duration.
//
//   bun scripts/browser-fixtures/scripts/fixtures-shards.bench.ts [--run <github run id>]
//
// Case counts come from `playwright test --list --shard=N/4`, which needs no browser. With
// `--run`, shard durations come from `gh run view <id> --json jobs`.

import { resolve } from 'node:path';

const SHARDS = 4;
const TARGET_MINUTES = 20;
const root = resolve(import.meta.dirname, '..', '..', '..');

async function text(command: string[]): Promise<string> {
  const child = Bun.spawn(command, { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const [output] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return output;
}

await text(['bun', 'scripts/browser-fixtures/scripts/prepare-manifest.ts']);
const counts: number[] = [];
for (let shard = 1; shard <= SHARDS; shard += 1) {
  const listing = await text([
    'bun',
    '--bun',
    'playwright',
    'test',
    '--config',
    'scripts/browser-fixtures/playwright.config.ts',
    '--project=chromium',
    `--shard=${shard}/${SHARDS}`,
    '--list',
  ]);
  counts.push(Number(/Total: (\d+) tests/.exec(listing)?.[1] ?? 0));
}
const total = counts.reduce((sum, count) => sum + count, 0);
console.log(`cases per shard: ${counts.join(' ')} (total ${total})`);
console.log(
  `largest shard holds ${((Math.max(...counts) / Math.max(total, 1)) * 100).toFixed(1)}% of the cases (even is ${(100 / SHARDS).toFixed(1)}%)`,
);

const runIndex = Bun.argv.indexOf('--run');
const run = runIndex === -1 ? undefined : Bun.argv[runIndex + 1];
if (run !== undefined) {
  const jobs: { name: string; startedAt: string; completedAt: string }[] = JSON.parse(
    await text(['gh', 'run', 'view', run, '--json', 'jobs', '--jq', '.jobs']),
  );
  for (const job of jobs.filter((candidate) => candidate.name.includes('Chromium fixtures'))) {
    const minutes = (Date.parse(job.completedAt) - Date.parse(job.startedAt)) / 60_000;
    console.log(
      `${job.name}: ${minutes.toFixed(1)} minutes (target ${TARGET_MINUTES}, ${minutes <= TARGET_MINUTES ? 'within' : 'over'})`,
    );
  }
}
