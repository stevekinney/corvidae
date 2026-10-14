/**
 * Boundary checks for `@lostgradient/terminal`. Each check states what it enforces and what it
 * leaves to another backstop; `README.md` repeats this contract and a test keeps the two honest.
 *
 * - `findImportViolations`: static scan of browser source under `src/` for runtime loads of Bun,
 *   Node, ventriloquist server entries, rejected engines, and paths that leave the package. A
 *   computed `import()` or `require()` specifier fails closed. It does not resolve `tsconfig`
 *   `paths` or bundler aliases; the browser typecheck backstops those.
 * - `findManifestViolations`: the `@xterm/xterm` pin in the root catalog and this package's
 *   `catalog:` dependency, and rejected engine names in the root catalogs (catalog entries nothing
 *   installs are invisible to the lockfile).
 * - `findLockfileViolations`: `bun.lock` as resolved by Bun, which replaces parsing aliases, git
 *   sources, overrides, and resolutions. A stale lockfile is the frozen-lockfile preflight's job
 *   (`bun install --frozen-lockfile` runs before every turbo task).
 * - `runImportProbe`: importing `src/index.ts` only, under plain Bun; what the probe traps is
 *   listed in `import-probe.ts`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import ts from 'typescript';

export type BoundaryViolation = {
  file: string;
  line: number;
  message: string;
};

/** The one ventriloquist entry browser code may import. */
const NEUTRAL_VENTRILOQUIST = '@lostgradient/ventriloquist';
/** Engines the terminal contract rejected, by resolved package name. */
const COMPARISON_ENGINE = /^(?:ghostty-web|@wterm\/[^/@]+)(?:\/.*)?$/;
const SELECTED_ENGINE = '@xterm/xterm';
const SELECTED_ENGINE_VERSION = '6.0.0';

/** Why browser source may not import `specifier`, or `undefined` when it may. */
export function forbiddenImportReason(specifier: string): string | undefined {
  if (specifier === NEUTRAL_VENTRILOQUIST) return undefined;
  if (COMPARISON_ENGINE.test(specifier)) {
    return `${specifier} is a comparison engine the terminal contract rejected`;
  }
  if (specifier.startsWith(`${NEUTRAL_VENTRILOQUIST}/`)) {
    return `${specifier} is a Bun host entry; browser source imports only ${NEUTRAL_VENTRILOQUIST}`;
  }
  if (specifier === 'bun' || specifier.startsWith('bun:')) {
    return `${specifier} is a Bun module; browser source cannot import it`;
  }
  if (specifier.startsWith('node:') || isBuiltin(specifier)) {
    return `${specifier} is a Node module; browser source cannot import it`;
  }
  return undefined;
}

/** The directories and file shapes the browser TypeScript program excludes as test scaffolding. */
const TEST_DIRECTORIES = new Set([
  'test',
  'tests',
  '__tests__',
  '__fixtures__',
  '__test-helpers__',
]);
const TEST_FILE =
  /(?:\.test\.|\.spec\.|\.test-d\.ts$|\.type-test\.ts$|\.playwright\.ts$|-test-[^/]*\.ts$|\.test-support\.ts$)/;
const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx|svelte)$/;

function browserSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!TEST_DIRECTORIES.has(entry.name) && entry.name !== 'node_modules') {
        files.push(...browserSourceFiles(path));
      }
    } else if (SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name)) {
      files.push(path);
    }
  }
  return files.toSorted();
}

/** A module load in source. `computed` marks a dynamic load whose specifier is not a literal. */
type ImportReference = { specifier: string; line: number; computed?: true };

function lineAt(text: string, position: number): number {
  let line = 1;
  for (let index = 0; index < position; index += 1) if (text[index] === '\n') line += 1;
  return line;
}

function stringLiteral(node: ts.Node | undefined): ts.StringLiteralLike | undefined {
  return node !== undefined && ts.isStringLiteralLike(node) ? node : undefined;
}

/**
 * The specifier a node loads at runtime. Type-only imports and exports erase before runtime, so
 * they return nothing; `import { type A } from 'x'` still loads `x` and is kept. A dynamic import
 * or `require` with a computed specifier cannot be resolved statically, so it comes back as
 * `'computed'` and the caller fails closed.
 */
