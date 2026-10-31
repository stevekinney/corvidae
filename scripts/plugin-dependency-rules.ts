/**
 * The dependency rules for `plugins/*` workspaces (COR-1878). A plugin is trusted, in-process code
 * that the Interborough host loads at startup, so what it may depend on is a closed list: the
 * authoring package, the libraries a contribution is built from, and external packages.
 *
 * - `dependencies` (and `peerDependencies` and `optionalDependencies`, which a consumer installs
 *   too) may name only {@link allowedPluginInternalDependency} workspaces and external packages.
 * - `@lostgradient/bureau` and `testing/*` workspaces are allowed in `devDependencies` only, so a
 *   plugin's own tests can use Bureau's test host without Bureau being part of the plugin.
 * - An application and another `plugins/*` workspace are forbidden in every field.
 *
 * The function is pure: the caller passes the workspace names in, so a test can inject manifests.
 */

/** The slice of a plugin's `package.json` the rules read. */
export interface PluginManifest {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

/** The workspaces a plugin manifest is judged against. */
export interface PluginDependencyContext {
  /** Every workspace name in the repository; a name outside it is an external package. */
  workspaceNames: ReadonlySet<string>;
  /** The names of the workspaces under `applications/`. */
  applicationNames: ReadonlySet<string>;
  /** The names of the workspaces under `plugins/`. */
  pluginNames: ReadonlySet<string>;
  /** The names of the workspaces under `testing/`. */
  verificationNames: ReadonlySet<string>;
}

const bureauName = '@lostgradient/bureau';

/** Whether a plugin's `dependencies` may name the internal workspace `name`. */
export function allowedPluginInternalDependency(name: string): boolean {
  return (
    name === '@lostgradient/interborough-plugin' ||
    name === 'armorer' ||
    name === '@lostgradient/operative' ||
    name.startsWith('@lostgradient/operative-') ||
    name === '@lostgradient/weft' ||
    name === '@lostgradient/storage' ||
    name === '@lostgradient/lifecycle' ||
    name === '@lostgradient/memory'
  );
}

const runtimeFields = ['dependencies', 'peerDependencies', 'optionalDependencies'] as const;

/** Every way `manifest` breaks the plugin dependency rules; empty when it holds. */
export function pluginDependencyViolations(
  manifest: PluginManifest,
  context: PluginDependencyContext,
): string[] {
  const violations: string[] = [];
  const check = (field: string, name: string, runtime: boolean): void => {
    const where = `${manifest.name} ${field} -> ${name}`;
    if (context.applicationNames.has(name)) {
      violations.push(`${where}: a plugin may not depend on an application`);
    } else if (context.pluginNames.has(name) && name !== manifest.name) {
      violations.push(`${where}: a plugin may not depend on another plugin`);
    } else if (!runtime) {
      return;
    } else if (name === bureauName) {
      violations.push(`${where}: Bureau is allowed in devDependencies only`);
    } else if (context.verificationNames.has(name)) {
      violations.push(`${where}: a testing workspace is allowed in devDependencies only`);
    } else if (context.workspaceNames.has(name) && !allowedPluginInternalDependency(name)) {
      violations.push(`${where}: this workspace is not on a plugin's list of allowed dependencies`);
    }
  };
  for (const field of runtimeFields) {
    for (const name of Object.keys(manifest[field] ?? {})) check(field, name, true);
  }
  for (const name of Object.keys(manifest.devDependencies ?? {})) {
    check('devDependencies', name, false);
  }
  return violations;
}
