import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { targetDirectoryFor } from './layout-map.ts';
import { publicNameFor, targetFor, type MirrorTarget } from './manifests.ts';
import { dispositionFor } from './package-map.ts';
import type { EmittedWorkspace } from './source.ts';

/**
 * How `@corvidae/typescript` reaches each target.
 *
 * Every workspace's tsconfig extends it by specifier, and what it carries is load-bearing:
 * `exactOptionalPropertyTypes` alone is why weft's source differs from upstream's in hundreds of
 * files. Dropping the configuration makes a target's build drift on the first sync.
 *
 * The two targets need different answers because they are shaped differently.
 *
 * - The cinder target is a workspace, so it can hold the package. Only the scope in the `extends`
 *   specifier is rewritten, from `@corvidae/typescript` to the public name the map derives.
 * - The weft target is a single package with no sibling to install from, so the configuration is
 *   vendored to a path inside that package and the `extends` specifier becomes relative. COR-1188
 *   drops weft's `devDependencies` edge to `@corvidae/typescript` and reports it as dropped;
 *   vendoring is what closes it, and `assertTypeScriptEdgeClosed` checks that it did.
 *
 * All three files are vendored, not just the reachable ones. `library.json` extends `./base.json`,
 * so partial vendoring is a reachability computation over three small files with nothing to gain.
 */

export class TypeScriptConfigurationError extends Error {}

/** The corvidae workspace holding the shared configuration. */
export const configurationWorkspace = '@corvidae/typescript';

/** The files `@corvidae/typescript` is made of. `base.json` is private composition. */
export const configurationFiles = ['base.json', 'library.json', 'browser.json'] as const;

/** Where the weft target keeps its vendored copy, relative to the package that extends it. */
export const vendoredDirectory = 'typescript';

type JsonObject = Record<string, unknown>;

/** Whether the target can hold `@corvidae/typescript` as a workspace of its own. */
export function vendorsConfiguration(target: MirrorTarget): boolean {
  return targetFor(configurationWorkspace) !== target;
}

/**
 * Rewrite one `extends` value. A specifier into the configuration package becomes either the
 * public specifier or a relative path into the vendored copy; anything else is left alone,
 * because a relative `extends` inside a workspace still resolves after the sync.
 */
