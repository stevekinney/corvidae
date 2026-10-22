#!/usr/bin/env bun
// Chef review-boundary guard (OPS-60): captures a before/after inventory of a
// worker's assigned directory boundary and rejects any removed file that
// isn't explicitly accounted for by a reviewed deletion or move mapping.
//
// Usage:
//   bun scripts/chef/review-boundary.ts capture --configuration <json> --output <json>
//   bun scripts/chef/review-boundary.ts verify --configuration <json> --before <json> [--accounting <json>]
//
// Exit codes: 0 accepted, 1 an unaccounted removal or an evidence failure, 2 invalid CLI usage (an
// unknown command or option, a missing required option). The report is one JSON object on stdout.

import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, resolve as resolvePath, sep } from 'node:path';
import { parseOptions, requireOption, UsageError, type ParsedOptions } from './process-runner.ts';

export { UsageError };

export interface BoundaryConfiguration {
  root: string;
  directories: string[];
  exclusions: string[];
}

export interface NormalizedConfiguration {
  root: string;
  directories: string[];
  exclusions: string[];
}

export interface ManifestFile {
  path: string;
  sha256: string;
}

export interface Manifest {
  version: 1;
  captureId: string;
  capturedAt: string;
  root: string;
  directories: string[];
  exclusions: string[];
  files: ManifestFile[];
}

export interface AccountingEntry {
  path: string;
  reason: string;
}

export interface MoveEntry {
  from: string;
  to: string[];
  reason: string;
}

export interface Accounting {
  captureId: string;
  removals: AccountingEntry[];
  moves: MoveEntry[];
}

export interface VerificationReport {
  captureId: string;
  root: string;
  added: string[];
  modified: string[];
  removed: string[];
  accounted: string[];
  unaccounted: string[];
  errors: string[];
}

export class BoundaryError extends Error {}

// --- Path normalization -----------------------------------------------------

export function normalizeRelativePath(
  raw: string,
  options: { allowDotAsWhole?: boolean } = {},
): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new BoundaryError(`path must be a non-empty string, got: ${JSON.stringify(raw)}`);
  }
  if (raw.includes('\\')) {
    throw new BoundaryError(`path must not contain backslashes: ${raw}`);
  }
  if (raw.startsWith('/')) {
    throw new BoundaryError(`path must be relative, got absolute path: ${raw}`);
  }
  if (raw === '.') {
    if (!options.allowDotAsWhole) {
      throw new BoundaryError(`'.' is only permitted as a directory boundary: ${raw}`);
    }
    return '.';
  }
  const segments = raw.split('/');
  for (const segment of segments) {
    if (segment.length === 0) {
      throw new BoundaryError(`path must not contain empty segments: ${raw}`);
    }
    if (segment === '..') {
      throw new BoundaryError(`path must not contain '..' components: ${raw}`);
    }
  }
  return segments.join('/');
}

function collapseNestedDirectories(directories: string[]): string[] {
  if (directories.includes('.')) {
    return ['.'];
  }
  const sorted = [...new Set(directories)].toSorted();
  const collapsed: string[] = [];
  for (const candidate of sorted) {
    const isCoveredByAncestor = collapsed.some(
      (ancestor) => candidate === ancestor || candidate.startsWith(`${ancestor}/`),
    );
    if (!isCoveredByAncestor) {
      collapsed.push(candidate);
    }
  }
  return collapsed;
}

export function normalizeConfiguration(config: BoundaryConfiguration): NormalizedConfiguration {
  if (!config || typeof config.root !== 'string' || config.root.length === 0) {
    throw new BoundaryError('configuration.root must be a non-empty string');
  }
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(config.root);
  } catch {
    throw new BoundaryError(`configuration.root does not exist: ${config.root}`);
  }
  if (!lstatSync(canonicalRoot).isDirectory()) {
    throw new BoundaryError(`configuration.root is not a directory: ${config.root}`);
  }

  const directories = collapseNestedDirectories(
    (config.directories ?? []).map((d) => normalizeRelativePath(d, { allowDotAsWhole: true })),
  );
  const exclusions = [
    ...new Set((config.exclusions ?? []).map((e) => normalizeRelativePath(e))),
  ].toSorted();

  return { root: canonicalRoot, directories, exclusions };
}

