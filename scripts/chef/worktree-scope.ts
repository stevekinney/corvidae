#!/usr/bin/env bun
// Chef worktree scope guard (OPS-76): captures a baseline of every non-ignored
// path in a Git worktree and rejects any changed path outside an explicit
// allowed path set. This is a detection gate, not prevention or a sandbox: it
// cannot stop a mutation and does not attribute who made one. It never changes
// repository content, and a failed verification never cleans anything up.
//
// Usage:
//   bun scripts/chef/worktree-scope.ts capture --configuration <json> --output <json>
//   bun scripts/chef/worktree-scope.ts verify --configuration <json> --before <json>
//   bun scripts/chef/worktree-scope.ts verify --capture <json>
//
// `verify --capture <json>` takes the capture file `capture` wrote (or `worktree.ts create
// --scope-output` wrote) as both the baseline and the configuration: the worktree root and allowed
// paths come from the capture. It cannot be combined with `--configuration` or `--before`.
//
// Exit codes: 0 accepted, 1 scope or evidence failure, 2 invalid CLI usage (an unknown command or
// option, a missing required option or value). The report is one JSON object on stdout.

import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, resolve as resolvePath, sep } from 'node:path';
import { parseOptions, requireOption, UsageError, type ParsedOptions } from './process-runner.ts';

export { UsageError };

export interface ScopeConfiguration {
  root: string;
  paths: string[];
}

export interface NormalizedScopeConfiguration {
  root: string;
  paths: string[];
}

export interface InventoryEntry {
  path: string;
  kind: 'file' | 'symlink';
  mode: number;
  sha256: string;
}

export interface ScopeEvidence {
  version: 1;
  captureId: string;
  capturedAt: string;
  head: string;
  root: string;
  paths: string[];
  entries: InventoryEntry[];
}

export interface ScopeReport {
  captureId: string;
  root: string;
  head: string;
  added: string[];
  changed: string[];
  removed: string[];
  outOfScope: string[];
  errors: string[];
}

export class ScopeError extends Error {}

const permissionMask = 0o777;

// --- Configuration --------------------------------------------------------------

function normalizeAllowedPath(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new UsageError(`allowed path must be a non-empty string, got: ${JSON.stringify(raw)}`);
  }
  if (raw.includes('\\')) throw new UsageError(`allowed path must not contain backslashes: ${raw}`);
  if (raw.startsWith('/'))
    throw new UsageError(`allowed path must be relative, got absolute path: ${raw}`);
  for (const segment of raw.split('/')) {
    if (segment.length === 0)
      throw new UsageError(`allowed path must not contain empty segments: ${raw}`);
    if (segment === '.')
      throw new UsageError(
        `allowed path must not contain '.' segments or allow the whole root: ${raw}`,
      );
    if (segment === '..')
      throw new UsageError(`allowed path must not contain '..' components: ${raw}`);
  }
  return raw;
}

