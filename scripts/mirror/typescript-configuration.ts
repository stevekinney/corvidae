import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import typescript from 'typescript';

import { publicSpecifierFor } from './internal-names.ts';
import { serializeJson } from './json-formatting.ts';
import { targetDirectoryFor } from './layout-map.ts';
import { publicNameFor, targetFor, type MirrorTarget } from './manifests.ts';
import { dispositionFor } from './package-map.ts';
import { isInternalSpecifier } from './source-escapes.ts';
import { sourceTree, type EmittedWorkspace } from './source.ts';
import { keysFor, loadTargetOwnedPolicy, type TargetOwnedPolicy } from './target-owned.ts';

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
  depthFromPackageRoot: number,
): JsonObject {
  const value = configuration['extends'];
  if (typeof value === 'string') {
    return {
      ...configuration,
      extends: rewriteExtends(value, publicName, vendor, depthFromPackageRoot),
    };
  }
  if (Array.isArray(value)) {
    return {
      ...configuration,
      extends: value.map((entry) =>
        typeof entry === 'string'
          ? rewriteExtends(entry, publicName, vendor, depthFromPackageRoot)
          : entry,
      ),
    };
  }
  return { ...configuration };
}

/**
 * Rewrite the internal workspace names a configuration's `compilerOptions.paths` maps.
 *
 * A `paths` key is a module specifier the target's `tsc` matches an import against, so a key that
 * still said `@corvidae/weft` beside emitted source that now says `@lostgradient/weft` would map
 * nothing. `src/client/__fixtures__/no-workflow-registry/tsconfig.json` is the case that proves
 * this field needs its own pass: it carries no `extends` at all, so an `extends`-only rewrite
 * leaves it silently broken. The values are left exactly as they are — they are relative paths
 * into the emitted tree, not names anything renames.
 */
function rewritePathsField(
  configuration: JsonObject,
  publicNames: ReadonlyMap<string, string>,
  path: string,
): JsonObject {
  const compilerOptions = configuration['compilerOptions'];
  if (!isJsonObject(compilerOptions)) return configuration;
  const paths = compilerOptions['paths'];
  if (!isJsonObject(paths)) return configuration;
  const rewritten = Object.fromEntries(
    Object.entries(paths).map(([key, value]) => [
      isInternalSpecifier(key) ? publicSpecifierFor(key, publicNames, path) : key,
      value,
    ]),
  );
  return { ...configuration, compilerOptions: { ...compilerOptions, paths: rewritten } };
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Every `tsconfig*.json` this transform emits for one workspace, as workspace-relative paths.
 *
 * The workspace root and its `src/` tree, and nothing between or beyond them. That is exactly the
 * set the transform emits: the root configuration is what a target's `tsc` is invoked with, and
 * `src/` is what `source.ts` calls source. Walking the whole workspace instead would start
 * emitting configurations out of `examples/` and `test/` — directories nobody has ruled on and
 * whose siblings are not emitted — and walking only the root is what shipped
 * `src/cli/__fixtures__/codegen/typecheck/tsconfig.json` extending `@corvidae/typescript/\
 * library.json`, a package name that exists in no target.
 */
export async function discoverConfigurations(workspaceDirectory: string): Promise<string[]> {
  const names = async (directory: string, prefix: string): Promise<string[]> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    return entries
      .filter(
        (entry) =>
          entry.isFile() && entry.name.startsWith('tsconfig') && entry.name.endsWith('.json'),
      )
      .map((entry) => `${prefix}${entry.name}`);
  };
  const nested = await readdir(join(workspaceDirectory, sourceTree), {
    withFileTypes: true,
    recursive: true,
  }).catch(() => []);
  const found = [
    ...(await names(workspaceDirectory, '')),
    ...nested
      .filter(
        (entry) =>
          entry.isFile() && entry.name.startsWith('tsconfig') && entry.name.endsWith('.json'),
      )
      .map((entry) =>
        relative(workspaceDirectory, join(entry.parentPath, entry.name)).split(sep).join('/'),
      ),
  ];
  return found.toSorted();
}

/** How many directories a configuration sits below the package root, for a relative `extends`. */
function depthOf(configurationPath: string): number {
  return configurationPath.split('/').length - 1;
}

export interface TypeScriptPlanOptions {
  corvidaeRoot: string;
  target: MirrorTarget;
  /**
   * One entry per workspace the target receives. Both directories are needed and they differ:
   * the configuration is read from corvidae's directory and emitted into the target's.
   */
  workspaces: readonly Pick<EmittedWorkspace, 'corvidaeDirectory' | 'targetDirectory'>[];
  /**
   * Public names, keyed by `@corvidae/*` name, for every workspace this tree carries. A nested
   * configuration's `compilerOptions.paths` maps specifiers, and those are renamed from the same
   * authority the manifests and the emitted source use.
   */
  publicNames: ReadonlyMap<string, string>;
  /** A clone of the target, read for the keys `target-owned.json` says the target owns. */
  targetDirectory?: string | undefined;
  policy?: TargetOwnedPolicy | undefined;
}

