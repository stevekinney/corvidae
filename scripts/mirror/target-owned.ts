import { chmod, mkdir, rm } from 'node:fs/promises';
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

const policySchema = z.object({
  documentation: z.string().min(1),
  targets: z.array(targetName).min(1),
  paths: z.array(pathEntrySchema).min(1),
  insideFiles: z.object({
    policy: z.string().min(1),
    /** Manifest keys written from the transform's value, replacing whatever the target had. */
    manifestKeys: z.array(keyEntrySchema).min(1),
    /** Manifest keys the transform supplies only where the target carries none of its own. */
    manifestDefaults: z.array(keyEntrySchema).min(1),
    dependencies: z.object({ policy: z.string().min(1) }),
    /** Keys in an emitted `tsconfig*.json` that come from the transform. */
    typeScriptKeys: z.array(keyEntrySchema).min(1),
    /** Keys in an emitted `tsconfig*.json` read back out of the target's own. */
    typeScriptTargetOwned: z.array(keyEntrySchema).min(1),
  }),
  exceptions: z.object({ policy: z.string().min(1), entries: z.array(exceptionEntrySchema) }),
  openQuestions: z.array(z.string().min(1)),
});

export type TargetOwnedPolicy = z.infer<typeof policySchema>;
export type TargetOwnedPathEntry = z.infer<typeof pathEntrySchema>;
export type TargetOwnedExceptionEntry = z.infer<typeof exceptionEntrySchema>;

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
  return policySchema.parse(JSON.parse(text));
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

export async function runGuard(argv: readonly string[]): Promise<number> {
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
    process.stdout.write(`Wrote ${written.length} file(s) to ${directory}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (import.meta.main) process.exit(await runGuard(Bun.argv.slice(2)));
