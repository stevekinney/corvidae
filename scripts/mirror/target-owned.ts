import { chmod, lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { z } from 'zod';

/**
 * The mirror transform writes corvidae source into a clone of a public target repository and
 * asks git whether anything differs. An empty `git status --porcelain` means the sync is skipped.
 * That mechanism only works while the transform never writes a path the target owns, so every
 * such path is enumerated in `target-owned.json` and this module refuses writes that touch one.
 */

const policyFile = new URL('./target-owned.json', import.meta.url);

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expires must be an ISO calendar date, for example 2026-12-31')
  .refine(
    (value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)),
    'expires must be a real date',
  );

const targetName = z.string().min(1);

const pathEntrySchema = z.object({
  glob: z.string().min(1),
  reason: z.string().min(1),
  targets: z.array(targetName).min(1).optional(),
});

/**
 * One key the transform owns, or leaves to the target, inside a structured file it does write.
 *
 * A bare key rather than a JSON Pointer: under COR-1223's inversion the target owns everything
 * nobody listed, so no rule here ever has to reach inside a key to preserve part of it.
 */
const keyEntrySchema = z.object({
  key: z.string().min(1),
  reason: z.string().min(1),
  targets: z.array(targetName).min(1).optional(),
});

const exceptionEntrySchema = z.object({
  glob: z.string().min(1),
  reason: z.string().min(1),
  issue: z
    .string()
    .regex(/^[A-Z]+-\d+$/, 'issue must be a Linear identifier, for example COR-1183'),
  expires: isoDate,
  targets: z.array(targetName).min(1).optional(),
});

/**
 * One target directory or single file the transform removes outright, rather than syncing or
 * leaving alone.
 *
 * `target` is singular on purpose. Every other entry in this file widens to all targets when it
 * omits `targets`, and the same default here would be a retirement nobody scoped removing a path
 * from a repository nobody considered. A retirement is the destructive direction, so it names its
 * one repository and says nothing about the others.
 *
 * `directory` keeps its name even though a retired path is not always one: a bare relative path
 * with no leading or trailing slash was always exactly as valid a description of a single file —
 * `packages/weft/scripts/ci-workflows.test.ts` — as of a directory, and D3 (COR-1286) taught the
 * *walk* to branch on what the path actually is in the clone rather than widening this key to a
 * `path`/`kind` pair nothing needed. Every entry committed before that change named a directory
 * and stays valid unchanged: the regex was already a generic relative-path pattern, not a
 * directory-specific one.
 */
const retiredEntrySchema = z.object({
  directory: z
    .string()
    .min(1)
    .regex(
      /^[^/]+(\/[^/]+)*$/,
      'a retired path is a relative path with no leading or trailing slash',
    ),
  target: targetName,
  reason: z.string().min(1),
  issue: z
    .string()
    .regex(/^[A-Z]+-\d+$/, 'issue must be a Linear identifier, for example COR-1192'),
});

const policySchema = z.object({
  documentation: z.string().min(1),
  targets: z.array(targetName).min(1),
  paths: z.array(pathEntrySchema).min(1),
  retired: z.object({ policy: z.string().min(1), entries: z.array(retiredEntrySchema) }),
  insideFiles: z.object({
    policy: z.string().min(1),
    /** Manifest keys written from the transform's value, replacing whatever the target had. */
    manifestKeys: z.array(keyEntrySchema).min(1),
    /** Manifest keys the transform supplies only where the target carries none of its own. */
    manifestDefaults: z.array(keyEntrySchema).min(1),
    dependencies: z.object({ policy: z.string().min(1) }),
    /** COR-1468: how the peer pair composes, by name, between corvidae, the target and the surface. */
    peerDependencies: z.object({ policy: z.string().min(1) }),
    typeScriptTargetOwnedPolicy: z.string().min(1),
    /** Keys in an emitted `tsconfig*.json` read back out of the target's own. */
    typeScriptTargetOwned: z.array(keyEntrySchema).min(1),
  }),
  exceptions: z.object({ policy: z.string().min(1), entries: z.array(exceptionEntrySchema) }),
  openQuestions: z.array(z.string().min(1)),
});

