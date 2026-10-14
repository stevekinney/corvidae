import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { loadPackageMap } from './package-map.ts';
import { targetFor, type MirrorTarget } from './target-definitions.ts';

/**
 * Validation for the changesets corvidae authors under `.changeset/`.
 *
 * A corvidae changeset is release intent: standard changeset Markdown that the mirror sync copies
 * into the one target it names, where that target's own Changesets flow versions and publishes it.
 * Corvidae has no `@changesets/*` dependency (`workspace-contract.test.ts` forbids it), so this
 * module is the whole gate: it is deliberately stricter than the real parser, because a mistake
 * found here costs nothing and the same mistake found in a mirror costs a pull request there.
 */

export class ChangesetError extends Error {}

export type ChangesetBump = 'patch' | 'minor' | 'major';

export interface ParsedChangeset {
  bumps: { name: string; bump: ChangesetBump }[];
  body: string;
}

const bumpLevels: readonly string[] = ['patch', 'minor', 'major'];

/** `"name": bump` or `'name': bump`, or an unquoted name; the opening and closing quote must match. */
const bumpLine =
  /^(?:(["'])(?<quoted>[^"'\s]+)\1|(?<bare>[A-Za-z0-9][A-Za-z0-9._~-]*)):\s*(?<bump>\S+)$/;

/** Parse standard changeset Markdown, rejecting everything a mirror's tooling would not take. */
export function parseChangeset(text: string): ParsedChangeset {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  if (lines[0] !== '---') throw new ChangesetError('A changeset must start with "---" frontmatter');
  const close = lines.indexOf('---', 1);
  if (close === -1)
    throw new ChangesetError('A changeset\'s frontmatter is never closed with "---"');
  const frontmatter = lines.slice(1, close);
  if (frontmatter.length === 0) throw new ChangesetError("A changeset's frontmatter is empty");

  const bumps: ParsedChangeset['bumps'] = [];
  for (const line of frontmatter) {
    const match = bumpLine.exec(line);
    const name = match?.groups?.['quoted'] ?? match?.groups?.['bare'];
    const bump = match?.groups?.['bump'];
    if (name === undefined || bump === undefined) {
      throw new ChangesetError(
        `Unreadable frontmatter line "${line}"; expected "<npm name>": patch|minor|major (comments and blank lines are not allowed)`,
      );
    }
    if (!bumpLevels.includes(bump)) {
      throw new ChangesetError(
        `"${name}" has the bump "${bump}"; only patch, minor and major are allowed`,
      );
    }
    if (bumps.some((entry) => entry.name === name)) {
      throw new ChangesetError(`"${name}" appears more than once in one changeset`);
    }
    bumps.push({ name, bump: bump as ChangesetBump });
  }

  const body = lines.slice(close + 1).join('\n');
  if (body.trim().length === 0) throw new ChangesetError('A changeset needs a non-empty body');
  return { bumps, body };
}

/**
 * The single target a parsed changeset releases from.
 *
 * Every name must be the npm name of a `publish-as` workspace: a private workspace never reaches
 * a registry and an orphan has no source, so a changeset naming either describes a release that
 * cannot happen. All names must share one target because a changeset is copied into exactly one
 * mirror, and cross-target releases stay manually ordered.
 */
export async function targetOfChangeset(parsed: ParsedChangeset): Promise<MirrorTarget> {
  const map = await loadPackageMap();
  const workspaceByName = new Map<string, string>();
  for (const [workspace, entry] of Object.entries(map.workspaces)) {
    if (entry.disposition === 'publish-as') workspaceByName.set(entry.name, workspace);
  }
  const targets = new Set<MirrorTarget>();
  for (const { name } of parsed.bumps) {
    const workspace = workspaceByName.get(name);
    if (workspace === undefined) {
      throw new ChangesetError(
        `"${name}" is not the npm name of a publish-as workspace in package-map.json`,
      );
    }
    targets.add(targetFor(workspace));
  }
  if (targets.size !== 1) {
    throw new ChangesetError(
      `A changeset names exactly one target, found ${[...targets].toSorted().join(' and ')}; split it into one file per target`,
    );
  }
  return [...targets][0]!;
}

/** Parse and resolve one changeset; `file` only decorates the error. */
export async function validateChangeset(text: string, file?: string): Promise<MirrorTarget> {
  try {
    return await targetOfChangeset(parseChangeset(text));
  } catch (error) {
    if (file !== undefined && error instanceof ChangesetError) {
      throw new ChangesetError(`${file}: ${error.message}`);
    }
    throw error;
  }
}

/** The `.changeset/*.md` paths in a corvidae checkout other than the README, sorted. */
export async function listChangesetFiles(root: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(join(root, '.changeset'));
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.endsWith('.md') && entry !== 'README.md')
    .toSorted()
    .map((entry) => `.changeset/${entry}`);
}

/**
 * A changeset file's name must be conservative: lowercase letters, digits, dots, underscores and
 * hyphens, starting with a letter or digit. Git reads paths as patterns unless told otherwise, the
 * emitted name is built from this one, and a name no tool can mistake for something else is cheaper
 * than a rule about which characters are dangerous where.
 */
export function assertChangesetFileName(path: string): void {
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (name === 'README.md') return;
  // Emission prepends `corvidae-<12 hex>-` (22 bytes); 200 leaves the result well under the
  // 255-byte limit on a path component.
  if (name.length > 200) {
    throw new ChangesetError(
      `${path}: the filename is ${name.length} characters; the limit is 200 characters, so the emitted corvidae-<12 hex>-<name> stays under 255 bytes`,
    );
  }
  if (!/^[a-z0-9][a-z0-9._-]*\.md$/.test(name)) {
    throw new ChangesetError(
      `${path}: the filename must be lowercase letters, digits, dots, underscores and hyphens, start with a letter or digit, and end in .md (^[a-z0-9][a-z0-9._-]*\\.md$)`,
    );
  }
}
