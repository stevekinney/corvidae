/**
 * The root `audit` gate: `bun audit --audit-level=high`, with a scoped, tooling-enforced
 * exception for each advisory in `scripts/audit-exceptions.ts`.
 *
 * A bare `--ignore` would silently outlive its reason. This guard turns each exception into a
 * contract and fails when any part of it stops holding:
 *
 *   - the registry entry is malformed (unknown advisory format, a missing field, a bad date);
 *   - the review-by date has passed;
 *   - the advisory no longer reports (a stale exception, to be removed);
 *   - an allowed chain does not end at the vulnerable package, so it describes only part of a path;
 *   - the package is reachable from a workspace by any dependency path that does not end with one
 *     of the entry's allowed chains, or the chain's first hop from a workspace is a runtime
 *     dependency rather than a development one;
 *   - an installed instance of the package is reachable from no workspace, which leaves the
 *     advisory-wide ignore covering something the lockfile graph cannot explain;
 *   - any other high or critical advisory remains once the exceptions are ignored.
 *
 * Reachability is read from `bun.lock`: production, development, and required peer edges of
 * workspaces, and the `dependencies`, `optionalDependencies`, and required peer dependencies of
 * locked packages. Bun installs unmet peers, so a peer is a real path; only peers the lockfile
 * marks optional are ignored. A workspace's peer is a runtime edge. The guard fails closed: a
 * workspace missing from the lockfile, or an installed instance of the package that no workspace
 * reaches, is reported. Each instance is checked on its own, so one reachable instance never
 * vouches for another.
 */
import { join, resolve as resolvePath } from 'node:path';
import { auditExceptions, type AuditException } from './audit-exceptions';

const ADVISORY_PATTERN = /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/;
const TRACKING_ISSUE_PATTERN = /^[A-Z][A-Z0-9]*-\d+$/;
const REVIEW_BY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAXIMUM_PATHS = 100_000;

type EdgeKind = 'runtime' | 'development';
type Edge = { readonly to: string; readonly kind: EdgeKind };
type Graph = {
  readonly nodes: ReadonlyMap<string, { readonly name: string; readonly workspace: boolean }>;
  readonly edges: ReadonlyMap<string, readonly Edge[]>;
  readonly workspaces: readonly string[];
  /** Structural faults in the lockfile that make the graph untrustworthy. */
  readonly problems: readonly string[];
};