/**
 * Read one `tsconfig*.json` the way TypeScript itself reads it.
 *
 * `JSON.parse` is wrong for this file and the weft target proves it: its `tsconfig.json` carries
 * eleven `//` section comments, so a plain parse throws on the first one and takes the whole sync
 * with it. A tsconfig is JSON with comments and trailing commas by definition, and the compiler's
 * own reader is the only thing guaranteed to agree with `tsc` about what the file says.
 */
function parseConfiguration(path: string, text: string): JsonObject {
  const { config, error } = typescript.parseConfigFileTextToJson(path, text);
  if (error) {
    throw new TypeScriptConfigurationError(
      `The target's ${path} is not readable as a TypeScript configuration: ${typescript.flattenDiagnosticMessageText(error.messageText, ' ')}`,
    );
  }
  return (config ?? {}) as JsonObject;
}

/**
 * Read the target's own answers for the keys it owns back into an emitted configuration.
 *
 * Only `include` and `exclude` today, and only where the target already has a configuration at
 * this path. Which trees a repository type-checks is a decision about its own working directories:
 * weft checks `src` plus five named `scripts/*.ts` files, corvidae checks `src`, `tests`,
 * `scripts` and `examples`, and emitting corvidae's pulled weft's `examples/` into a compilation
 * where they import the package by its public name and resolve to a `dist/` that does not exist
 * yet. A key the target does not carry is removed rather than left at corvidae's value, for the
 * same reason it is in a manifest.
 */
async function applyTargetOwnedKeys(
  configuration: JsonObject,
  policy: TargetOwnedPolicy,
  target: MirrorTarget,
  targetDirectory: string | undefined,
  path: string,
): Promise<JsonObject> {
  if (targetDirectory === undefined) return configuration;
  const file = Bun.file(join(targetDirectory, path));
  if (!(await file.exists())) return configuration;
  const existing = parseConfiguration(path, await file.text());
  const composed = { ...configuration };
  for (const key of keysFor(policy.insideFiles.typeScriptTargetOwned, target)) {
    if (key in existing) composed[key] = existing[key];
    else delete composed[key];
  }
  return composed;
}

export interface TypeScriptPlan {
  /** Target-relative path to file contents, ready for `writeTransformOutput`. */
  files: Record<string, string>;
  /** The directories the configuration was vendored into, empty when the target keeps the package. */
  vendoredInto: string[];
}

/**
 * Emit every workspace's tsconfig with its `extends` rewritten, plus the vendored configuration
 * files when the target cannot hold the package.
 */
export async function planTypeScriptConfiguration({
  corvidaeRoot,
  target,
  workspaces,
  publicNames,
  targetDirectory,
  policy,
}: TypeScriptPlanOptions): Promise<TypeScriptPlan> {
  const resolvedPolicy = policy ?? (await loadTargetOwnedPolicy());
  const vendor = vendorsConfiguration(target);
  const publicName = publicNameFor(
    configurationWorkspace,
    await dispositionFor(configurationWorkspace),
  );

  const files: Record<string, string> = {};
  const vendoredInto: string[] = [];

  for (const workspace of workspaces) {
    const emittedDirectory = workspace.targetDirectory;
    const workspaceDirectory = join(corvidaeRoot, workspace.corvidaeDirectory);
    const names = await discoverConfigurations(workspaceDirectory);
    if (names.length === 0) continue;
    for (const name of names) {
      const source = join(workspaceDirectory, name);
      const parsed = parseConfiguration(name, await Bun.file(source).text());
      const path = `${emittedDirectory}/${name}`;
      const depth = depthOf(name);
      const rewritten = rewritePathsField(
        rewriteExtendsField(parsed, publicName, vendor, depth),
        publicNames,
        path,
      );
      // Only a workspace-root configuration takes the target's `include` and `exclude`. Those keys
      // are owned downstream because which trees a *repository* type-checks is its own decision;
      // a fixture configuration nested inside `src/` names sibling fixture files this transform
      // emits, so reading the target's answer there would be corvidae handing away the one thing
      // it does know.
      files[path] =
        depth === 0
          ? await serializeJson(
              await applyTargetOwnedKeys(rewritten, resolvedPolicy, target, targetDirectory, path),
              targetDirectory,
              path,
            )
          : await serializeJson(rewritten, targetDirectory, path);
    }
    if (!vendor) continue;
    vendoredInto.push(emittedDirectory);
    for (const file of configurationFiles) {
      const source = join(corvidaeRoot, 'internal', 'typescript', file);
      files[`${emittedDirectory}/${vendoredDirectory}/${file}`] = await Bun.file(source).text();
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
