/**
 * The plugin identity guard (COR-1883), run by `lint:root`.
 *
 * A plugin commits `plugin-identities.json` beside its `package.json`: its name and version, and
 * for its configuration and every contribution a record, file or setting can name, the id, the
 * version and a digest of the schema. Durable records pin an id and a version, so a schema that
 * changes under a version it already shipped would be read by records written against the old one.
 * The guard fails when:
 *
 * - a `plugins/*` workspace has no `plugin-identities.json`, or the file is not valid;
 * - the file no longer matches the plugin it describes (run with `--write` to refresh it);
 * - a digest differs from the same file at the baseline ref while the version does not.
 *
 * The baseline ref is `CORVIDAE_PLUGIN_IDENTITY_BASE` when set, otherwise `origin/main`. A ref
 * that does not resolve fails the guard and names that variable; it never skips. A workspace
 * whose file is absent at the baseline is a new plugin and passes. A repository with no
 * `plugins/*` workspace has nothing to compare and passes.
 *
 * `bun scripts/check-plugin-identities.ts` checks every `plugins/*` workspace under the repository;
 * `--write <workspace>` writes or refreshes one workspace's file; `--root <directory>` runs against
 * another repository, which the tests use for fixture baselines.
 */
import { existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { workspaceChildDirectoryNames } from './workspace-directories.ts';

/** The variable that names the baseline ref. */
export const baselineVariable = 'CORVIDAE_PLUGIN_IDENTITY_BASE';

/** The ref compared against when {@link baselineVariable} is not set. */
export const defaultBaseline = 'origin/main';

/** The name of the file every plugin workspace commits. */
export const identitiesFileName = 'plugin-identities.json';

/** One identity in a snapshot; the shape `packages/interborough-plugin` writes. */
export interface IdentityEntry {
  readonly kind: string;
  readonly id: string;
  readonly version: string;
  readonly schema: string | null;
}

/** A plugin's committed snapshot. */
export interface IdentitySnapshot {
  readonly plugin: string;
  readonly version: string;
  readonly entries: readonly IdentityEntry[];
}

const repositoryRoot = resolve(import.meta.dir, '..');
const identityRunner = join(
  repositoryRoot,
  'packages/interborough-plugin/scripts/plugin-identities.ts',
);

function isEntry(value: unknown): value is IdentityEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry['kind'] === 'string' &&
    typeof entry['id'] === 'string' &&
    typeof entry['version'] === 'string' &&
    (entry['schema'] === null || typeof entry['schema'] === 'string')
  );
}

/** The snapshot `text` holds, or why it is not one. */
export function parseSnapshot(text: string): IdentitySnapshot | string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return `is not valid JSON (${error instanceof Error ? error.message : String(error)})`;
  }
  const snapshot = value as Record<string, unknown> | null;
  const entries = snapshot?.['entries'];
  if (
    typeof snapshot !== 'object' ||
    snapshot === null ||
    typeof snapshot['plugin'] !== 'string' ||
    typeof snapshot['version'] !== 'string' ||
    !Array.isArray(entries) ||
    !entries.every(isEntry)
  ) {
    return 'must hold { plugin, version, entries: [{ kind, id, version, schema }] }';
  }
  return { plugin: snapshot['plugin'], version: snapshot['version'], entries };
}

/**
 * Every way `current` changes a shape that `baseline` already shipped: an entry present in both
 * whose schema digest differs while its version is the same. A new entry, a removed entry and a
 * changed version are not violations here.
 */
export function compareIdentities(baseline: IdentitySnapshot, current: IdentitySnapshot): string[] {
  const before = new Map(baseline.entries.map((entry) => [`${entry.kind} ${entry.id}`, entry]));
  const violations: string[] = [];
  for (const entry of current.entries) {
    const shipped = before.get(`${entry.kind} ${entry.id}`);
    if (shipped === undefined) continue;
    if (shipped.schema !== entry.schema && shipped.version === entry.version) {
      violations.push(
        `The ${entry.kind} "${entry.id}" changed its schema at version ${entry.version}; bump its version (or its plugin's, when it declares none) and refresh ${identitiesFileName}.`,
      );
    }
  }
  return violations;
}