export type CommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};
export type AuditGateDependencies = {
  readonly registry?: readonly AuditException[];
  readonly now?: () => Date;
  /** Runs `bun <arguments>` in the repository root. */
  readonly run: (argumentsList: readonly string[]) => Promise<CommandResult>;
  readonly readLockfile: () => Promise<string>;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function validateRegistry(registry: readonly AuditException[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  registry.forEach((entry, index) => {
    const label = `exception #${index + 1} (${entry?.advisory})`;
    const fields = ['advisory', 'package', 'reason', 'trackingIssue', 'reviewBy'] as const;
    for (const field of fields) {
      if (!isNonEmptyString(entry?.[field])) problems.push(`${label}: missing "${field}".`);
    }
    const chains: unknown = entry?.allowedChains;
    if (
      !Array.isArray(chains) ||
      chains.length === 0 ||
      !chains.every(
        (chain: unknown) =>
          Array.isArray(chain) &&
          chain.length >= 2 &&
          chain.every((name) => isNonEmptyString(name)),
      )
    ) {
      problems.push(
        `${label}: "allowedChains" must be a non-empty list of chains of at least two package names.`,
      );
    } else if (isNonEmptyString(entry?.package)) {
      // A chain that stops short of the package would accept whatever the last hop later reaches.
      for (const chain of chains as string[][]) {
        if (chain[chain.length - 1] !== entry.package) {
          problems.push(
            `${label}: allowed chain "${chain.join(' > ')}" must end at the vulnerable package "${entry.package}", so that it describes a complete dependency path.`,
          );
        }
      }
    }
    if (isNonEmptyString(entry?.advisory)) {
      if (!ADVISORY_PATTERN.test(entry.advisory)) {
        problems.push(`${label}: "${entry.advisory}" is not a GHSA advisory id.`);
      }
      if (seen.has(entry.advisory)) problems.push(`${label}: duplicate advisory id.`);
      seen.add(entry.advisory);
    }
    if (
      isNonEmptyString(entry?.trackingIssue) &&
      !TRACKING_ISSUE_PATTERN.test(entry.trackingIssue)
    ) {
      problems.push(
        `${label}: "${entry.trackingIssue}" is not a tracking issue id such as COR-1423.`,
      );
    }
    if (isNonEmptyString(entry?.reviewBy) && !isValidCalendarDate(entry.reviewBy)) {
      problems.push(`${label}: "${entry.reviewBy}" is not a valid YYYY-MM-DD review-by date.`);
    }
  });
  return problems;
}

function isValidCalendarDate(value: string): boolean {
  if (!REVIEW_BY_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

/** The exception is valid through the whole review-by day, in UTC. */
export function findExpiredExceptions(registry: readonly AuditException[], now: Date): string[] {
  const today = now.toISOString().slice(0, 10);
  return registry
    .filter((entry) => today > entry.reviewBy)
    .map(
      (entry) =>
        `${entry.advisory} (${entry.package}) expired on ${entry.reviewBy}. Review ${entry.trackingIssue}: remove the exception if the advisory is fixed, or get a new owner decision and a new review-by date.`,
    );
}

type Advisory = { readonly package: string; readonly id: string | null };

/** Reads `bun audit --json`, which maps a package name to its advisories. */
export function parseAdvisories(output: string): Advisory[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const advisories: Advisory[] = [];
  for (const [packageName, list] of Object.entries(parsed)) {
    if (!Array.isArray(list)) return null;
    for (const item of list as Record<string, unknown>[]) {
      const url = typeof item?.['url'] === 'string' ? item['url'] : '';
      const id = /GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}/.exec(url)?.[0] ?? null;
      advisories.push({ package: packageName, id });
    }
  }
  return advisories;
}

function packageNameOf(identifier: string): string {
  const at = identifier.lastIndexOf('@');
  return at > 0 ? identifier.slice(0, at) : identifier;
}

type LockEntry = [string, ...unknown[]];
type LockWorkspace = {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean } | undefined>;
  optionalPeers?: string[];
};

/** The names of a lockfile section's peer dependencies that are required rather than optional. */
function requiredPeers(section: LockWorkspace): string[] {
  const optional = new Set(Array.isArray(section.optionalPeers) ? section.optionalPeers : []);
  return Object.keys(section.peerDependencies ?? {}).filter(
    (name) => !optional.has(name) && section.peerDependenciesMeta?.[name]?.optional !== true,
  );
}

export function buildGraph(lockfileText: string): Graph {
  const lockfile = Bun.JSONC.parse(lockfileText) as {
    workspaces?: Record<string, LockWorkspace>;
    packages?: Record<string, LockEntry>;
  };
  const packages = lockfile.packages ?? {};
  const nodes = new Map<string, { name: string; workspace: boolean }>();
  const edges = new Map<string, Edge[]>();
  const workspaceNames = new Set<string>();
  const workspaceSections = new Map<string, LockWorkspace>();
  const lockedWorkspaceNames = new Set<string>();
  for (const [path, section] of Object.entries(lockfile.workspaces ?? {})) {
    if (isNonEmptyString(section.name)) {
      workspaceNames.add(section.name);
      workspaceSections.set(section.name, section);
      // The root workspace (empty path) is the importer itself and has no package entry.
      if (path !== '') lockedWorkspaceNames.add(section.name);
    }
  }
  const workspaceId = (name: string): string => `workspace:${name}`;
  const problems: string[] = [];
  const packageWorkspaces = new Set(
    Object.values(packages)
      .filter((entry) => typeof entry[0] === 'string' && entry[0].includes('@workspace:'))
      .map((entry) => packageNameOf(entry[0])),
  );
  for (const name of lockedWorkspaceNames) {
    if (!packageWorkspaces.has(name)) {
      problems.push(`workspace "${name}" not found in lockfile packages.`);
    }
  }

  for (const name of workspaceNames) {
    nodes.set(workspaceId(name), { name, workspace: true });
  }
  const resolve = (parentKey: string | null, name: string): string | null => {
    if (parentKey !== null) {
      for (
        let boundary = parentKey.length;
        boundary > 0;
        boundary = parentKey.lastIndexOf('/', boundary - 1)
      ) {
        const candidate = `${parentKey.slice(0, boundary)}/${name}`;
        if (candidate in packages) return candidate;
        if (boundary === 0) break;
      }
    }
    if (name in packages) return name;
    return workspaceNames.has(name) ? name : null;
  };
  const nodeFor = (key: string): string => {
    const name = packageNameOf(packages[key]?.[0] ?? key);
    const locked = packages[key]?.[0];
    if (workspaceNames.has(name) && (locked === undefined || locked.includes('@workspace:'))) {
      return workspaceId(name);
    }
    nodes.set(key, { name, workspace: false });
    return key;
  };
  const addEdge = (from: string, to: string, kind: EdgeKind): void => {
    const list = edges.get(from) ?? [];
    list.push({ to, kind });
    edges.set(from, list);
  };

  for (const [name, section] of workspaceSections) {
    const groups: [string[], EdgeKind][] = [
      [Object.keys(section.dependencies ?? {}), 'runtime'],
      [Object.keys(section.optionalDependencies ?? {}), 'runtime'],
      [requiredPeers(section), 'runtime'],
      [Object.keys(section.devDependencies ?? {}), 'development'],
    ];
    for (const [group, kind] of groups) {
      for (const dependency of group) {
        const key = resolve(null, dependency);
        if (key !== null) addEdge(workspaceId(name), nodeFor(key), kind);
      }
    }
  }
  for (const [key, entry] of Object.entries(packages)) {
    const source = nodeFor(key);
    if (source.startsWith('workspace:')) continue;
    const metadata = (entry[2] ?? {}) as LockWorkspace;
    for (const group of [
      Object.keys(metadata.dependencies ?? {}),
      Object.keys(metadata.optionalDependencies ?? {}),
      requiredPeers(metadata),
    ]) {
      for (const dependency of group) {
        const target = resolve(key, dependency);
        if (target !== null) addEdge(source, nodeFor(target), 'runtime');
      }
    }
  }
  return { nodes, edges, workspaces: [...workspaceNames].map(workspaceId), problems };
}

/**
 * Where `chain` begins in `path` when it is the path's whole tail, and -1 otherwise. A path always
 * ends at the vulnerable package, so a chain that stops short of it never matches: it would accept
 * every route that the package it ends at gains later.
 */
function chainStart(path: readonly string[], chain: readonly string[]): number {
  const start = path.length - chain.length;
  if (start < 0) return -1;
  return chain.every((name, offset) => path[start + offset] === name) ? start : -1;
}

/**
 * Describes every dependency path from a workspace to `packageName` that no allowed chain covers,
 * and every installed instance of it that no workspace reaches. An allowed chain covers a path
 * only when it is the path's complete tail, from the chain's importer through the package. An
 * empty list means the package is reached only through the allowed chains. `null` means the
 * package is not in the lockfile at all.
 */
export function findUnauthorizedPaths(
  graph: Graph,
  packageName: string,
  allowedChains: readonly (readonly string[])[],
): string[] | null {
  const targets = [...graph.nodes]
    .filter(([, node]) => node.name === packageName)
    .map(([id]) => id);
  if (targets.length === 0) return null;
  const reverse = new Map<string, string[]>();
  for (const [from, list] of graph.edges) {
    for (const { to } of list) reverse.set(to, [...(reverse.get(to) ?? []), from]);
  }
  const reaches = new Set<string>(targets);
  const queue = [...targets];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const parent of reverse.get(next) ?? []) {
      if (!reaches.has(parent)) {
        reaches.add(parent);
        queue.push(parent);
      }
    }
  }

  const offending: string[] = [];
  let walked = 0;
  const targetSet = new Set(targets);
  const walk = (trail: string[], kinds: EdgeKind[]): void => {
    if (walked > MAXIMUM_PATHS) return;
    const current = trail[trail.length - 1]!;
    if (targetSet.has(current)) {
      walked += 1;
      const names = trail.map((id) => graph.nodes.get(id)!.name);
      const covered = allowedChains.some((chain) => {
        const start = chainStart(names, chain);
        if (start < 0) return false;
        const head = trail[start]!;
        const hop = kinds[start];
        return !(graph.nodes.get(head)!.workspace && hop !== 'development');
      });
      if (!covered) offending.push(names.join(' > '));
      return;
    }
    for (const edge of graph.edges.get(current) ?? []) {
      if (!reaches.has(edge.to) || trail.includes(edge.to)) continue;
      walk([...trail, edge.to], [...kinds, edge.kind]);
    }
  };
  for (const workspace of graph.workspaces) {
    if (reaches.has(workspace)) walk([workspace], []);
  }
  // Reachability is per installed instance: the advisory-wide ignore covers every instance, so an
  // instance no workspace reaches must fail even when another instance is reachable.
  const fromWorkspaces = new Set<string>(graph.workspaces);
  const frontier = [...graph.workspaces];
  for (let next = frontier.shift(); next !== undefined; next = frontier.shift()) {
    for (const { to } of graph.edges.get(next) ?? []) {
      if (!fromWorkspaces.has(to)) {
        fromWorkspaces.add(to);
        frontier.push(to);
      }
    }
  }
  for (const target of targets) {
    if (!fromWorkspaces.has(target)) {
      offending.push(
        `${target} is installed but not reachable from any workspace; the lockfile graph cannot explain it`,
      );
    }
  }
  if (walked > MAXIMUM_PATHS)
    offending.push(`more than ${MAXIMUM_PATHS} dependency paths; refusing to guess`);
  return offending;
}

