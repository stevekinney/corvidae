/**
 * COR-1297: a private library exports TypeScript source with no build step. Every library keeps
 * `"." -> "./src/index.ts"`, and may add plain subpaths so a consumer can import one
 * platform-specific surface (for example a browser-safe protocol) without loading the rest.
 * Conditions, wildcards and build output stay out: each subpath is one existing source file.
 *
 * The one exception is a Svelte component library (COR-2076). `svelte-check` cannot substitute
 * declarations for Svelte source, so such a library's `types` condition names the `.d.ts` its
 * `types` script emits into the ignored `.types/` mirror of `src`, while `svelte` and `default`
 * keep naming source.
 *
 * A component library also exports the derived metadata its `metadata` Turborepo task writes into
 * the ignored `.metadata/` directory (COR-2078): `./manifest`, and the wildcard
 * `./*\/schema`, `./*\/variables` and `./*\/examples`. Those are JSON a task generates, so they
 * neither name source nor exist in a fresh checkout.
 */
const sourceRoot = './src/index.ts';
const metadataExports: Readonly<Record<string, string>> = {
  './manifest': './.metadata/components.json',
  './*/schema': './.metadata/*/schema.json',
  './*/variables': './.metadata/*/variables.json',
  './*/examples': './.metadata/*/examples.json',
};

/** Whether `key` and `target` are one of a component library's `.metadata/` exports. */
export function isMetadataExport(key: string, target: unknown): boolean {
  return Object.hasOwn(metadataExports, key) && metadataExports[key] === target;
}
const subpathKey = /^\.(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)+$/;
const sourceTarget = /^\.\/src(?:\/[A-Za-z0-9._-]+)*\/[A-Za-z0-9._-]+\.ts$/;

/** The `.types/` declaration file the `types` script emits for a source target under `./src`. */
function declarationTarget(source: string): string {
  return `./.types/${source.slice(2).replace(/\.ts$/, '.d.ts')}`;
}

/**
 * The source file an `exports` target names: the string itself, or the `svelte` and `default`
 * source of the `{ types, svelte, default }` form a Svelte component library uses. `null` for
 * anything else, including a form whose `svelte` and `default` disagree.
 */
export function exportSourceTarget(target: unknown): string | null {
  if (typeof target === 'string') return target;
  if (typeof target !== 'object' || target === null || Array.isArray(target)) return null;
  const { svelte, default: fallback } = target as Record<string, unknown>;
  return typeof svelte === 'string' && svelte === fallback ? svelte : null;
}

/** Whether `target` is exactly `{ types, svelte, default }` with `types` mirroring the source. */
function isDeclarationTarget(target: unknown): boolean {
  if (typeof target !== 'object' || target === null || Array.isArray(target)) return false;
  const keys = Object.keys(target).toSorted();
  if (keys.join() !== 'default,svelte,types') return false;
  const source = exportSourceTarget(target);
  return (
    source !== null &&
    sourceTarget.test(source) &&
    (target as Record<string, unknown>)['types'] === declarationTarget(source)
  );
}

/** Every way `exports` breaks the source-only contract; empty when it holds. */
export function sourceExportViolations(
  exports: unknown,
  exists: (relativePath: string) => boolean,
  options: { declarations?: boolean } = {},
): string[] {
  if (typeof exports !== 'object' || exports === null || Array.isArray(exports)) {
    return ['exports must be an object mapping "." to "./src/index.ts"'];
  }
  const entries = Object.entries(exports);
  const violations: string[] = [];
  const declared = (target: unknown): boolean =>
    options.declarations === true && isDeclarationTarget(target);
  const rootEntry = (exports as Record<string, unknown>)['.'];
  const rootTarget = declared(rootEntry) ? exportSourceTarget(rootEntry) : rootEntry;
  if (rootTarget !== sourceRoot) {
    violations.push('"." must map to "./src/index.ts"');
  }
  for (const [key, entry] of entries) {
    if (key === '.') continue;
    if (options.declarations === true && isMetadataExport(key, entry)) continue;
    const name = JSON.stringify(key);
    const target = declared(entry) ? exportSourceTarget(entry) : entry;
    if (!subpathKey.test(key)) {
      violations.push(`${name} is not a plain subpath export`);
    } else if (typeof target !== 'string') {
      violations.push(`${name} must be a string path`);
    } else if (!sourceTarget.test(target) || target.split('/').includes('..')) {
      violations.push(`${name} must point at a ./src/**/*.ts file`);
    } else if (!exists(target.slice(2))) {
      violations.push(`${name} points at a file that does not exist`);
    }
  }
  return violations;
}

/** Whether `specifier` names `packageName` itself or a subpath its `exports` declares. */
export function declaresImportSpecifier(
  specifier: string,
  packageName: string,
  exports: unknown,
): boolean {
  if (specifier === packageName) return true;
  if (!specifier.startsWith(`${packageName}/`)) return false;
  if (typeof exports !== 'object' || exports === null) return false;
  const subpath = `.${specifier.slice(packageName.length)}`;
  if (Object.hasOwn(exports, subpath)) return true;
  // A wildcard subpath (`./*/schema`) declares every specifier its `*` can stand for, as Node's
  // resolution does: one path segment or more, never empty.
  return Object.keys(exports).some((key) => {
    const star = key.indexOf('*');
    if (star === -1 || key.indexOf('*', star + 1) !== -1) return false;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    return (
      subpath.length > prefix.length + suffix.length &&
      subpath.startsWith(prefix) &&
      subpath.endsWith(suffix)
    );
  });
}
