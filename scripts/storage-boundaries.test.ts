import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, posix, sep } from 'node:path';

import { workspaceParentDirectories } from './workspace-directories.ts';

/**
 * COR-1780: the dependency edges and file placement that keep Weft's storage split into its own
 * packages. `@lostgradient/storage` holds the protocol, each `@lostgradient/storage-*` package is
 * one adapter that alone carries its driver, and Weft and Bureau name no adapter they do not use,
 * so a change or dependency bump in one adapter re-keys only that adapter and its importers.
 * `storage-boundaries.slow.test.ts` proves the cache-key consequence; this file proves the edges.
 */

const root = join(import.meta.dir, '..');

const dependencyFields = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;
type DependencyField = (typeof dependencyFields)[number];

/** The parts of a `package.json` this guard reads. */
interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

const storageName = '@lostgradient/storage';
const adapterPrefix = '@lostgradient/storage-';
const weftName = '@lostgradient/weft';
const bureauName = '@lostgradient/bureau';

/** The only workspace packages `@lostgradient/storage` may name, and only as devDependencies. */
const storageWorkspaceDevelopmentDependencies = new Set([
  '@lostgradient/typescript',
  '@lostgradient/testing',
]);

/** The adapters Weft uses at runtime: the CLI's Bun SQLite and the service worker's IndexedDB. */
const weftAdapters = new Set([`${adapterPrefix}bun-sqlite`, `${adapterPrefix}indexeddb`]);

/** Driver packages that belong to one adapter and so to no `dependencies` of Weft or Bureau. */
const adapterDrivers = [
  'pg',
  'lmdb',
  'better-sqlite3',
  '@libsql/client',
  '@neondatabase/serverless',
  '@electric-sql/pglite',
];

/**
 * Every file Weft's storage directory holds, relative to it. Everything else moved to a storage
 * package or was deleted, so a file added here is either Weft's own or belongs elsewhere; adding
 * one is a reviewed edit to this list.
 */
const weftStorageFiles = [
  // The keyspace.
  'catalog-keys.test.ts',
  'catalog-keys.ts',
  'default-scope.ts',
  'generation-keys.ts',
  'key-prefixes.ts',
  'keys.ts',
  'lease-keys.ts',
  'mailbox-keys.ts',
  'outbox-keys.ts',
  'ownership-keys.ts',
  'signal-keys.ts',
  'workflow-lifecycle-keys.ts',
  'workflow-record-keys.ts',
  // What stays with Weft's own code.
  'bounded-ndjson-response.test.ts',
  'bounded-ndjson-response.ts',
  'compressed-storage.test.ts',
  'compressed-storage.ts',
  'http.test.ts',
  'http.ts',
  'index.ts',
  'non-empty-prefix-range-end.ts',
  'typed-storage.test.ts',
  'typed-storage.ts',
  // Tests that run through Weft's matrix or need Weft internals.
  'conditional-batch.test.ts',
  'durability/on-disk-crash-recovery.test.ts',
  'interface.test.ts',
  'non-ascii-prefix-ranges.test.ts',
  'storage-ergonomics.test.ts',
  'text-value-store.test.ts',
  // Bun SQLite files that need Weft's scripts.
  'bun-sql-integrity.test.ts',
  'bun-sql-workflow-visibility-backfill.test.ts',
  'bun-sql-workload.test-support.ts',
];

function namesIn(manifest: Manifest, field: DependencyField): string[] {
  return Object.keys(manifest[field] ?? {});
}

function isAdapter(name: string): boolean {
  return name.startsWith(adapterPrefix);
}

/**
 * Every way the storage packages, Weft and Bureau break the boundaries, one sentence each. The
 * manifests are keyed by package name; `workspaceNames` is every workspace package's name, so a
 * catalog dependency such as `@lostgradient/environmentalist` is not mistaken for one.
 */
