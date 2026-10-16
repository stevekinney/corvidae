import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { directoryGlob, workspaceParentDirectories } from './workspace-directories.ts';

type Role = 'dependencies' | 'devDependencies' | 'peerDependencies' | 'optionalDependencies';
type Edge = {
  workspace: string;
  workspacePath: string;
  dependency: string;
  role: Role;
  declaredSpec: string;
  catalogSpec: string | null;
  effectiveOverride: string | null;
  lockedVersion: string | null;
  lockStatus: string;
  installedVersion: string | null;
  installedPackageJsonPath: string | null;
  installedStatus: string;
  installedMatchesLock: boolean | null;
  patched: boolean;
};
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
type PackageManifest = JsonObject & {
  name?: string;
  catalog?: JsonObject;
  overrides?: JsonObject;
  patchedDependencies?: JsonObject;
};
type Lockfile = JsonObject & {
  packages?: { [key: string]: JsonValue };
  workspaces?: { [key: string]: JsonValue };
  lockfileVersion?: JsonValue;
};
type WorkspaceRecord = {
  workspace: string;
  path: string;
  packageJson: string;
  roles: Record<Role, string[]>;
};
type Pairwise = {
  workspaceA: string;
  workspaceB: string;
  intersection: string[];
  onlyA?: string[];
  onlyB?: string[];
  intersectionCount: number;
  unionCount: number;
  jaccard: number | null;
};
type LockInfo = {
  version: string | null;
  status: string;
  candidates: Array<{ key: string; version: string }>;
};
function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function parseObject(text: string): JsonObject {
  const value: unknown = JSON.parse(text);
  if (!isObject(value)) throw new Error('Expected a JSON object');
  return value;
}
function stringMap(value: JsonValue | undefined): Record<string, string> {
  if (!isObject(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}
function optionalString(value: JsonValue | undefined): string | null {
  return typeof value === 'string' ? value : null;
}
function valueText(value: JsonValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}
function atIndex<T>(values: T[], index: number, label: string): T {
  const value = values[index];
  if (value === undefined) throw new Error(`Missing ${label} at ${index}`);
  return value;
}
const root = process.cwd();
const rootPackage = parseObject(
  await readFile(resolve(root, 'package.json'), 'utf8'),
) as PackageManifest;
const paths = ['package.json'];
const glob = new Bun.Glob(`${directoryGlob(workspaceParentDirectories)}/*/package.json`);
for await (const p of glob.scan({ cwd: root })) paths.push(p);

const lock = Bun.JSON5.parse(await readFile(resolve(root, 'bun.lock'), 'utf8')) as Lockfile;
const catalog = stringMap(rootPackage.catalog);
const overrides = stringMap(rootPackage.overrides);
const patchedDependencies = stringMap(rootPackage.patchedDependencies);
const roles: Role[] = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];
// COR-1284 gave every workspace its public name, so a scope prefix no longer distinguishes an
// internal edge from an external one: the root catalog also carries an external
// @lostgradient/environmentalist, and armorer/conversationalist are unscoped. Membership in the
// actual set of workspace names is the only discriminator that still works.
const internalWorkspaceNames = new Set<string>();
for (const path of paths) {
  const pkg = parseObject(await readFile(resolve(root, path), 'utf8')) as PackageManifest;
  if (typeof pkg.name === 'string') internalWorkspaceNames.add(pkg.name);
}
const external = (name: string) => !internalWorkspaceNames.has(name);
const versionFromEntry = (entry: unknown): string | null => {
  if (!Array.isArray(entry) || typeof entry[0] !== 'string') return null;
  const at = entry[0].lastIndexOf('@');
  return at > 0 ? entry[0].slice(at + 1) : null;
};
const lockCandidates = (name: string) =>
  Object.entries(lock.packages ?? {})
    .filter(([key]) => key === name || key.endsWith('/' + name))
    .map(([key, entry]) => ({ key, version: versionFromEntry(entry) }))
    .filter((x): x is { key: string; version: string } => !!x.version);
async function installedInfo(workspacePath: string, name: string, lockedVersion: string | null) {
  const start = resolve(root, workspacePath);
  const packagePath = name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name;
  let current = start;
  while (true) {
    const packageJsonPath = resolve(current, 'node_modules', packagePath, 'package.json');
    try {
      const parsed = parseObject(await readFile(packageJsonPath, 'utf8'));
      const version = typeof parsed['version'] === 'string' ? parsed['version'] : null;
      return {
        installedVersion: version,
        installedPackageJsonPath: packageJsonPath,
        installedStatus: version ? 'resolved-package-json' : 'package-json-missing-version',
        installedMatchesLock: version && lockedVersion ? version === lockedVersion : null,
      };
    } catch {}
    if (current === root) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return {
    installedVersion: null,
    installedPackageJsonPath: null,
    installedStatus: 'missing-from-node_modules',
    installedMatchesLock: null,
  };
}
function lockInfo(name: string): LockInfo {
  const exact = lock.packages?.[name];
  if (exact) {
    const version = versionFromEntry(exact);
    return {
      version: version ?? null,
      status: version ? 'exact' : 'ambiguous',
      candidates: lockCandidates(name),
    };
  }
  const candidates = lockCandidates(name);
  const versions = [...new Set(candidates.map((x) => x.version))];
  if (versions.length === 1)
    return {
      version: atIndex(versions, 0, 'lock version'),
      status: 'inferred-single-candidate',
      candidates,
    };
  if (versions.length > 1)
    return { version: null, status: 'ambiguous-multiple-candidates', candidates };
  return { version: null, status: 'missing-from-lock', candidates };
}
const workspaceRecords: WorkspaceRecord[] = [];
const edges: Edge[] = [];
for (const path of paths) {
  const pkg = parseObject(await readFile(resolve(root, path), 'utf8')) as PackageManifest;
  const workspace =
    path === 'package.json' ? '(root)' : typeof pkg.name === 'string' ? pkg.name : path;
  const workspacePath = path === 'package.json' ? '.' : path.slice(0, -'/package.json'.length);
  const record = {
    workspace,
    path: workspacePath,
    packageJson: path,
    roles: {
      dependencies: [],
      devDependencies: [],
      peerDependencies: [],
      optionalDependencies: [],
    } as Record<Role, string[]>,
  };
  for (const role of roles) {
    const map = isObject(pkg[role]) ? pkg[role] : {};
    record.roles[role] = Object.keys(map).filter(external);
    for (const [dependency, declaredSpec] of Object.entries(map)) {
      if (!external(dependency)) continue;
      const catalogSpec = declaredSpec === 'catalog:' ? optionalString(catalog[dependency]) : null;
      const override = optionalString(overrides[dependency]);
      const li = lockInfo(dependency);
      const installed = await installedInfo(workspacePath, dependency, li.version);
      const patchKey = Object.keys(patchedDependencies).find((key) =>
        key.startsWith(dependency + '@'),
      );
      edges.push({
        workspace,
        workspacePath,
        dependency,
        role,
        declaredSpec: valueText(declaredSpec),
        catalogSpec,
        effectiveOverride: override,
        lockedVersion: li.version,
        lockStatus: li.status,
        ...installed,
        patched: !!patchKey,
      });
    }
  }
  workspaceRecords.push(record);
}
const byDependency = new Map<string, Edge[]>();
for (const edge of edges) {
  const existing = byDependency.get(edge.dependency);
  if (existing) existing.push(edge);
  else byDependency.set(edge.dependency, [edge]);
}
const allDependencies = [...byDependency.keys()].toSorted();
const workspaceNames = workspaceRecords
  .filter((x) => x.workspace !== '(root)')
  .map((x) => x.workspace);
const sets = Object.fromEntries(
  workspaceRecords.map((x) => [
    x.workspace,
    new Set(edges.filter((e) => e.workspace === x.workspace).map((e) => e.dependency)),
  ]),
);
const ownership = Object.fromEntries(
  allDependencies.map((dependency) => {
    const es = byDependency.get(dependency);
    if (!es) throw new Error(`Missing dependency ownership for ${dependency}`);
    const owners = [...new Set(es.map((e) => e.workspace))].toSorted();
    const roleOwners = Object.fromEntries(
      roles.map((role) => [
        role,
        [...new Set(es.filter((e) => e.role === role).map((e) => e.workspace))].toSorted(),
      ]),
    );
    const specs = [...new Set(es.map((e) => e.declaredSpec))].toSorted();
    const catalogSpecs = [
      ...new Set(es.map((e) => e.catalogSpec).filter((value): value is string => value !== null)),
    ].toSorted((a, b) => a.localeCompare(b));
    const lockedVersions = [
      ...new Set(es.map((e) => e.lockedVersion).filter((value): value is string => value !== null)),
    ].toSorted((a, b) => a.localeCompare(b));
    return [
      dependency,
      {
        workspaceCount: owners.length,
        owners,
        roleOwners,
        specs,
        catalogSpecs,
        lockedVersions,
        roles: [...new Set(es.map((e) => e.role))].toSorted(),
        versionOrRoleDifferences: {
          distinctDeclaredSpecs: specs.length,
          distinctRoles: new Set(es.map((e) => e.role)).size,
          distinctLockedVersions: lockedVersions.length,
        },
      },
    ];
  }),
);
const pairwise: Pairwise[] = [];
const pairwiseRuntime: Pairwise[] = [];
const runtimeOnlyDepsByWorkspace = Object.fromEntries(
  workspaceNames.map((workspace) => [
    workspace,
    new Set(
      edges
        .filter(
          (e) =>
            e.workspace === workspace &&
            (e.role === 'dependencies' || e.role === 'optionalDependencies'),
        )
        .map((e) => e.dependency),
    ),
  ]),
);
for (let i = 0; i < workspaceNames.length; i++)
  for (let j = i + 1; j < workspaceNames.length; j++) {
    const workspaceA = atIndex(workspaceNames, i, 'workspace');
    const workspaceB = atIndex(workspaceNames, j, 'workspace');
    const setA = sets[workspaceA];
    const setB = sets[workspaceB];
    if (!setA || !setB) throw new Error('Missing workspace dependency set');
    const a = [...setA].toSorted();
    const b = [...setB].toSorted();
    const intersection = a.filter((x) => setB.has(x));
    const union = [...new Set([...a, ...b])];
    pairwise.push({
      workspaceA,
      workspaceB,
      intersection,
      intersectionCount: intersection.length,
      unionCount: union.length,
      jaccard: union.length ? Number((intersection.length / union.length).toFixed(6)) : 1,
    });
    const runtimeSetA = runtimeOnlyDepsByWorkspace[workspaceA];
    const runtimeSetB = runtimeOnlyDepsByWorkspace[workspaceB];
    if (!runtimeSetA || !runtimeSetB) throw new Error('Missing runtime dependency set');
    const runtimeA = [...runtimeSetA];
    const runtimeB = [...runtimeSetB];
    const runtimeIntersection = runtimeA.filter((x) => runtimeSetB.has(x)).toSorted();
    const onlyA = runtimeA.filter((x) => !runtimeSetB.has(x)).toSorted();
    const onlyB = runtimeB.filter((x) => !runtimeSetA.has(x)).toSorted();
    const runtimeUnionCount = runtimeIntersection.length + onlyA.length + onlyB.length;
    pairwiseRuntime.push({
      workspaceA,
      workspaceB,
      intersection: runtimeIntersection,
      onlyA,
      onlyB,
      intersectionCount: runtimeIntersection.length,
      unionCount: runtimeUnionCount,
      jaccard: runtimeUnionCount
        ? Number((runtimeIntersection.length / runtimeUnionCount).toFixed(6))
        : null,
    });
  }
const externalEdges = edges.length;
const runtimeEdges = edges.filter((e) => e.role === 'dependencies').length;
const optionalEdges = edges.filter((e) => e.role === 'optionalDependencies').length;
const devEdges = edges.filter((e) => e.role === 'devDependencies').length;
const peerEdges = edges.filter((e) => e.role === 'peerDependencies').length;
const developmentEdges = devEdges + peerEdges;
const runtimeDeps = new Set(
  edges
    .filter((e) => e.role === 'dependencies' || e.role === 'optionalDependencies')
    .map((e) => e.dependency),
);
const developmentDeps = new Set(
  edges
    .filter((e) => e.role === 'devDependencies' || e.role === 'peerDependencies')
    .map((e) => e.dependency),
);
const nonRootEdges = edges.filter((e) => e.workspace !== '(root)');
const uniqueToOneWorkspace = allDependencies.filter((d) => ownership[d]?.workspaceCount === 1);
const packageJsonWorkspacePaths = workspaceRecords
  .filter((x) => x.workspace !== '(root)')
  .map((x) => x.path);
const lockWorkspacePaths = Object.keys(lock.workspaces ?? {})
  .filter((x) => x !== '')
  .toSorted();
const result = {
  generatedAt: new Date().toISOString(),
  source: {
    repository: root,
    manifests: paths.toSorted(),
    lockfile: 'bun.lock',
    lockfileVersion: lock.lockfileVersion,
    workspaceCountIncludingRoot: workspaceRecords.length,
    workspaceCountExcludingRoot: workspaceRecords.length - 1,
    pairwiseWorkspaceCount: workspaceNames.length,
  },
  root: { catalog, overrides, patchedDependencies },
  directExternalDependencyEdges: edges,
  workspaces: workspaceRecords,
  uniqueExternalDependencies: {
    excludingRoot: [...new Set(nonRootEdges.map((e) => e.dependency))].toSorted(),
    includingRoot: allDependencies,
  },
  counts: {
    directExternalEdgesIncludingRoot: externalEdges,
    directExternalEdgesExcludingRoot: nonRootEdges.length,
    runtimeEdgesIncludingRoot: runtimeEdges,
    optionalEdgesIncludingRoot: optionalEdges,
    devEdgesIncludingRoot: devEdges,
    peerEdgesIncludingRoot: peerEdges,
    developmentAndPeerEdgesIncludingRoot: developmentEdges,
    uniqueDependenciesIncludingRoot: allDependencies.length,
    uniqueDependenciesExcludingRoot: new Set(nonRootEdges.map((e) => e.dependency)).size,
    installedResolution: {
      edgeCount: edges.length,
      resolvedFromOwningWorkspaceNodeModules: edges.filter(
        (e) => e.installedStatus === 'resolved-package-json',
      ).length,
      missingFromNodeModules: edges.filter((e) => e.installedStatus === 'missing-from-node_modules')
        .length,
      mismatchedWithLock: edges.filter((e) => e.installedMatchesLock === false).length,
    },
    uniqueRuntimeDependencies: [...runtimeDeps].toSorted(),
    uniqueDevelopmentAndPeerDependencies: [...developmentDeps].toSorted(),
    runtimeDevelopmentOverlap: [...runtimeDeps].filter((x) => developmentDeps.has(x)).toSorted(),
  },
  ownership,
  uniqueToOneWorkspace: Object.fromEntries(
    uniqueToOneWorkspace.map((d) => [d, ownership[d]?.owners[0] ?? '(unknown)']),
  ),
  pairwise,
  pairwiseRuntime,
  lockWorkspaceComparison: {
    manifestWorkspacePaths: packageJsonWorkspacePaths.toSorted(),
    lockWorkspacePaths,
    missingFromLock: packageJsonWorkspacePaths
      .filter((x) => !lockWorkspacePaths.includes(x))
      .toSorted(),
    extraInLock: lockWorkspacePaths
      .filter((x) => !packageJsonWorkspacePaths.includes(x))
      .toSorted(),
  },
  notes: [
    'Direct inventory excludes internal workspace edges (by workspace membership, not scope) from external dependency counts.',
    `There are ${workspaceRecords.length - 1} non-root workspaces; root is included only in including-root counts and direct-edge ownership, and is excluded from both pairwise matrices.`,
    'catalogSpec is populated only when the manifest declares catalog:; declaredSpec preserves literal manifest values.',
    'lockedVersion is read from Bun lockfile packages; inferred or ambiguous status is explicit. installedVersion is read from the owning workspace node_modules package.json by walking ancestor node_modules directories.',
    'A direct edge is marked installedMatchesLock false if its owning workspace resolution differs from the exact root lock package entry.',
    'The lock package graph contains transitive packages; this report does not infer direct usage or unused dependencies from transitive presence.',
  ],
};
await writeFile('/tmp/corvidae-dependency-inventory.json', JSON.stringify(result, null, 2) + '\n');