/** Everything about the registry that can be checked without running the final audit. */
export async function checkExceptions(
  registry: readonly AuditException[],
  now: Date,
  unfilteredAuditOutput: string,
  lockfileText: string,
): Promise<string[]> {
  const problems = [...validateRegistry(registry), ...findExpiredExceptions(registry, now)];
  if (problems.some((problem) => problem.startsWith('exception #'))) return problems;

  const advisories = parseAdvisories(unfilteredAuditOutput);
  if (advisories === null) {
    problems.push(
      '`bun audit --json` did not return a readable advisory report; cannot verify the exceptions.',
    );
    return problems;
  }
  const graph = buildGraph(lockfileText);
  problems.push(...graph.problems);
  for (const entry of registry) {
    const stillReports = advisories.some(
      (advisory) => advisory.package === entry.package && advisory.id === entry.advisory,
    );
    if (!stillReports) {
      problems.push(
        `${entry.advisory} (${entry.package}) no longer reports: stale exception, remove it from scripts/audit-exceptions.ts and close ${entry.trackingIssue}.`,
      );
    }
    const unauthorized = findUnauthorizedPaths(graph, entry.package, entry.allowedChains);
    if (unauthorized === null) {
      problems.push(
        `${entry.package} is not in bun.lock: stale exception for ${entry.advisory}, remove it.`,
      );
    } else {
      for (const path of unauthorized) {
        problems.push(
          `${entry.package} (${entry.advisory}) is reachable outside its allowed chains: ${path}.`,
        );
      }
    }
  }
  return problems;
}