export function rewriteExtends(
  value: string,
  publicName: string,
  vendor: boolean,
  depthFromPackageRoot = 0,
): string {
  if (value !== configurationWorkspace && !value.startsWith(`${configurationWorkspace}/`)) {
    return value;
  }
  const suffix = value.slice(configurationWorkspace.length).replace(/^\//, '');
  if (!vendor) return suffix ? `${publicName}/${suffix}` : publicName;
  if (!suffix) {
    throw new TypeScriptConfigurationError(
      `A tsconfig extends "${configurationWorkspace}" with no file; the package exports only ${configurationFiles.join(', ')}`,
    );
  }
  const prefix = depthFromPackageRoot === 0 ? './' : '../'.repeat(depthFromPackageRoot);
  return `${prefix}${vendoredDirectory}/${suffix}`;
}

function rewriteExtendsField(
  configuration: JsonObject,
  publicName: string,
  vendor: boolean,
): JsonObject {
  const value = configuration['extends'];
  if (typeof value === 'string') {
    return { ...configuration, extends: rewriteExtends(value, publicName, vendor) };
  }
  if (Array.isArray(value)) {
    return {
      ...configuration,
      extends: value.map((entry) =>
        typeof entry === 'string' ? rewriteExtends(entry, publicName, vendor) : entry,
      ),
    };
  }
  return { ...configuration };
}

/** Every `tsconfig*.json` a workspace directory carries, sorted. */
export async function discoverConfigurations(workspaceDirectory: string): Promise<string[]> {
  const entries = await readdir(workspaceDirectory, { withFileTypes: true }).catch(() => []);
  return entries
    .filter(
      (entry) =>
        entry.isFile() && entry.name.startsWith('tsconfig') && entry.name.endsWith('.json'),
    )
    .map((entry) => entry.name)
    .toSorted();
}

export interface TypeScriptPlanOptions {
  corvidaeRoot: string;
  target: MirrorTarget;
  /**
   * One entry per workspace the target receives. Both directories are needed and they differ:
   * the configuration is read from corvidae's directory and emitted into the target's.
   */
  workspaces: readonly Pick<EmittedWorkspace, 'corvidaeDirectory' | 'targetDirectory'>[];
}

export interface TypeScriptPlan {
  /** Target-relative path to file contents, ready for `writeTransformOutput`. */
  files: Record<string, string>;
  /** The directories the configuration was vendored into, empty when the target keeps the package. */
  vendoredInto: string[];
}

function serialize(document: unknown): string {
  return `${JSON.stringify(document, undefined, 2)}\n`;
}

/**
 * Emit every workspace's tsconfig with its `extends` rewritten, plus the vendored configuration
 * files when the target cannot hold the package.
 */
export async function planTypeScriptConfiguration({
  corvidaeRoot,
  target,
  workspaces,
}: TypeScriptPlanOptions): Promise<TypeScriptPlan> {
  const vendor = vendorsConfiguration(target);
  const publicName = publicNameFor(
    configurationWorkspace,
    await dispositionFor(configurationWorkspace),
  );

  const files: Record<string, string> = {};
  const vendoredInto: string[] = [];

  for (const { corvidaeDirectory, targetDirectory } of workspaces) {
    const workspaceDirectory = join(corvidaeRoot, corvidaeDirectory);
    const names = await discoverConfigurations(workspaceDirectory);
    if (names.length === 0) continue;
    for (const name of names) {
      const parsed = (await Bun.file(join(workspaceDirectory, name)).json()) as JsonObject;
      files[`${targetDirectory}/${name}`] = serialize(
        rewriteExtendsField(parsed, publicName, vendor),
      );
    }
    if (!vendor) continue;
    vendoredInto.push(targetDirectory);
    for (const file of configurationFiles) {
      const source = join(corvidaeRoot, 'internal', 'typescript', file);
      files[`${targetDirectory}/${vendoredDirectory}/${file}`] = await Bun.file(source).text();
    }
  }

  if (!vendor) {
    // The target keeps the package, so its own files ship as an ordinary workspace, at whatever
    // directory `layout-map.json` places it in rather than at corvidae's own path.
    const configurationDirectory = await targetDirectoryFor(configurationWorkspace);
    for (const file of configurationFiles) {
      const source = join(corvidaeRoot, 'internal', 'typescript', file);
      files[`${configurationDirectory}/${file}`] = await Bun.file(source).text();
    }
  }

  return { files, vendoredInto };
}

/**
 * COR-1188 drops the `@corvidae/weft -> @corvidae/typescript` devDependencies edge, because the
 * configuration package is private and ships from the other target. That is only acceptable while
 * something replaces it. This asserts that every dropped edge into the configuration package was
 * replaced by a vendored copy, and that no other edge was dropped silently.
 */
export function assertTypeScriptEdgeClosed(
  droppedEdges: readonly string[],
  plan: TypeScriptPlan,
): void {
  const unexplained = droppedEdges.filter(
    (edge) => !edge.endsWith(` -> ${configurationWorkspace}`),
  );
  if (unexplained.length > 0) {
    throw new TypeScriptConfigurationError(
      `The manifest transform dropped edges nothing replaces: ${unexplained.join(', ')}`,
    );
  }
  for (const edge of droppedEdges) {
    const consumer = edge.slice(0, edge.indexOf(' -> '));
    const covered = plan.vendoredInto.some((directory) =>
      Object.keys(plan.files).some(
        (file) => file === `${directory}/${vendoredDirectory}/${configurationFiles[0]}`,
      ),
    );
    if (!covered) {
      throw new TypeScriptConfigurationError(
        `${consumer} lost its ${configurationWorkspace} edge but no vendored copy was emitted`,
      );
    }
  }
}