function isExcluded(relativePath: string, exclusions: string[]): boolean {
  return exclusions.some(
    (excluded) => relativePath === excluded || relativePath.startsWith(`${excluded}/`),
  );
}

function configurationsMatch(a: NormalizedConfiguration, b: NormalizedConfiguration): boolean {
  return (
    a.root === b.root &&
    a.directories.length === b.directories.length &&
    a.directories.every((d, i) => d === b.directories[i]) &&
    a.exclusions.length === b.exclusions.length &&
    a.exclusions.every((e, i) => e === b.exclusions[i])
  );
}

// --- Filesystem traversal ----------------------------------------------------

function sha256File(absolutePath: string): string {
  const hash = createHash('sha256');
  hash.update(readFileSync(absolutePath));
  return hash.digest('hex');
}

function walkBoundary(normalized: NormalizedConfiguration): {
  files: ManifestFile[];
  errors: string[];
} {
  const files: ManifestFile[] = [];
  const errors: string[] = [];
  const visited = new Set<string>();

  const visit = (relativePath: string) => {
    if (visited.has(relativePath)) return;
    visited.add(relativePath);

    if (isExcluded(relativePath, normalized.exclusions)) {
      return;
    }

    const absolutePath =
      relativePath === '.' ? normalized.root : `${normalized.root}${sep}${relativePath}`;
    const stats = lstatSync(absolutePath);

    if (stats.isSymbolicLink()) {
      errors.push(`symlink is not permitted inside the review boundary: ${relativePath}`);
      return;
    }

    if (stats.isDirectory()) {
      const entries = readdirSync(absolutePath).toSorted();
      for (const entry of entries) {
        const childRelative = relativePath === '.' ? entry : `${relativePath}/${entry}`;
        visit(childRelative);
      }
      return;
    }

    if (stats.isFile()) {
      files.push({ path: relativePath, sha256: sha256File(absolutePath) });
      return;
    }

    errors.push(`unsupported filesystem entry type inside the review boundary: ${relativePath}`);
  };

  for (const directory of normalized.directories) {
    visit(directory);
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, errors };
}

// --- Capture ------------------------------------------------------------------

function outputEscapesBoundary(outputPath: string, normalized: NormalizedConfiguration): boolean {
  const absoluteOutput = resolvePath(outputPath);
  const canonicalParent = realpathSync(dirname(absoluteOutput));
  const canonicalOutput = `${canonicalParent}${sep}${basename(absoluteOutput)}`;
  const boundaries =
    normalized.directories[0] === '.'
      ? [normalized.root]
      : normalized.directories.map((d) => `${normalized.root}${sep}${d}`);
  return boundaries.some(
    (boundary) => canonicalOutput === boundary || canonicalOutput.startsWith(`${boundary}${sep}`),
  );
}

export function capture(config: BoundaryConfiguration, outputPath: string): Manifest {
  const normalized = normalizeConfiguration(config);

  if (outputEscapesBoundary(outputPath, normalized)) {
    throw new BoundaryError(`output path must be outside all included boundaries: ${outputPath}`);
  }

  const { files, errors } = walkBoundary(normalized);
  if (errors.length > 0) {
    throw new BoundaryError(`capture failed:\n${errors.join('\n')}`);
  }

  const manifest: Manifest = {
    version: 1,
    captureId: randomUUID(),
    capturedAt: new Date().toISOString(),
    root: normalized.root,
    directories: normalized.directories,
    exclusions: normalized.exclusions,
    files,
  };

  const serialized = JSON.stringify(manifest, null, 2);
  const absoluteOutput = resolvePath(outputPath);
  let createdFd: number | undefined;
  try {
    createdFd = openSync(absoluteOutput, 'wx');
  } catch (error) {
    throw new BoundaryError(
      `evidence file already exists or cannot be created: ${outputPath} (${String(error)})`,
    );
  }
  try {
    writeFileSync(createdFd, serialized);
  } catch (error) {
    closeSync(createdFd);
    try {
      unlinkSync(absoluteOutput);
    } catch {
      // best-effort cleanup of the incomplete file created by this invocation
    }
    throw new BoundaryError(`failed to write evidence file: ${outputPath} (${String(error)})`);
  }
  closeSync(createdFd);

  return manifest;
}