export type TargetOwnedPolicy = z.infer<typeof policySchema>;
export type TargetOwnedPathEntry = z.infer<typeof pathEntrySchema>;
export type TargetOwnedExceptionEntry = z.infer<typeof exceptionEntrySchema>;
export type RetiredDirectoryEntry = z.infer<typeof retiredEntrySchema>;

/** A path the transform tried to write, paired with the enumeration entry that forbids it. */
export type TargetOwnedMatch = {
  path: string;
  glob: string;
  reason: string;
  /** Present when a temporary exception, rather than a permanent entry, holds the path. */
  expires?: string;
  issue?: string;
};

/** Whether the refused plan would have written the path or removed it. */
export type GuardedAction = 'write' | 'delete';

export class TargetOwnedViolation extends Error {
  readonly matches: readonly TargetOwnedMatch[];
  readonly expired: readonly TargetOwnedExceptionEntry[];
  readonly action: GuardedAction;

  constructor(
    matches: readonly TargetOwnedMatch[],
    expired: readonly TargetOwnedExceptionEntry[],
    action: GuardedAction = 'write',
  ) {
    super(describeViolation(matches, expired, action));
    this.name = 'TargetOwnedViolation';
    this.matches = matches;
    this.expired = expired;
    this.action = action;
  }
}

function describeViolation(
  matches: readonly TargetOwnedMatch[],
  expired: readonly TargetOwnedExceptionEntry[],
  action: GuardedAction,
): string {
  const lines: string[] = [];
  if (expired.length > 0) {
    lines.push(
      'Expired temporary exceptions in target-owned.json (renew the date or delete them):',
    );
    for (const entry of expired) {
      lines.push(`  ${entry.glob} expired ${entry.expires} (${entry.issue}): ${entry.reason}`);
    }
  }
  if (matches.length > 0) {
    lines.push(
      action === 'delete'
        ? 'The mirror transform must not delete these target-owned paths:'
        : 'The mirror transform must not write these target-owned paths:',
    );
    for (const match of matches) {
      const suffix = match.expires ? ` [temporary until ${match.expires}, ${match.issue}]` : '';
      lines.push(`  ${match.path} matches ${match.glob}${suffix}`);
      lines.push(`    ${match.reason}`);
    }
  }
  return lines.join('\n');
}

export async function loadTargetOwnedPolicy(
  source: URL | string = policyFile,
): Promise<TargetOwnedPolicy> {
  const text = await Bun.file(source).text();
  const policy = policySchema.parse(JSON.parse(text));
  assertRetirementsCoherent(policy);
  return policy;
}

/**
 * Refuse a policy whose two directions contradict each other, before anything reads it.
 *
 * Three ways they can. A retirement naming a target this file does not mirror is a ruling about
 * a repository nothing will ever apply it to. Two retirements of one directory in one target are
 * two rulings where there can only be one, and the reader would silently take whichever came
 * first. And a retired directory that a `paths` glob already claims for the same target says
 * both "the target owns this" and "the transform deletes this" — the conflict the retirement
 * mechanism exists to fail on rather than resolve, caught here at its cheapest, as configuration,
 * rather than at the point where a clone is already being walked.
 */
export function assertRetirementsCoherent(policy: TargetOwnedPolicy): void {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entry of policy.retired.entries) {
    const directory = normalizeTargetPath(entry.directory);
    if (!policy.targets.includes(entry.target)) {
      problems.push(
        `  ${directory} (${entry.issue}) retires from unknown target "${entry.target}"; expected one of ${policy.targets.join(', ')}`,
      );
    }
    const key = `${entry.target}:${directory}`;
    if (seen.has(key)) {
      problems.push(
        `  ${directory} is retired from ${entry.target} twice; one directory, one ruling`,
      );
    }
    seen.add(key);
    const owner = findTargetOwner(policy, directory, entry.target);
    if (owner) {
      problems.push(
        `  ${directory} is retired from ${entry.target} by ${entry.issue}, but the directory itself is target-owned by ${owner.glob}: ${owner.reason}`,
      );
    }
  }
  if (problems.length > 0) {
    throw new RetirementError(
      `target-owned.json's \`retired\` section contradicts the rest of the file:\n${problems.join('\n')}`,
    );
  }
}

