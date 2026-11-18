/**
 * `bun scripts/browser-suite-shards.ts <shard>/<count>`: the Turborepo filters of one CI shard of
 * the component packages' browser suites (COR-2092), one `--filter=<package>` per line.
 *
 * Every component package with a `browser/` suite and a `test:browser` script takes part. Each is
 * weighed by its baselines and its spec files (a spec of its own costs about what ten sweep images
 * do), and the packages are dealt heaviest first to the lightest shard, so the shards finish close
 * together and the same tree always deals the same way.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type Suite = { name: string; weight: number };

const SPEC_WEIGHT = 10;

function countFiles(directory: string, suffix: string): number {
  if (!existsSync(directory)) return 0;
  return [...new Bun.Glob(`**/*${suffix}`).scanSync({ cwd: directory })].length;
}

/** Every component package that has a browser suite, with its weight. */
export function browserSuites(root: string): Suite[] {
  const suites: Suite[] = [];
  const components = join(root, 'components');
  for (const directory of readdirSync(components).toSorted()) {
    const base = join(components, directory);
    const manifestPath = join(base, 'package.json');
    if (!existsSync(manifestPath) || !existsSync(join(base, 'browser'))) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      name: string;
      scripts?: Record<string, string>;
    };
    if (manifest.scripts?.['test:browser'] === undefined) continue;
    const weight =
      countFiles(join(base, 'browser', 'snapshots'), '.png') +
      SPEC_WEIGHT * countFiles(join(base, 'browser', 'tests'), '.playwright.ts') +
      1;
    suites.push({ name: manifest.name, weight });
  }
  return suites;
}

/** Deals the suites into `count` shards, heaviest first to the lightest shard. */
export function shardSuites(suites: readonly Suite[], count: number): string[][] {
  const shards = Array.from({ length: count }, () => ({ weight: 0, names: [] as string[] }));
  const ordered = [...suites].toSorted(
    (left, right) => right.weight - left.weight || left.name.localeCompare(right.name),
  );
  for (const suite of ordered) {
    const lightest = shards.reduce((best, shard) => (shard.weight < best.weight ? shard : best));
    lightest.weight += suite.weight;
    lightest.names.push(suite.name);
  }
  return shards.map((shard) => shard.names.toSorted());
}

if (import.meta.main) {
  const match = /^(\d+)\/(\d+)$/.exec(Bun.argv[2] ?? '');
  const index = Number(match?.[1]);
  const count = Number(match?.[2]);
  if (match === null || index < 1 || index > count) {
    process.stderr.write('usage: bun scripts/browser-suite-shards.ts <shard>/<count>\n');
    process.exit(64);
  }
  const shards = shardSuites(browserSuites(resolve(import.meta.dirname, '..')), count);
  const names = shards[index - 1] ?? [];
  if (names.length === 0) {
    process.stderr.write(`Shard ${index}/${count} holds no browser suite.\n`);
    process.exit(1);
  }
  process.stdout.write(`${names.map((name) => `--filter=${name}`).join('\n')}\n`);
}