// --- Verify -------------------------------------------------------------------

export function readManifest(path: string): Manifest {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new BoundaryError(`cannot read evidence file: ${path} (${String(error)})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new BoundaryError(`evidence file is not valid JSON: ${path} (${String(error)})`);
  }
  const manifest = parsed as Manifest;
  if (
    manifest.version !== 1 ||
    !Array.isArray(manifest.files) ||
    typeof manifest.captureId !== 'string'
  ) {
    throw new BoundaryError(`evidence file is not a recognized version-1 manifest: ${path}`);
  }
  return manifest;
}

export function verify(
  config: BoundaryConfiguration,
  beforeManifest: Manifest,
  accounting?: Accounting,
): VerificationReport {
  const errors: string[] = [];
  const normalized = normalizeConfiguration(config);
  const beforeNormalized: NormalizedConfiguration = {
    root: beforeManifest.root,
    directories: beforeManifest.directories,
    exclusions: beforeManifest.exclusions,
  };

  if (!configurationsMatch(normalized, beforeNormalized)) {
    errors.push(
      `supplied configuration does not match the captured boundary (root/directories/exclusions differ)`,
    );
  }

  const { files: currentFiles, errors: walkErrors } = walkBoundary(normalized);
  errors.push(...walkErrors);

  const beforeByPath = new Map(beforeManifest.files.map((f) => [f.path, f.sha256]));
  const currentByPath = new Map(currentFiles.map((f) => [f.path, f.sha256]));

  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];

  for (const [path, sha256] of currentByPath) {
    if (!beforeByPath.has(path)) {
      added.push(path);
    } else if (beforeByPath.get(path) !== sha256) {
      modified.push(path);
    }
  }
  for (const path of beforeByPath.keys()) {
    if (!currentByPath.has(path)) {
      removed.push(path);
    }
  }
  added.sort();
  modified.sort();
  removed.sort();

  const accounted = new Set<string>();

  if (accounting) {
    if (accounting.captureId !== beforeManifest.captureId) {
      errors.push(
        `accounting captureId '${accounting.captureId}' does not match evidence captureId '${beforeManifest.captureId}'`,
      );
    } else {
      const seenPaths = new Set<string>();
      const removedSet = new Set(removed);

      for (const entry of accounting.removals) {
        if (!entry.reason || entry.reason.trim().length === 0) {
          errors.push(`removal accounting entry for '${entry.path}' has an empty reason`);
        }
        if (seenPaths.has(entry.path)) {
          errors.push(`duplicate accounting entry for path: ${entry.path}`);
          continue;
        }
        seenPaths.add(entry.path);
        if (!beforeByPath.has(entry.path)) {
          errors.push(
            `removal accounting entry names a path absent from the captured boundary: ${entry.path}`,
          );
          continue;
        }
        if (!removedSet.has(entry.path)) {
          errors.push(
            `unused removal accounting entry (path was not actually removed): ${entry.path}`,
          );
          continue;
        }
        accounted.add(entry.path);
      }

      for (const move of accounting.moves) {
        if (!move.reason || move.reason.trim().length === 0) {
          errors.push(`move accounting entry for '${move.from}' has an empty reason`);
        }
        if (seenPaths.has(move.from)) {
          errors.push(`duplicate accounting entry for path: ${move.from}`);
          continue;
        }
        seenPaths.add(move.from);
        if (!beforeByPath.has(move.from)) {
          errors.push(
            `move accounting entry names a source absent from the captured boundary: ${move.from}`,
          );
          continue;
        }
        if (!removedSet.has(move.from)) {
          errors.push(
            `unused move accounting entry (source was not actually removed): ${move.from}`,
          );
          continue;
        }
        if (!move.to || move.to.length === 0) {
          errors.push(`move accounting entry for '${move.from}' names no destination`);
          continue;
        }
        const validDestinations = move.to.filter((dest) => currentByPath.has(dest));
        if (validDestinations.length === 0) {
          errors.push(
            `move accounting entry for '${move.from}' names no destination present in the current inventory: ${move.to.join(', ')}`,
          );
          continue;
        }
        accounted.add(move.from);
      }
    }
  }

  const unaccounted = removed.filter((path) => !accounted.has(path));
  if (unaccounted.length > 0) {
    errors.push(`unaccounted removed file(s): ${unaccounted.join(', ')}`);
  }

  return {
    captureId: beforeManifest.captureId,
    root: normalized.root,
    added,
    modified,
    removed,
    accounted: [...accounted].toSorted(),
    unaccounted,
    errors,
  };
}

// --- CLI ------------------------------------------------------------------

function readJsonArgument(flagValue: string, flagName: string): unknown {
  try {
    return JSON.parse(readFileSync(flagValue, 'utf8'));
  } catch {
    try {
      return JSON.parse(flagValue);
    } catch (error) {
      throw new BoundaryError(
        `--${flagName} is neither a readable JSON file nor inline JSON: ${flagValue} (${String(error)})`,
      );
    }
  }
}

/** The command and its options; an unknown command or option or a missing required one is a `UsageError`. */
export function parseCommandLine(argv: string[]): {
  command: 'capture' | 'verify';
  options: ParsedOptions;
} {
  const [command, ...rest] = argv;
  if (command !== 'capture' && command !== 'verify')
    throw new UsageError(
      `unknown command: ${command ?? '<none>'}. Expected 'capture' or 'verify'.`,
    );
  const options = parseOptions(rest, {
    values:
      command === 'capture'
        ? ['configuration', 'output']
        : ['configuration', 'before', 'accounting'],
  });
  if (options.positionals.length > 0)
    throw new UsageError(`unexpected argument: ${options.positionals[0]}`);
  // An option followed by another option has lost its value; `--output --configuration x` must not
  // create a file named `--configuration`.
  for (const [name, value] of Object.entries(options.values)) {
    if (value.startsWith('--')) throw new UsageError(`missing value for --${name}`);
  }
  requireOption(options, 'configuration');
  requireOption(options, command === 'capture' ? 'output' : 'before');
  return { command, options };
}

export function main(argv: string[]): number {
  try {
    const { command, options } = parseCommandLine(argv);
    const config = readJsonArgument(
      requireOption(options, 'configuration'),
      'configuration',
    ) as BoundaryConfiguration;

    if (command === 'capture') {
      const output = requireOption(options, 'output');
      const manifest = capture(config, output);
      console.log(
        JSON.stringify(
          { ok: true, captureId: manifest.captureId, output: resolvePath(output) },
          null,
          2,
        ),
      );
      return 0;
    }

    const beforeManifest = readManifest(requireOption(options, 'before'));
    const accounting =
      options.values['accounting'] === undefined || options.values['accounting'] === ''
        ? undefined
        : (readJsonArgument(options.values['accounting'], 'accounting') as Accounting);
    const report = verify(config, beforeManifest, accounting);
    console.log(JSON.stringify(report, null, 2));
    return report.errors.length > 0 ? 1 : 0;
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`usage error: ${error.message}`);
      return 2;
    }
    if (error instanceof BoundaryError) {
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