/** Normalizes a target-relative path, rejecting absolute paths and traversal out of the target. */
export function normalizeTargetPath(path: string): string {
  if (isAbsolute(path)) throw new Error(`Expected a target-relative path, received "${path}"`);
  const normalized = normalize(path).split(sep).join('/');
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Path "${path}" escapes the target repository`);
  }
  return normalized;
}

function appliesToTarget(
  entry: { targets?: readonly string[] | undefined },
  target: string,
): boolean {
  return entry.targets === undefined || entry.targets.includes(target);
}

/** The keys one `insideFiles` list contributes for a target, in enumeration order. */
export function keysFor(
  entries: readonly { key: string; targets?: readonly string[] | undefined }[],
  target: string,
): string[] {
  return entries.filter((entry) => appliesToTarget(entry, target)).map((entry) => entry.key);
}

function startOfDay(now: Date): number {
  return Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
}

/** Exceptions whose expiry has arrived. Their presence is itself a failure, not a lapse into permanence. */
export function findExpiredExceptions(
  policy: TargetOwnedPolicy,
  now: Date = new Date(),
): TargetOwnedExceptionEntry[] {
  const today = startOfDay(now);
  return policy.exceptions.entries.filter(
    (entry) => Date.parse(`${entry.expires}T00:00:00Z`) <= today,
  );
}

/** The enumeration entry forbidding this path, or `undefined` when the transform may write it. */
export function findTargetOwner(
  policy: TargetOwnedPolicy,
  path: string,
  target: string,
  now: Date = new Date(),
): TargetOwnedMatch | undefined {
  const normalized = normalizeTargetPath(path);
  for (const entry of policy.paths) {
    if (!appliesToTarget(entry, target)) continue;
    if (new Bun.Glob(entry.glob).match(normalized)) {
      return { path: normalized, glob: entry.glob, reason: entry.reason };
    }
  }
  const today = startOfDay(now);
  for (const entry of policy.exceptions.entries) {
    if (!appliesToTarget(entry, target)) continue;
    if (Date.parse(`${entry.expires}T00:00:00Z`) <= today) continue;
    if (new Bun.Glob(entry.glob).match(normalized)) {
      return {
        path: normalized,
        glob: entry.glob,
        reason: entry.reason,
        expires: entry.expires,
        issue: entry.issue,
      };
    }
  }
  return undefined;
}

export type GuardOptions = {
  policy: TargetOwnedPolicy;
  target: string;
  paths: Iterable<string>;
  now?: Date;
  /** What the refused plan would have done. Writes are the default and the original case. */
  action?: GuardedAction;
};

/** Throws `TargetOwnedViolation` when any path is target-owned or any exception has expired. */
export function assertWritablePaths({
  policy,
  target,
  paths,
  now = new Date(),
  action = 'write',
}: GuardOptions): void {
  if (!policy.targets.includes(target)) {
    throw new Error(
      `Unknown mirror target "${target}"; expected one of ${policy.targets.join(', ')}`,
    );
  }
  const expired = findExpiredExceptions(policy, now);
  const matches: TargetOwnedMatch[] = [];
  for (const path of paths) {
    const match = findTargetOwner(policy, path, target, now);
    if (match) matches.push(match);
  }
  if (matches.length > 0 || expired.length > 0) {
    throw new TargetOwnedViolation(matches, expired, action);
  }
}

/**
 * Throws `TargetOwnedViolation` when a plan would delete a path the target owns.
 *
 * COR-1221 gave the transform a deletion: a file corvidae no longer carries is removed from the
 * target so the two trees stay the same tree. The enumeration had only ever stopped writes — its
 * own `openQuestions` said so — and a deletion is the more destructive of the two, so it is
 * checked by the same list, before anything is removed.
 */
export function assertDeletablePaths(options: Omit<GuardOptions, 'action'>): void {
  assertWritablePaths({ ...options, action: 'delete' });
}

/** Refusal to retire a directory, for any reason other than a target-owned collision. */
export class RetirementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetirementError';
  }
}

/**
 * Refusal to retire a directory holding a file the target owns.
 *
 * Separate from `TargetOwnedViolation` because the two say different things to a reader. A
 * violation means the transform produced a path it should not have, and the fix is in the
 * transform. This means two rulings in `target-owned.json` disagree about one file, and the fix
 * is a ruling: either the target's own pull request removes the file alongside the CI, hooks and
 * documentation that reference the retired directory, or the directory is not retired. The guard
 * picking one would silently delete something enumerated as the target's, which is the single
 * outcome this whole file exists to prevent.
 */
export class RetirementCollisionError extends RetirementError {
  readonly entry: RetiredDirectoryEntry;
  readonly matches: readonly TargetOwnedMatch[];

  constructor(entry: RetiredDirectoryEntry, matches: readonly TargetOwnedMatch[]) {
    super(
      [
        `Refusing to retire ${entry.directory} from ${entry.target} (${entry.issue}): it holds ${matches.length} file(s) that target-owned.json enumerates as the target's own.`,
        `  retired because: ${entry.reason}`,
        ...matches.flatMap((match) => [
          `  ${match.path} matches ${match.glob}`,
          `    ${match.reason}`,
        ]),
        'Neither ruling wins by default. Remove these paths in the target repository, in the same pull request that removes the CI jobs, hooks and documentation referencing the retired directory, or withdraw the retirement.',
      ].join('\n'),
    );
    this.name = 'RetirementCollisionError';
    this.entry = entry;
    this.matches = matches;
  }
}