function boundaryViolations(
  manifests: ReadonlyMap<string, Manifest>,
  workspaceNames: ReadonlySet<string>,
): string[] {
  const violations: string[] = [];
  const storage = manifests.get(storageName);
  if (storage === undefined) {
    violations.push(`${storageName} is not a workspace package`);
  } else {
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies'] as const) {
      for (const name of namesIn(storage, field).filter((entry) => workspaceNames.has(entry))) {
        violations.push(`${storageName} names the workspace package ${name} in ${field}`);
      }
    }
    for (const name of namesIn(storage, 'devDependencies')) {
      if (workspaceNames.has(name) && !storageWorkspaceDevelopmentDependencies.has(name)) {
        violations.push(`${storageName} names the workspace package ${name} in devDependencies`);
      }
    }
  }

  for (const [name, manifest] of manifests) {
    if (!isAdapter(name)) continue;
    if (!namesIn(manifest, 'dependencies').includes(storageName)) {
      violations.push(`${name} does not depend on ${storageName} in dependencies`);
    }
    for (const field of dependencyFields) {
      for (const dependency of namesIn(manifest, field)) {
        if (isAdapter(dependency)) {
          violations.push(`${name} names the adapter ${dependency} in ${field}`);
        }
        if (dependency === weftName) violations.push(`${name} names Weft in ${field}`);
      }
    }
  }

  const weft = manifests.get(weftName);
  if (weft === undefined) {
    violations.push(`${weftName} is not a workspace package`);
  } else {
    for (const field of dependencyFields) {
      for (const name of namesIn(weft, field).filter(isAdapter)) {
        if (!weftAdapters.has(name)) violations.push(`${weftName} names ${name} in ${field}`);
      }
    }
  }

  const bureau = manifests.get(bureauName);
  if (bureau === undefined) {
    violations.push(`${bureauName} is not a workspace package`);
  } else {
    for (const name of namesIn(bureau, 'dependencies').filter(isAdapter)) {
      violations.push(`${bureauName} names ${name} in dependencies`);
    }
  }

  for (const [name, manifest] of [
    [weftName, weft],
    [bureauName, bureau],
  ] as const) {
    if (manifest === undefined) continue;
    for (const driver of adapterDrivers.filter((entry) =>
      namesIn(manifest, 'dependencies').includes(entry),
    )) {
      violations.push(`${name} lists the adapter driver ${driver} in dependencies`);
    }
  }
  return violations;
}

/** The files in `actual` that are not in `expected`, and the files in `expected` that are not in `actual`. */
function fileSetViolations(actual: readonly string[], expected: readonly string[]): string[] {
  const present = new Set(actual);
  const wanted = new Set(expected);
  return [
    ...actual.filter((file) => !wanted.has(file)).map((file) => `unexpected file ${file}`),
    ...expected.filter((file) => !present.has(file)).map((file) => `missing file ${file}`),
  ].toSorted();
}

/** Every file below `directory`, as a POSIX path relative to it, read from disk rather than Git. */
function filesBelow(directory: string, prefix = ''): string[] {
  return readdirSync(join(directory, prefix), { withFileTypes: true }).flatMap((entry) => {
    const relative =
      prefix === '' ? entry.name : posix.join(prefix.split(sep).join('/'), entry.name);
    return entry.isDirectory() ? filesBelow(directory, relative) : [relative];
  });
}

function readManifest(directory: string): Manifest {
  return JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as Manifest;
}

