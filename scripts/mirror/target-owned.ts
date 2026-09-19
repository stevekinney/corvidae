import { mkdir } from 'node:fs/promises';
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

const fieldEntrySchema = z.object({
  file: z.string().min(1),
  pointer: z.string().startsWith('/'),
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
  fields: z.object({ policy: z.string().min(1), entries: z.array(fieldEntrySchema) }),
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

export class TargetOwnedViolation extends Error {
  readonly matches: readonly TargetOwnedMatch[];
  readonly expired: readonly TargetOwnedExceptionEntry[];

  constructor(matches: readonly TargetOwnedMatch[], expired: readonly TargetOwnedExceptionEntry[]) {
    super(describeViolation(matches, expired));
    this.name = 'TargetOwnedViolation';
    this.matches = matches;
    this.expired = expired;
  }
}

function describeViolation(
  matches: readonly TargetOwnedMatch[],
  expired: readonly TargetOwnedExceptionEntry[],
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
    lines.push('The mirror transform must not write these target-owned paths:');
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
};

/** Throws `TargetOwnedViolation` when any path is target-owned or any exception has expired. */
export function assertWritablePaths({
  policy,
  target,
  paths,
  now = new Date(),
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
  if (matches.length > 0 || expired.length > 0) throw new TargetOwnedViolation(matches, expired);
}

export type TransformOutput = {
  policy: TargetOwnedPolicy;
  target: string;
  directory: string;
  /** Target-relative path to file contents. */
  files: Readonly<Record<string, string>>;
  now?: Date;
};

/**
 * Writes transform output into a target clone, but only after the whole plan clears the guard.
 * Checking every path up front is what makes a refusal leave the target byte-identical: a
 * per-file check would already have written the files preceding the offending one.
 */
export async function writeTransformOutput({
  policy,
  target,
  directory,
  files,
  now = new Date(),
}: TransformOutput): Promise<string[]> {
  const entries = Object.entries(files);
  assertWritablePaths({ policy, target, paths: entries.map(([path]) => path), now });
  const written: string[] = [];
  for (const [path, contents] of entries) {
    const destination = join(directory, normalizeTargetPath(path));
    await mkdir(dirname(destination), { recursive: true });
    await Bun.write(destination, contents);
    written.push(relative(directory, destination).split(sep).join('/'));
  }
  return written;
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
    const plan = z
      .record(z.string(), z.string())
      .parse(JSON.parse(await Bun.file(readOption(argv, 'plan')).text()));
    const written = await writeTransformOutput({ policy, target, directory, files: plan });
    process.stdout.write(`Wrote ${written.length} file(s) to ${directory}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (import.meta.main) process.exit(await runGuard(Bun.argv.slice(2)));
