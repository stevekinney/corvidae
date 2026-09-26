/**
 * COR-1297: a private library exports TypeScript source with no build step. Every library keeps
 * `"." -> "./src/index.ts"`, and may add plain subpaths so a consumer can import one
 * platform-specific surface (for example a browser-safe protocol) without loading the rest.
 * Conditions, wildcards and build output stay out: each subpath is one existing source file.
 */
const sourceRoot = './src/index.ts';
const subpathKey = /^\.(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)+$/;
const sourceTarget = /^\.\/src(?:\/[A-Za-z0-9._-]+)*\/[A-Za-z0-9._-]+\.ts$/;

/** Every way `exports` breaks the source-only contract; empty when it holds. */
export function sourceExportViolations(
  exports: unknown,
  exists: (relativePath: string) => boolean,
): string[] {
  if (typeof exports !== 'object' || exports === null || Array.isArray(exports)) {
    return ['exports must be an object mapping "." to "./src/index.ts"'];
  }
  const entries = Object.entries(exports);
  const violations: string[] = [];
  if ((exports as Record<string, unknown>)['.'] !== sourceRoot) {
    violations.push('"." must map to "./src/index.ts"');
  }
  for (const [key, target] of entries) {
    if (key === '.') continue;
    const name = JSON.stringify(key);
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
  return Object.hasOwn(exports, `.${specifier.slice(packageName.length)}`);
}