/** The directories `target-owned.json` retires from one target, in enumeration order. */
export function retiredDirectoriesFor(policy: TargetOwnedPolicy, target: string): string[] {
  return policy.retired.entries
    .filter((entry) => entry.target === target)
    .map((entry) => normalizeTargetPath(entry.directory));
}

/** Whether a target-relative path is the retired directory itself or sits beneath it. */
function isUnder(path: string, directory: string): boolean {
  return path === directory || path.startsWith(`${directory}/`);
}

/**
 * Every file a retired path carries in a clone, as target-relative paths.
 *
 * A `retired` entry's `directory` key names a directory or a single file — nothing in its schema
 * ever distinguished the two, since a relative path with no leading or trailing slash is exactly
 * as valid a description of `packages/weft/scripts/ci-workflows.test.ts` as it is of
 * `packages/weft-ui`. The two need different walks, though: a directory recurses and every entry
 * arrives relative to it, so the caller has always prefixed each one back onto `normalized`; a
 * file has nothing beneath it to recurse into and is the whole answer by itself. Branching on
 * `lstat` here, rather than asking the caller to know which shape it is retiring, is what keeps
 * `retiredEntrySchema`'s `directory` key unchanged and every existing directory entry valid.
 *
 * Deliberately not `source.ts`'s walk for the directory case. That one filters to what the
 * transform calls source and skips the repository-operating names — `.gitignore`, `AGENTS.md`,
 * `CHANGELOG*`, `coverage-ratchet.json` — which are exactly the files a retirement has to notice,
 * because they are exactly the ones `paths` claims for the target. Filtering them out here would
 * turn the collision this function exists to raise into a silent partial deletion.
 *
 * A path the clone does not carry yields nothing rather than failing, whichever shape it is: a
 * retirement is a standing ruling, and the sync after the one that carried out the deletion finds
 * the path already gone. `.git` is skipped for the directory case because a retired directory is
 * never the repository root, so a `.git` beneath one is a nested checkout nobody asked this to
 * walk.
 */