function runtimeSpecifier(node: ts.Node): ts.StringLiteralLike | 'computed' | undefined {
  if (ts.isImportDeclaration(node)) {
    return node.importClause?.isTypeOnly ? undefined : stringLiteral(node.moduleSpecifier);
  }
  if (ts.isExportDeclaration(node)) {
    return node.isTypeOnly ? undefined : stringLiteral(node.moduleSpecifier);
  }
  if (ts.isImportEqualsDeclaration(node)) {
    const reference = node.moduleReference;
    return !node.isTypeOnly && ts.isExternalModuleReference(reference)
      ? stringLiteral(reference.expression)
      : undefined;
  }
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    const loads =
      callee.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(callee) && callee.text === 'require');
    return loads ? (stringLiteral(node.arguments[0]) ?? 'computed') : undefined;
  }
  return undefined;
}

const SCRIPT_KINDS: Record<string, ts.ScriptKind> = {
  '.tsx': ts.ScriptKind.TSX,
  '.jsx': ts.ScriptKind.JSX,
  '.js': ts.ScriptKind.JS,
  '.mjs': ts.ScriptKind.JS,
  '.cjs': ts.ScriptKind.JS,
};

/** Parse with the kind the extension implies; a Svelte `<script>` block is TypeScript. */
function scriptReferences(text: string, firstLine: number, fileName: string): ImportReference[] {
  const kind = SCRIPT_KINDS[extname(fileName)] ?? ts.ScriptKind.TS;
  const file = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const references: ImportReference[] = [];
  const visit = (node: ts.Node): void => {
    const specifier = runtimeSpecifier(node);
    if (specifier !== undefined) {
      const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
      references.push(
        specifier === 'computed'
          ? { specifier: '', line: firstLine + line, computed: true }
          : { specifier: specifier.text, line: firstLine + line },
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return references;
}

const SCRIPT_BLOCK = /<script\b[^>]*>([\s\S]*?)<\/script>/g;
/**
 * `import(` or `require(`, then a literal argument when there is one (otherwise computed). A
 * quoted specifier may contain `$` (`'$lib/x'`); `${` is a substitution only inside a template.
 */
const MARKUP_LOAD =
  /\b(?:import|require)\s*\(\s*(?:(?:(['"])([^'"\n]+)\1|`((?:[^`$\n]|\$(?!\{))+)`)\s*\))?/g;

/**
 * Every module specifier a TypeScript, JavaScript, or Svelte source file loads at runtime: static
 * imports, re-exports, `import x = require()`, dynamic `import()` and `require()` with a literal
 * specifier. A Svelte file contributes its `<script>` blocks plus any literal dynamic import in
 * its markup, such as `{#await import('x')}`, with line numbers relative to the whole file.
 */
export function importReferences(source: string, fileName: string): ImportReference[] {
  if (!fileName.endsWith('.svelte')) return scriptReferences(source, 1, fileName);
  const references: ImportReference[] = [];
  for (const match of source.matchAll(SCRIPT_BLOCK)) {
    const offset = (match.index ?? 0) + match[0].indexOf('>') + 1;
    references.push(...scriptReferences(match[1] ?? '', lineAt(source, offset), 'script.ts'));
  }
  const markup = source.replace(SCRIPT_BLOCK, (block) => block.replace(/[^\n]/g, ' '));
  for (const match of markup.matchAll(MARKUP_LOAD)) {
    const line = lineAt(markup, match.index ?? 0);
    references.push(
      match[2] === undefined && match[3] === undefined
        ? { specifier: '', line, computed: true }
        : { specifier: match[2] ?? match[3] ?? '', line },
    );
  }
  return references.toSorted((left, right) => left.line - right.line);
}

/** Browser source under `<packageRoot>/src` that imports something the browser cannot run. */
export function findImportViolations(packageRoot: string): BoundaryViolation[] {
  const sourceRoot = join(packageRoot, 'src');
  const violations: BoundaryViolation[] = [];
  for (const file of browserSourceFiles(sourceRoot)) {
    for (const { specifier, line, computed } of importReferences(
      readFileSync(file, 'utf8'),
      file,
    )) {
      if (computed) {
        violations.push({
          file: relative(packageRoot, file),
          line,
          message:
            'a dynamic import or require with a computed specifier cannot be checked; pass a string literal',
        });
        continue;
      }
      const leavesPackage =
        (specifier.startsWith('.') || isAbsolute(specifier)) &&
        relative(packageRoot, resolve(dirname(file), specifier)).startsWith('..');
      const message =
        forbiddenImportReason(specifier) ??
        (leavesPackage
          ? `${specifier} leaves the package; import it through its package name`
          : undefined);
      if (message !== undefined) {
        violations.push({ file: relative(packageRoot, file), line, message });
      }
    }
  }
  return violations;
}

const DEPENDENCY_SECTIONS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

type CatalogMap = Record<string, string>;
type Manifest = {
  catalog?: CatalogMap;
  catalogs?: Record<string, CatalogMap>;
  workspaces?: string[] | { catalog?: CatalogMap; catalogs?: Record<string, CatalogMap> };
  dependencies?: Record<string, string>;
};

type Lockfile = {
  workspaces: Record<string, Partial<Record<(typeof DEPENDENCY_SECTIONS)[number], object>>>;
  /** Install path to `[resolvedNameAtSource, …]`; an alias, git source, or override shows here. */
  packages: Record<string, [string, ...unknown[]]>;
};

function readManifest(path: string): Manifest {
  return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
}

/** The pin the contract states: the exact engine version, through the root catalog. */
export function findManifestViolations(
  packageRoot: string,
  workspaceRoot: string,
): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  const rootManifestPath = join(workspaceRoot, 'package.json');
  const rootManifest = readManifest(rootManifestPath);
  const catalogVersion = rootManifest.catalog?.[SELECTED_ENGINE];
  if (catalogVersion !== SELECTED_ENGINE_VERSION) {
    violations.push({
      file: relative(packageRoot, rootManifestPath),
      line: 1,
      message: `root catalog must pin ${SELECTED_ENGINE} to ${SELECTED_ENGINE_VERSION}, found ${catalogVersion ?? 'nothing'}`,
    });
  }
  const nested = Array.isArray(rootManifest.workspaces) ? undefined : rootManifest.workspaces;
  const catalogs = [
    rootManifest.catalog,
    ...Object.values(rootManifest.catalogs ?? {}),
    nested?.catalog,
    ...Object.values(nested?.catalogs ?? {}),
  ];
  for (const name of catalogs.flatMap((catalog) => Object.keys(catalog ?? {}))) {
    if (COMPARISON_ENGINE.test(name)) {
      violations.push({
        file: relative(packageRoot, rootManifestPath),
        line: 1,
        message: `${name} is a comparison engine the terminal contract rejected, found in a root catalog`,
      });
    }
  }
  const terminalManifestPath = join(packageRoot, 'package.json');
  const declared = readManifest(terminalManifestPath).dependencies?.[SELECTED_ENGINE];
  if (declared !== 'catalog:') {
    violations.push({
      file: relative(packageRoot, terminalManifestPath),
      line: 1,
      message: `${SELECTED_ENGINE} must be a dependency through the root catalog, found ${declared ?? 'nothing'}`,
    });
  }
  return violations;
}

/**
 * What Bun actually resolved is the source of truth, so no alias, git, override, or resolution
 * syntax can hide an engine: every `bun.lock` package must not be a rejected comparison engine,
 * and `@xterm/xterm` must resolve to exactly the contract version wherever it is installed. The
 * lockfile's `workspaces` section also names every workspace's declared dependencies directly,
 * which gives a clearer error than the resolved package would.
 */
export function findLockfileViolations(
  packageRoot: string,
  workspaceRoot: string,
): BoundaryViolation[] {
  const lockPath = join(workspaceRoot, 'bun.lock');
  const lockfile = Bun.JSONC.parse(readFileSync(lockPath, 'utf8')) as Lockfile;
  const file = relative(packageRoot, lockPath);
  const violation = (message: string): BoundaryViolation => ({ file, line: 1, message });
  const violations: BoundaryViolation[] = [];
  for (const [path, workspace] of Object.entries(lockfile.workspaces)) {
    for (const section of DEPENDENCY_SECTIONS) {
      for (const name of Object.keys(workspace[section] ?? {})) {
        if (COMPARISON_ENGINE.test(name)) {
          violations.push(
            violation(
              `${path === '' ? 'the root workspace' : path} declares ${name}, a comparison engine the terminal contract rejected`,
            ),
          );
        }
      }
    }
  }
  let engineResolved = false;
  for (const [key, [resolved]] of Object.entries(lockfile.packages)) {
    const separator = resolved.indexOf('@', 1);
    const name = resolved.slice(0, separator);
    const source = resolved.slice(separator + 1);
    if (COMPARISON_ENGINE.test(name)) {
      violations.push(
        violation(`${key} resolves to ${name}, a comparison engine the terminal contract rejected`),
      );
    } else if (name === SELECTED_ENGINE) {
      engineResolved = true;
      if (source !== SELECTED_ENGINE_VERSION) {
        violations.push(
          violation(
            `${SELECTED_ENGINE} resolves to ${source}, but the contract pins ${SELECTED_ENGINE_VERSION}`,
          ),
        );
      }
    }
  }
  if (!engineResolved)
    violations.push(violation(`${SELECTED_ENGINE} does not resolve in the lockfile`));
  return violations;
}

export type ImportProbeReport = {
  /** Source modules the entry's import graph loaded that it must not: the engine and Bun-only entries. */
  forbiddenModules: string[];
  /** Calls to `fetch`, WebAssembly compilation or construction, timers, workers, or sockets made while importing. */
  trappedCalls: string[];
  /** DOM globals the import read, including ones a plain Bun process already defines. */
  domGlobals: string[];
  /** Globals the import added to `globalThis`. */
  addedGlobals: string[];
  /** The error thrown by the import, when it threw. */
  error?: string;
};

/**
 * Import `entry` in a plain Bun process, with no test preload and no DOM, and report anything it
 * did beyond defining its exports. The probe lives in `import-probe.ts` and prints its report as
 * JSON; a probe that fails to produce one is itself a violation.
 */
export function runImportProbe(packageRoot: string, entry: string): ImportProbeReport {
  const result = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, 'import-probe.ts'), entry],
    { cwd: packageRoot, timeout: 30_000 },
  );
  const output = result.stdout.toString().trim();
  try {
    return JSON.parse(output) as ImportProbeReport;
  } catch {
    return {
      forbiddenModules: [],
      trappedCalls: [],
      domGlobals: [],
      addedGlobals: [],
      error: `the import probe produced no report (exit ${result.exitCode}): ${result.stderr.toString().trim() || output}`,
    };
  }
}

/** The probe findings as violations against `entry`. */
export function importProbeViolations(
  report: ImportProbeReport,
  packageRoot: string,
  entry: string,
): BoundaryViolation[] {
  const file = relative(packageRoot, entry);
  const findings = [
    ...report.forbiddenModules.map((name) => `importing the package loaded ${name}`),
    ...report.trappedCalls.map((name) => `importing the package called ${name}`),
    ...report.domGlobals.map((name) => `importing the package read the DOM global ${name}`),
    ...report.addedGlobals.map((name) => `importing the package added the global ${name}`),
    ...(report.error === undefined ? [] : [`importing the package failed: ${report.error}`]),
  ];
  return findings.map((message) => ({ file, line: 1, message }));
}

export function formatViolations(violations: BoundaryViolation[]): string {
  return violations.map(({ file, line, message }) => `${file}:${line}: ${message}`).join('\n');
}

/** Run every boundary check for the package at `packageRoot`. */
export function checkBoundaries(
  packageRoot: string,
  workspaceRoot = resolve(packageRoot, '../..'),
): BoundaryViolation[] {
  const entry = join(packageRoot, 'src/index.ts');
  return [
    ...findImportViolations(packageRoot),
    ...findManifestViolations(packageRoot, workspaceRoot),
    ...findLockfileViolations(packageRoot, workspaceRoot),
    ...importProbeViolations(runImportProbe(packageRoot, entry), packageRoot, entry),
  ];
}

export function main(argv: string[]): number {
  const index = argv.indexOf('--package-root');
  const argument = index >= 0 ? argv[index + 1] : undefined;
  if (index >= 0 && argument === undefined)
    throw new Error('--package-root requires a path argument');
  const packageRoot = argument ? resolve(process.cwd(), argument) : resolve(import.meta.dir, '..');
  const violations = checkBoundaries(packageRoot);
  if (violations.length === 0) {
    console.log(
      'Terminal boundaries hold: browser imports, engine manifest, lockfile, and package import.',
    );
    return 0;
  }
  console.error(`Terminal boundary violations:\n${formatViolations(violations)}`);
  return 1;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