/** Runs the gate. Returns the process exit code and writes diagnostics to the given streams. */
export async function runAuditGate(
  dependencies: AuditGateDependencies,
  write: { stdout(text: string): void; stderr(text: string): void },
): Promise<number> {
  const registry = dependencies.registry ?? auditExceptions;
  const now = dependencies.now?.() ?? new Date();
  const unfiltered = await dependencies.run(['audit', '--json']);
  const problems = await checkExceptions(
    registry,
    now,
    unfiltered.stdout,
    await dependencies.readLockfile(),
  );

  const ignores = registry
    .filter((entry) => ADVISORY_PATTERN.test(entry.advisory))
    .map((entry) => `--ignore=${entry.advisory}`);
  const gate = await dependencies.run(['audit', '--audit-level=high', ...ignores]);
  write.stdout(gate.stdout);
  write.stderr(gate.stderr);

  if (problems.length > 0) {
    write.stderr(
      `check-audit-exceptions: the audit exceptions no longer hold.\n${problems.map((problem) => `  ${problem}`).join('\n')}\n`,
    );
  }
  return gate.exitCode !== 0 || problems.length > 0 ? 1 : 0;
}

export const repositoryRoot = resolvePath(import.meta.dir, '..');

async function runBun(argumentsList: readonly string[]): Promise<CommandResult> {
  const child = Bun.spawn(['bun', ...argumentsList], {
    cwd: repositoryRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

export function createRepositoryDependencies(): Pick<
  AuditGateDependencies,
  'run' | 'readLockfile'
> {
  return { run: runBun, readLockfile: () => Bun.file(join(repositoryRoot, 'bun.lock')).text() };
}

async function main(): Promise<void> {
  try {
    process.exitCode = await runAuditGate(createRepositoryDependencies(), {
      stdout: (text) => void process.stdout.write(text),
      stderr: (text) => void process.stderr.write(text),
    });
  } catch (error: unknown) {
    process.stderr.write(`check-audit-exceptions failed: ${String(error)}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