function runGit(root: string, args: string[]): Buffer {
  const result = Bun.spawnSync(['git', '-C', root, ...args], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  if (result.exitCode !== 0) {
    throw new ScopeError(
      `git ${args.join(' ')} failed (exit ${result.exitCode}): ${result.stderr.toString().trim()}`,
    );
  }
  return Buffer.from(result.stdout);
}

export function normalizeConfiguration(config: ScopeConfiguration): NormalizedScopeConfiguration {
  if (
    !config ||
    typeof config !== 'object' ||
    typeof config.root !== 'string' ||
    config.root.length === 0
  ) {
    throw new UsageError('configuration.root must be a non-empty string');
  }
  if (!Array.isArray(config.paths)) {
    throw new UsageError('configuration.paths must be an array');
  }
  const paths = [...new Set(config.paths.map(normalizeAllowedPath))].toSorted();

  let root: string;
  try {
    root = realpathSync(config.root);
  } catch {
    throw new ScopeError(`configuration.root does not exist: ${config.root}`);
  }
  const topLevel = runGit(root, ['rev-parse', '--show-toplevel']).toString('utf8').trim();
  let canonicalTopLevel: string;
  try {
    canonicalTopLevel = realpathSync(topLevel);
  } catch {
    throw new ScopeError(`git reported a top level that does not exist: ${topLevel}`);
  }
  if (canonicalTopLevel !== root) {
    throw new ScopeError(
      `configuration.root must be the Git worktree top level ${canonicalTopLevel}, got ${root}`,
    );
  }
  return { root, paths };
}

function isAllowed(path: string, allowedPaths: string[]): boolean {
  return allowedPaths.some((allowed) => path === allowed || path.startsWith(`${allowed}/`));
}

// --- Inventory ------------------------------------------------------------------

function splitNull(buffer: Buffer): string[] {
  return buffer
    .toString('utf8')
    .split('\0')
    .filter((entry) => entry.length > 0);
}

function currentHead(root: string): string {
  return runGit(root, ['rev-parse', 'HEAD']).toString('utf8').trim();
}

/** Whether `ancestor` is reachable from `head`, so `head` only moved forward from it. */
function descendsFrom(root: string, head: string, ancestor: string): boolean {
  try {
    runGit(root, ['merge-base', '--is-ancestor', ancestor, head]);
    return true;
  } catch {
    return false;
  }
}

function assertNoSubmodules(root: string, listed: string[]) {
  const staged = splitNull(runGit(root, ['ls-files', '-z', '--stage']));
  for (const record of staged) {
    if (record.startsWith('160000 ')) {
      throw new ScopeError(
        `submodules are not supported; refusing gitlink: ${record.slice(record.indexOf('\t') + 1)}`,
      );
    }
  }
  for (const path of listed) {
    if (path.endsWith('/')) {
      throw new ScopeError(`nested repository or submodule is not supported; refusing: ${path}`);
    }
  }
}

function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function inventory(root: string): InventoryEntry[] {
  const listed = splitNull(
    runGit(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']),
  );
  assertNoSubmodules(root, listed);

  const entries: InventoryEntry[] = [];
  for (const path of [...new Set(listed)].toSorted()) {
    const absolute = `${root}${sep}${path}`;
    let stats;
    try {
      stats = lstatSync(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; // deleted tracked file: absent
      throw new ScopeError(`cannot stat path: ${path} (${String(error)})`);
    }
    try {
      if (stats.isSymbolicLink()) {
        entries.push({
          path,
          kind: 'symlink',
          mode: 0,
          sha256: hashBytes(readlinkSync(absolute, { encoding: 'buffer' })),
        });
      } else if (stats.isFile()) {
        entries.push({
          path,
          kind: 'file',
          mode: stats.mode & permissionMask,
          sha256: hashBytes(readFileSync(absolute)),
        });
      } else {
        throw new ScopeError(`unsupported filesystem entry type: ${path}`);
      }
    } catch (error) {
      if (error instanceof ScopeError) throw error;
      throw new ScopeError(`cannot read path: ${path} (${String(error)})`);
    }
  }
  return entries;
}

// --- Capture --------------------------------------------------------------------

function assertOutputOutsideWorktree(outputPath: string, root: string) {
  const absoluteOutput = resolvePath(outputPath);
  let canonicalParent: string;
  try {
    canonicalParent = realpathSync(dirname(absoluteOutput));
  } catch {
    throw new ScopeError(`output directory does not exist: ${dirname(absoluteOutput)}`);
  }
  const canonicalOutput = `${canonicalParent}${sep}${basename(absoluteOutput)}`;
  if (canonicalOutput === root || canonicalOutput.startsWith(`${root}${sep}`)) {
    throw new ScopeError(`output path must be outside the worktree: ${outputPath}`);
  }
}

export function capture(config: ScopeConfiguration, outputPath: string): ScopeEvidence {
  const normalized = normalizeConfiguration(config);
  assertOutputOutsideWorktree(outputPath, normalized.root);

  const evidence: ScopeEvidence = {
    version: 1,
    captureId: randomUUID(),
    capturedAt: new Date().toISOString(),
    head: currentHead(normalized.root),
    root: normalized.root,
    paths: normalized.paths,
    entries: inventory(normalized.root),
  };

  const absoluteOutput = resolvePath(outputPath);
  let descriptor: number;
  try {
    descriptor = openSync(absoluteOutput, 'wx');
  } catch (error) {
    throw new ScopeError(
      `evidence file already exists or cannot be created: ${outputPath} (${String(error)})`,
    );
  }
  try {
    writeFileSync(descriptor, JSON.stringify(evidence, null, 2));
  } catch (error) {
    closeSync(descriptor);
    try {
      unlinkSync(absoluteOutput);
    } catch {
      // best-effort cleanup of the incomplete file this invocation created
    }
    throw new ScopeError(`failed to write evidence file: ${outputPath} (${String(error)})`);
  }
  closeSync(descriptor);
  return evidence;
}

// --- Verify ---------------------------------------------------------------------

function isInventoryEntry(value: unknown): value is InventoryEntry {
  const entry = value as InventoryEntry;
  return (
    !!entry &&
    typeof entry.path === 'string' &&
    entry.path.length > 0 &&
    (entry.kind === 'file' || entry.kind === 'symlink') &&
    Number.isInteger(entry.mode) &&
    typeof entry.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(entry.sha256)
  );
}

export function readEvidence(path: string): ScopeEvidence {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new ScopeError(`cannot read evidence file: ${path} (${String(error)})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ScopeError(`evidence file is not valid JSON: ${path} (${String(error)})`);
  }
  const evidence = parsed as ScopeEvidence;
  const sortedPaths =
    Array.isArray(evidence?.paths) &&
    evidence.paths.every((entry) => typeof entry === 'string') &&
    evidence.paths.every((entry, index, all) => index === 0 || all[index - 1]! < entry);
  if (
    !evidence ||
    evidence.version !== 1 ||
    typeof evidence.captureId !== 'string' ||
    typeof evidence.capturedAt !== 'string' ||
    typeof evidence.head !== 'string' ||
    typeof evidence.root !== 'string' ||
    !sortedPaths ||
    !Array.isArray(evidence.entries) ||
    !evidence.entries.every(isInventoryEntry)
  ) {
    throw new ScopeError(`evidence file is not a recognized version-1 scope capture: ${path}`);
  }
  return evidence;
}

export function verify(config: ScopeConfiguration, before: ScopeEvidence): ScopeReport {
  const normalized = normalizeConfiguration(config);
  const errors: string[] = [];

  if (normalized.root !== before.root) {
    errors.push(`root differs from the captured baseline: ${normalized.root} vs ${before.root}`);
  }
  if (
    normalized.paths.length !== before.paths.length ||
    normalized.paths.some((path, index) => path !== before.paths[index])
  ) {
    errors.push(
      `allowed path set differs from the captured baseline; a scope expansion needs a new capture before further edits`,
    );
  }
  const head = currentHead(normalized.root);
  // A worker in a dedicated worktree commits its own work, so HEAD moving forward from the capture
  // is expected; the inventory below still compares every file's content, committed or not. Only a
  // HEAD that does not descend from the capture (a reset, a checkout of another branch) is an error.
  if (head !== before.head && !descendsFrom(normalized.root, head, before.head)) {
    errors.push(
      `HEAD does not descend from the captured baseline: ${head} is not after ${before.head}`,
    );
  }

  const beforeByPath = new Map(before.entries.map((entry) => [entry.path, entry]));
  const currentEntries = inventory(normalized.root);
  const currentByPath = new Map(currentEntries.map((entry) => [entry.path, entry]));

  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  for (const [path, entry] of currentByPath) {
    const previous = beforeByPath.get(path);
    if (!previous) added.push(path);
    else if (
      previous.kind !== entry.kind ||
      previous.mode !== entry.mode ||
      previous.sha256 !== entry.sha256
    )
      changed.push(path);
  }
  for (const path of beforeByPath.keys()) {
    if (!currentByPath.has(path)) removed.push(path);
  }
  added.sort();
  changed.sort();
  removed.sort();

  // Compare against the captured allowed paths, so a caller cannot widen the check by editing configuration.
  const outOfScope = [...added, ...changed, ...removed]
    .filter((path) => !isAllowed(path, before.paths))
    .toSorted();
  if (outOfScope.length > 0) {
    errors.push(`changed path(s) outside the allowed scope: ${outOfScope.join(', ')}`);
  }

  return {
    captureId: before.captureId,
    root: normalized.root,
    head,
    added,
    changed,
    removed,
    outOfScope,
    errors,
  };
}

// --- CLI ------------------------------------------------------------------------

/** The command and its options; an unknown command or option or a missing required one is a `UsageError`. */
export function parseCommandLine(argv: string[]): {
  command: 'capture' | 'verify';
  options: ParsedOptions;
} {
  const [command, ...rest] = argv;
  if (command !== 'capture' && command !== 'verify') {
    throw new UsageError(
      `unknown command: ${command ?? '<none>'}. Expected 'capture' or 'verify'.`,
    );
  }
  const options = parseOptions(rest, {
    values:
      command === 'capture' ? ['configuration', 'output'] : ['configuration', 'before', 'capture'],
  });
  if (options.positionals.length > 0)
    throw new UsageError(`unexpected argument: ${options.positionals[0]}`);
  // An option followed by another option has lost its value; `--output --configuration x` must not
  // create a file named `--configuration`.
  for (const [name, value] of Object.entries(options.values)) {
    if (value.startsWith('--')) throw new UsageError(`missing value for --${name}`);
  }
  if (command === 'verify' && options.values['capture'] !== undefined) {
    if (options.values['configuration'] !== undefined || options.values['before'] !== undefined)
      throw new UsageError('--capture replaces --configuration and --before; give one form.');
    return { command, options };
  }
  requireOption(options, 'configuration');
  requireOption(options, command === 'capture' ? 'output' : 'before');
  return { command, options };
}

function readConfiguration(flagValue: string): ScopeConfiguration {
  let raw: string;
  try {
    raw = readFileSync(flagValue, 'utf8');
  } catch {
    raw = flagValue;
  }
  try {
    return JSON.parse(raw) as ScopeConfiguration;
  } catch (error) {
    throw new UsageError(
      `--configuration is neither a readable JSON file nor inline JSON: ${flagValue} (${String(error)})`,
    );
  }
}

/** The configuration and baseline `verify` checks: from `--capture`, or `--configuration` and `--before`. */
export function resolveVerifyInputs(options: ParsedOptions): {
  configuration: ScopeConfiguration;
  before: ScopeEvidence;
} {
  const capturePath = options.values['capture'];
  if (capturePath !== undefined) {
    const before = readEvidence(capturePath);
    return { configuration: { root: before.root, paths: before.paths }, before };
  }
  return {
    configuration: readConfiguration(requireOption(options, 'configuration')),
    before: readEvidence(requireOption(options, 'before')),
  };
}

export function main(argv: string[]): number {
  try {
    const { command, options } = parseCommandLine(argv);

    if (command === 'capture') {
      const configuration = readConfiguration(requireOption(options, 'configuration'));
      const output = requireOption(options, 'output');
      const evidence = capture(configuration, output);
      console.log(
        JSON.stringify(
          {
            ok: true,
            captureId: evidence.captureId,
            head: evidence.head,
            output: resolvePath(output),
          },
          null,
          2,
        ),
      );
      return 0;
    }

    const inputs = resolveVerifyInputs(options);
    const report = verify(inputs.configuration, inputs.before);
    console.log(JSON.stringify(report, null, 2));
    return report.errors.length > 0 ? 1 : 0;
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`usage error: ${error.message}`);
      return 2;
    }
    if (error instanceof ScopeError) {
      console.error(`error: ${error.message}`);
      return 1;
    }
    console.error(`unexpected error: ${String(error)}`);
    return 2;
  }
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
