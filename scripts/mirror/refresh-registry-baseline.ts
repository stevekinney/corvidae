import { loadPackageMap } from './package-map.ts';
import { baselineFile, loadRegistryBaseline, type RegistryBaseline } from './registry-baseline.ts';

/**
 * Refresh `registry-baseline.json` from the npm registry, or verify the committed copy against it.
 *
 * The surface-parity gate has to compare against what the registry actually published, but a test
 * that reaches the network is neither hermetic nor fast, and `bun run test:self` must be both. So
 * the fetch lives here, behind an explicit run, and the committed fixture is what the gate reads.
 * Staleness is caught without a network call because `package-map.json` independently records
 * each package's `lastPublishedVersion`, and `registry-baseline.test.ts` asserts the two agree:
 * bumping the map without refreshing this file fails offline.
 *
 *   bun scripts/mirror/refresh-registry-baseline.ts            # rewrite the fixture
 *   bun scripts/mirror/refresh-registry-baseline.ts --verify   # exit 1 on any drift
 */

const registry = 'https://registry.npmjs.org';

export class RegistryFetchError extends Error {}

export interface FetchedPackage {
  name: string;
  version: string;
  subpaths: string[];
}

interface Packument {
  'dist-tags'?: Record<string, string>;
  versions?: Record<string, { exports?: unknown }>;
}

/** The subpath keys of a published version's `exports` map, sorted, or `undefined` on a 404. */
export async function fetchPublishedSubpaths(
  name: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<FetchedPackage | undefined> {
  const response = await fetchImplementation(`${registry}/${name.replace('/', '%2f')}`);
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new RegistryFetchError(`${name}: registry returned HTTP ${response.status}`);
  }
  const packument = (await response.json()) as Packument;
  const version = packument['dist-tags']?.['latest'];
  if (version === undefined) throw new RegistryFetchError(`${name}: no dist-tags.latest`);
  const manifest = packument.versions?.[version];
  if (manifest === undefined) throw new RegistryFetchError(`${name}: no manifest for ${version}`);
  const exportsMap = manifest.exports;
  const subpaths =
    typeof exportsMap === 'object' && exportsMap !== null && !Array.isArray(exportsMap)
      ? Object.keys(exportsMap)
      : [];
  return { name, version, subpaths: subpaths.toSorted() };
}

/** Every published name the map carries a version for, paired with its corvidae workspace. */
async function publishedTargets(): Promise<{ workspace: string; name: string }[]> {
  const map = await loadPackageMap();
  const targets: { workspace: string; name: string }[] = [];
  for (const [workspace, entry] of Object.entries(map.workspaces)) {
    if (entry.disposition !== 'publish-as') continue;
    if (entry.lastPublishedVersion === null) continue;
    targets.push({ workspace, name: entry.name });
  }
  return targets.toSorted((left, right) => left.name.localeCompare(right.name));
}

export async function buildBaseline(
  fetchImplementation: typeof fetch = fetch,
  today: string = new Date().toISOString().slice(0, 10),
): Promise<RegistryBaseline> {
  const packages: RegistryBaseline['packages'] = {};
  for (const { workspace, name } of await publishedTargets()) {
    const fetched = await fetchPublishedSubpaths(name, fetchImplementation);
    if (fetched === undefined) {
      throw new RegistryFetchError(
        `${name} is recorded in package-map.json with a lastPublishedVersion but the registry returns 404; set lastPublishedVersion to null if it was never published`,
      );
    }
    packages[name] = {
      workspace,
      version: fetched.version,
      fetchedAt: today,
      subpaths: fetched.subpaths,
    };
  }
  return {
    documentation:
      'The subpath keys each published package exported in its latest registry version, committed so the surface-parity gate stays hermetic. Refresh with `bun scripts/mirror/refresh-registry-baseline.ts`; `--verify` diffs this file against the live registry. A package whose package-map.json `lastPublishedVersion` is null has no entry here by construction, and the gate treats its absence as a first publish rather than a parity failure.',
    source: registry,
    packages,
  };
}

/** Human-readable differences between the committed fixture and a freshly fetched one. */
export function describeDrift(committed: RegistryBaseline, fresh: RegistryBaseline): string[] {
  const drift: string[] = [];
  const names = new Set([...Object.keys(committed.packages), ...Object.keys(fresh.packages)]);
  for (const name of [...names].toSorted()) {
    const left = committed.packages[name];
    const right = fresh.packages[name];
    if (!left) {
      drift.push(`${name}: published at ${right?.version} but absent from the committed baseline`);
      continue;
    }
    if (!right) {
      drift.push(`${name}: in the committed baseline but no longer resolvable on the registry`);
      continue;
    }
    if (left.version !== right.version) {
      drift.push(`${name}: baseline records ${left.version}, registry publishes ${right.version}`);
    }
    const missing = right.subpaths.filter((subpath) => !left.subpaths.includes(subpath));
    const extra = left.subpaths.filter((subpath) => !right.subpaths.includes(subpath));
    if (missing.length > 0) drift.push(`${name}: baseline is missing ${missing.join(', ')}`);
    if (extra.length > 0) drift.push(`${name}: baseline carries unpublished ${extra.join(', ')}`);
  }
  return drift;
}

export async function run(argv: readonly string[]): Promise<number> {
  try {
    const fresh = await buildBaseline();
    if (!argv.includes('--verify')) {
      await Bun.write(baselineFile, `${JSON.stringify(fresh, undefined, 2)}\n`);
      const count = Object.keys(fresh.packages).length;
      process.stdout.write(`Refreshed registry-baseline.json for ${count} package(s)\n`);
      return 0;
    }
    const drift = describeDrift(await loadRegistryBaseline(), fresh);
    if (drift.length === 0) {
      process.stdout.write('registry-baseline.json matches the registry\n');
      return 0;
    }
    process.stderr.write(`registry-baseline.json has drifted:\n  ${drift.join('\n  ')}\n`);
    return 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (import.meta.main) process.exit(await run(Bun.argv.slice(2)));