function readWorkspaceManifests(): Map<string, Manifest> {
  const manifests = new Map<string, Manifest>();
  const directories = [
    ...workspaceParentDirectories.flatMap((parent) =>
      readdirSync(join(root, parent), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(root, parent, entry.name)),
    ),
    join(root, 'scripts/browser-fixtures'),
  ];
  for (const directory of directories) {
    try {
      const manifest = readManifest(directory);
      manifests.set(manifest.name, manifest);
    } catch (error) {
      // A directory without a manifest is not a workspace (such as an ignored leftover).
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return manifests;
}

const manifests = readWorkspaceManifests();
const workspaceNames = new Set(manifests.keys());

describe('the storage packages', () => {
  test('exist for every adapter directory and for Weft to depend on', () => {
    const adapters = [...workspaceNames].filter(isAdapter);
    for (const adapter of weftAdapters) expect(adapters).toContain(adapter);
    expect(workspaceNames.has(storageName)).toBe(true);
  });

  test('keep the dependency edges that give each adapter its own cache key', () => {
    expect(boundaryViolations(manifests, workspaceNames)).toEqual([]);
  });

  test("leave only Weft's own files in Weft's storage directory", () => {
    const actual = filesBelow(join(root, 'packages/weft/src/storage'));
    expect(fileSetViolations(actual, weftStorageFiles)).toEqual([]);
  });
});

describe('the boundary guard', () => {
  function fixture(): Map<string, Manifest> {
    return new Map<string, Manifest>([
      [
        storageName,
        {
          name: storageName,
          dependencies: { '@lostgradient/environmentalist': 'catalog:' },
          devDependencies: { '@lostgradient/typescript': 'workspace:*' },
        },
      ],
      [
        `${adapterPrefix}bun-sqlite`,
        { name: `${adapterPrefix}bun-sqlite`, dependencies: { [storageName]: 'workspace:*' } },
      ],
      [
        `${adapterPrefix}lmdb`,
        {
          name: `${adapterPrefix}lmdb`,
          dependencies: { [storageName]: 'workspace:*', lmdb: 'catalog:' },
        },
      ],
      [
        weftName,
        { name: weftName, dependencies: { [`${adapterPrefix}bun-sqlite`]: 'workspace:*' } },
      ],
      [bureauName, { name: bureauName, dependencies: { [weftName]: 'workspace:*' } }],
    ]);
  }
  const names = new Set([
    storageName,
    `${adapterPrefix}bun-sqlite`,
    `${adapterPrefix}lmdb`,
    `${adapterPrefix}turso`,
    weftName,
    bureauName,
    '@lostgradient/typescript',
    '@lostgradient/testing',
    '@lostgradient/memory',
  ]);

  test('accepts the intended graph, and treats a catalog dependency as external', () => {
    expect(boundaryViolations(fixture(), names)).toEqual([]);
  });

  test('rejects an adapter that depends on another adapter', () => {
    const graph = fixture();
    const bun = graph.get(`${adapterPrefix}bun-sqlite`) as Manifest;
    bun.devDependencies = { [`${adapterPrefix}lmdb`]: 'workspace:*' };
    expect(boundaryViolations(graph, names)).toEqual([
      `${adapterPrefix}bun-sqlite names the adapter ${adapterPrefix}lmdb in devDependencies`,
    ]);
  });

  test('rejects an adapter that names Weft or omits the protocol', () => {
    const graph = fixture();
    graph.set(`${adapterPrefix}lmdb`, {
      name: `${adapterPrefix}lmdb`,
      devDependencies: { [weftName]: 'workspace:*' },
    });
    expect(boundaryViolations(graph, names)).toEqual([
      `${adapterPrefix}lmdb does not depend on ${storageName} in dependencies`,
      `${adapterPrefix}lmdb names Weft in devDependencies`,
    ]);
  });

  test('rejects a workspace edge from the protocol package beyond its configuration and tests', () => {
    const graph = fixture();
    const storage = graph.get(storageName) as Manifest;
    storage.dependencies = { '@lostgradient/memory': 'workspace:*' };
    storage.devDependencies = { '@lostgradient/memory': 'workspace:*' };
    expect(boundaryViolations(graph, names)).toEqual([
      `${storageName} names the workspace package @lostgradient/memory in dependencies`,
      `${storageName} names the workspace package @lostgradient/memory in devDependencies`,
    ]);
  });

  test('rejects an adapter Weft does not use, an adapter in Bureau, and a driver in either', () => {
    const graph = fixture();
    const weft = graph.get(weftName) as Manifest;
    weft.devDependencies = { [`${adapterPrefix}lmdb`]: 'workspace:*' };
    weft.dependencies = { ...weft.dependencies, pg: 'catalog:' };
    const bureau = graph.get(bureauName) as Manifest;
    bureau.dependencies = { [`${adapterPrefix}lmdb`]: 'workspace:*', lmdb: 'catalog:' };
    expect(boundaryViolations(graph, names)).toEqual([
      `${weftName} names ${adapterPrefix}lmdb in devDependencies`,
      `${bureauName} names ${adapterPrefix}lmdb in dependencies`,
      `${weftName} lists the adapter driver pg in dependencies`,
      `${bureauName} lists the adapter driver lmdb in dependencies`,
    ]);
  });

  test('reports a file added to or missing from a directory', () => {
    expect(fileSetViolations(['a.ts', 'extra.ts'], ['a.ts', 'b.ts'])).toEqual([
      'missing file b.ts',
      'unexpected file extra.ts',
    ]);
  });
});