async function walkRetiredPath(root: string, normalized: string): Promise<string[]> {
  const target = join(root, normalized);
  const stats = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    // Only "there is no such path" reads as already gone, for the reason given above: a
    // permission or I/O error that read as empty would silently shrink a deletion.
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (stats === undefined) return [];
  if (stats.isFile()) return [normalized];

  const entries = await readdir(target, { withFileTypes: true, recursive: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    },
  );
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = relative(target, join(entry.parentPath, entry.name)).split(sep).join('/');
    if (path.split('/').includes('.git')) continue;
    files.push(`${normalized}/${path}`);
  }
  return files;
}

export type RetirementOptions = {
  policy: TargetOwnedPolicy;
  target: string;
  /** A clone of the target. */
  directory: string;
  /** The directories to retire, which must every one be enumerated for this target. */
  directories: Iterable<string>;
  now?: Date;
};

/**
 * The files a retirement removes, refusing anything the enumeration does not authorize.
 *
 * The directories arrive as an argument rather than being read straight off the policy, and are
 * then checked against it. Production passes `retiredDirectoriesFor`, so the check can only ever
 * pass there — which is the point. The refusal is the boundary of the capability, not a branch in
 * its caller: any other caller, now or later, that hands this a directory nobody ruled on gets a
 * refusal naming it, rather than a deletion of a tree the mirror was never given authority over.
 */
export async function collectRetiredPaths({
  policy,
  target,
  directory,
  directories,
  now = new Date(),
}: RetirementOptions): Promise<string[]> {
  if (!policy.targets.includes(target)) {
    throw new Error(
      `Unknown mirror target "${target}"; expected one of ${policy.targets.join(', ')}`,
    );
  }
  const paths: string[] = [];
  for (const requested of directories) {
    const normalized = normalizeTargetPath(requested);
    const entry = policy.retired.entries.find(
      (candidate) =>
        candidate.target === target && normalizeTargetPath(candidate.directory) === normalized,
    );
    if (!entry) {
      throw new RetirementError(
        `Refusing to retire ${normalized} from ${target}: no entry in target-owned.json's \`retired\` section names it. A directory the transform removes outright is enumerated with a reason, a target and an issue; it is never inferred from a plan that emits nothing for it.`,
      );
    }
    const found = await walkRetiredPath(directory, normalized);
    const matches = found.flatMap((path) => {
      const owner = findTargetOwner(policy, path, target, now);
      return owner ? [owner] : [];
    });
    if (matches.length > 0) throw new RetirementCollisionError(entry, matches.toSorted(byPath));
    paths.push(...found);
  }
  return paths.toSorted();
}

function byPath(left: TargetOwnedMatch, right: TargetOwnedMatch): number {
  return left.path.localeCompare(right.path);
}

/**
 * Refuse a plan that writes into a directory the same policy retires.
 *
 * `writeTransformOutput` writes before it deletes, so an overlap would land a file and then
 * remove it in the same pass, leaving no trace in the target and no signal anywhere. It means the
 * two tables disagree — `layout-map.json` routing a workspace into a directory `target-owned.json`
 * retires — and that is a contradiction to fail on, not an ordering to tune.
 */
export function assertNoEmissionsIntoRetired(
  policy: TargetOwnedPolicy,
  target: string,
  paths: Iterable<string>,
): void {
  const retired = retiredDirectoriesFor(policy, target);
  if (retired.length === 0) return;
  const conflicts: string[] = [];
  for (const path of paths) {
    const normalized = normalizeTargetPath(path);
    const directory = retired.find((candidate) => isUnder(normalized, candidate));
    if (directory) conflicts.push(`  ${normalized} is emitted into retired ${directory}`);
  }
  if (conflicts.length > 0) {
    throw new RetirementError(
      `The plan writes into a directory target-owned.json retires from ${target}:\n${conflicts.toSorted().join('\n')}`,
    );
  }
}

/**
 * Plan contents, as text or as bytes.
 *
 * Bytes because the source half of the transform emits whatever a workspace's `src/` tree holds,
 * and one of corvidae's holds a PNG baseline fixture.
 */