async function git(root: string, args: readonly string[]): Promise<{ ok: boolean; text: string }> {
  const child = Bun.spawn(['git', '-C', root, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [text] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return { ok: child.exitCode === 0, text };
}

/** The live identities of the plugin in `workspace`, or the reason they could not be read. */
async function liveIdentities(workspace: string): Promise<IdentitySnapshot | string> {
  const child = Bun.spawn([process.execPath, identityRunner, workspace], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [output, errors] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (child.exitCode !== 0)
    return `could not read its identities: ${errors.trim() || output.trim()}`;
  const parsed = parseSnapshot(output);
  return typeof parsed === 'string' ? `produced an unreadable snapshot: ${parsed}` : parsed;
}

function serialize(snapshot: IdentitySnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

/** The plugin workspaces under `root`, as paths relative to it. */
export function pluginWorkspaces(root: string): string[] {
  return workspaceChildDirectoryNames(root, 'plugins')
    .filter((name) => existsSync(join(root, 'plugins', name, 'package.json')))
    .map((name) => `plugins/${name}`);
}

/** Writes or refreshes `workspace`'s file from its plugin. Returns the problem, if any. */
export async function writeIdentities(
  root: string,
  workspace: string,
): Promise<string | undefined> {
  const directory = join(root, workspace);
  if (!existsSync(join(directory, 'package.json'))) {
    return `${workspace} has no package.json; name a plugin workspace such as plugins/example.`;
  }
  const live = await liveIdentities(directory);
  if (typeof live === 'string') return `${workspace} ${live}`;
  await Bun.write(join(directory, identitiesFileName), serialize(live));
  return undefined;
}

/** Everything the guard finds wrong under `root`; empty when it passes. */
export async function checkPluginIdentities(
  root: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string[]> {
  const workspaces = pluginWorkspaces(root);
  if (workspaces.length === 0) return [];
  const baseline = environment[baselineVariable] || defaultBaseline;
  const resolved = await git(root, ['rev-parse', '--verify', '--quiet', `${baseline}^{commit}`]);
  if (!resolved.ok) {
    return [
      `The baseline ref "${baseline}" does not resolve. Set ${baselineVariable} to a ref that exists in this checkout (HEAD compares a plugin with itself); the guard never skips the comparison.`,
    ];
  }
  const problems: string[] = [];
  for (const workspace of workspaces) {
    const file = join(root, workspace, identitiesFileName);
    const refresh = `run \`bun scripts/check-plugin-identities.ts --write ${workspace}\``;
    if (!existsSync(file)) {
      problems.push(`${workspace} has no ${identitiesFileName}; ${refresh}.`);
      continue;
    }
    const current = parseSnapshot(await Bun.file(file).text());
    if (typeof current === 'string') {
      problems.push(`${workspace}/${identitiesFileName} ${current}; ${refresh}.`);
      continue;
    }
    const live = await liveIdentities(join(root, workspace));
    if (typeof live === 'string') {
      problems.push(`${workspace} ${live}`);
    } else if (serialize(live) !== serialize(current)) {
      problems.push(
        `${workspace}/${identitiesFileName} is out of date with its plugin; ${refresh}.`,
      );
    }
    const path = relative(root, file);
    const previous = await git(root, ['show', `${baseline}:./${path}`]);
    if (!previous.ok) continue;
    const shipped = parseSnapshot(previous.text);
    if (typeof shipped === 'string') {
      problems.push(`${path} at ${baseline} ${shipped}.`);
      continue;
    }
    for (const violation of compareIdentities(shipped, current)) {
      problems.push(`${workspace}: ${violation}`);
    }
  }
  return problems;
}

if (import.meta.main) {
  const argumentsList = process.argv.slice(2);
  const take = (flag: string): string | undefined => {
    const index = argumentsList.indexOf(flag);
    return index === -1 ? undefined : argumentsList[index + 1];
  };
  const root = resolve(take('--root') ?? repositoryRoot);
  const write = take('--write');
  if (argumentsList.includes('--write') && write === undefined) {
    process.stderr.write('--write needs a plugin workspace, such as plugins/example.\n');
    process.exitCode = 2;
  } else if (write !== undefined) {
    const problem = await writeIdentities(root, write);
    if (problem !== undefined) {
      process.stderr.write(`${problem}\n`);
      process.exitCode = 1;
    }
  } else {
    const problems = await checkPluginIdentities(root);
    for (const problem of problems) process.stderr.write(`${problem}\n`);
    process.exitCode = problems.length === 0 ? 0 : 1;
  }
}