export type TransformFiles = Readonly<Record<string, string | Uint8Array>>;

export type TransformOutput = {
  policy: TargetOwnedPolicy;
  target: string;
  directory: string;
  /** Target-relative path to file contents. */
  files: TransformFiles;
  /** Target-relative paths to remove, which the guard checks exactly as it checks a write. */
  deletions?: Iterable<string> | undefined;
  /** Target-relative written paths whose corvidae counterpart carries the executable bit. */
  executable?: Iterable<string> | undefined;
  now?: Date;
};

export interface TransformWriteResult {
  written: string[];
  deleted: string[];
}

/**
 * Writes transform output into a target clone, and removes the paths the plan retires, but only
 * after the whole plan clears the guard. Checking every path up front is what makes a refusal
 * leave the target byte-identical: a per-file check would already have written the files
 * preceding the offending one, and with deletions in the plan it would already have removed some.
 *
 * A directory the deletions empty is left in place. Git tracks files, so an empty directory is
 * not a change to the target and removing it would be tidiness the mirror cannot verify.
 */
export async function writeTransformOutput({
  policy,
  target,
  directory,
  files,
  deletions = [],
  executable = [],
  now = new Date(),
}: TransformOutput): Promise<TransformWriteResult> {
  const entries = Object.entries(files);
  const removals = [...deletions].map((path) => normalizeTargetPath(path));
  assertWritablePaths({ policy, target, paths: entries.map(([path]) => path), now });
  assertDeletablePaths({ policy, target, paths: removals, now });

  const executablePaths = new Set([...executable].map((path) => normalizeTargetPath(path)));
  const written: string[] = [];
  for (const [path, contents] of entries) {
    const normalized = normalizeTargetPath(path);
    const destination = join(directory, normalized);
    await mkdir(dirname(destination), { recursive: true });
    await Bun.write(destination, contents);
    if (executablePaths.has(normalized)) await chmod(destination, 0o755);
    written.push(relative(directory, destination).split(sep).join('/'));
  }

  const deleted: string[] = [];
  for (const path of removals) {
    await rm(join(directory, path), { force: true });
    deleted.push(path);
  }
  return { written, deleted };
}

/**
 * A plan file on disk, whose values are text or base64-wrapped bytes.
 *
 * JSON has no byte string, so a binary plan entry names its encoding rather than being guessed at
 * from its contents. The in-process type is `string | Uint8Array`; this is the same union in the
 * one place it has to survive a round trip through a file.
 */
const planSchema = z.record(
  z.string(),
  z.union([z.string(), z.object({ base64: z.string().min(1) })]),
);

function decodePlanContents(contents: string | { base64: string }): string | Uint8Array {
  if (typeof contents === 'string') return contents;
  return Uint8Array.from(atob(contents.base64), (character) => character.charCodeAt(0));
}

function readOption(argv: readonly string[], name: string): string {
  const index = argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : argv[index + 1];
  if (!value) throw new Error(`Missing required option --${name}`);
  return value;
}

/** Where the command line writes; tests pass collectors so the command runs in process. */
export type CommandWriters = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
};

const processWriters: CommandWriters = {
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
};

export async function runGuard(
  argv: readonly string[],
  writers: CommandWriters = processWriters,
): Promise<number> {
  try {
    const policy = await loadTargetOwnedPolicy();
    const target = readOption(argv, 'target');
    const directory = readOption(argv, 'directory');
    const plan = planSchema.parse(JSON.parse(await Bun.file(readOption(argv, 'plan')).text()));
    const { written } = await writeTransformOutput({
      policy,
      target,
      directory,
      files: Object.fromEntries(
        Object.entries(plan).map(([path, contents]) => [path, decodePlanContents(contents)]),
      ),
    });
    writers.stdout(`Wrote ${written.length} file(s) to ${directory}\n`);
    return 0;
  } catch (error) {
    writers.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (import.meta.main) process.exit(await runGuard(Bun.argv.slice(2)));
