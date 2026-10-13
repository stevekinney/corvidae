import { readdirSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import ts from 'typescript';

export type BoundaryViolation = {
  file: string;
  line: number;
  message: string;
};

/** The one ventriloquist entry browser code may import. */
const NEUTRAL_VENTRILOQUIST = '@lostgradient/ventriloquist';
/**
 * Engines the terminal contract rejected, matched wherever a manifest or import can name one: as a
 * key, an `npm:` alias, a `workspace:` target, or the last segment of a `file:` or `link:` path.
 * The leading class keeps `ghostty-web-docs` from matching.
 */
const COMPARISON_ENGINE = /(?:^|[/>:])(?:ghostty-web|@wterm\/[^@/]+)(?:@|\/|$)/;
/** The selected engine named anywhere an override could retarget it. */
const SELECTED_ENGINE_NAME = /(?:^|[/>:])@xterm\/xterm(?:@|\/|$)/;
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

type ImportReference = { specifier: string; line: number };

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
 * or `require` with a computed specifier cannot be resolved statically and is out of scope here;
 * the import probe catches what it loads.
 */
function runtimeSpecifier(node: ts.Node): ts.StringLiteralLike | undefined {
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
    return loads ? stringLiteral(node.arguments[0]) : undefined;
  }
  return undefined;
}

function scriptReferences(text: string, firstLine: number): ImportReference[] {
  const file = ts.createSourceFile('script.ts', text, ts.ScriptTarget.Latest, true);
  const references: ImportReference[] = [];
  const visit = (node: ts.Node): void => {
    const specifier = runtimeSpecifier(node);
    if (specifier !== undefined) {
      const { line } = file.getLineAndCharacterOfPosition(specifier.getStart(file));
      references.push({ specifier: specifier.text, line: firstLine + line });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return references;
}

const SCRIPT_BLOCK = /<script\b[^>]*>([\s\S]*?)<\/script>/g;
const MARKUP_LOAD = /\b(?:import|require)\s*\(\s*(['"`])([^'"`$\n]+)\1\s*\)/g;

/**
 * Every module specifier a TypeScript, JavaScript, or Svelte source file loads at runtime: static
 * imports, re-exports, `import x = require()`, dynamic `import()` and `require()` with a literal
 * specifier. A Svelte file contributes its `<script>` blocks plus any literal dynamic import in
 * its markup, such as `{#await import('x')}`, with line numbers relative to the whole file.
 */
export function importReferences(source: string, fileName: string): ImportReference[] {
  if (!fileName.endsWith('.svelte')) return scriptReferences(source, 1);
  const references: ImportReference[] = [];
  for (const match of source.matchAll(SCRIPT_BLOCK)) {
    const offset = (match.index ?? 0) + match[0].indexOf('>') + 1;
    references.push(...scriptReferences(match[1] ?? '', lineAt(source, offset)));
  }
  const markup = source.replace(SCRIPT_BLOCK, (block) => block.replace(/[^\n]/g, ' '));
  for (const match of markup.matchAll(MARKUP_LOAD)) {
    references.push({ specifier: match[2] ?? '', line: lineAt(markup, match.index ?? 0) });
  }
  return references.toSorted((left, right) => left.line - right.line);
}

/** Browser source under `<packageRoot>/src` that imports something the browser cannot run. */
export function findImportViolations(packageRoot: string): BoundaryViolation[] {
  const sourceRoot = join(packageRoot, 'src');
  const violations: BoundaryViolation[] = [];
  for (const file of browserSourceFiles(sourceRoot)) {
    for (const { specifier, line } of importReferences(readFileSync(file, 'utf8'), file)) {
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
  name?: string;
  workspaces?: string[] | { packages?: string[]; catalog?: CatalogMap; catalogs?: CatalogMap[] };
  catalog?: CatalogMap;
  catalogs?: Record<string, CatalogMap>;
  overrides?: Record<string, unknown>;
  resolutions?: Record<string, unknown>;
} & { [section in (typeof DEPENDENCY_SECTIONS)[number]]?: Record<string, string> };

const OVERRIDE_SECTIONS = ['overrides', 'resolutions'] as const;

function readManifest(path: string): Manifest {
  return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
}

/** The root manifest and the manifest of every workspace its `workspaces` field declares. */
function workspaceManifestPaths(workspaceRoot: string): string[] {
  const { workspaces } = readManifest(join(workspaceRoot, 'package.json'));
  const patterns = (Array.isArray(workspaces) ? workspaces : (workspaces?.packages ?? [])).filter(
    (pattern) => !pattern.startsWith('!'),
  );
  const paths = patterns.flatMap((pattern) => [
    ...new Bun.Glob(`${pattern}/package.json`).scanSync({ cwd: workspaceRoot, absolute: true }),
  ]);
  return [join(workspaceRoot, 'package.json'), ...paths.toSorted()];
}

/** Every `[name, specifier]` a manifest declares as a dependency or in a default or named catalog. */
function declaredSpecifiers(manifest: Manifest): [string, string][] {
  const { workspaces } = manifest;
  const nested = Array.isArray(workspaces) ? undefined : workspaces;
  const catalogs = [
    manifest.catalog,
    ...Object.values(manifest.catalogs ?? {}),
    nested?.catalog,
    ...Object.values(nested?.catalogs ?? {}),
  ];
  return [
    ...DEPENDENCY_SECTIONS.flatMap((section) => Object.entries(manifest[section] ?? {})),
    ...catalogs.flatMap((catalog) => Object.entries(catalog ?? {})),
  ];
}

/** Every key and string value in an `overrides` or `resolutions` tree, nested objects included. */
function overrideTexts(tree: Record<string, unknown>): string[] {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === 'object' && value !== null
      ? [key, ...overrideTexts(value as Record<string, unknown>)]
      : [key, String(value)],
  );
}

/**
 * The terminal engine must be `@xterm/xterm` at its exact contract version through the root
 * catalog, and no comparison engine may appear in any manifest in the workspace.
 */
export function findManifestViolations(
  packageRoot: string,
  workspaceRoot: string,
): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  const rootManifestPath = join(workspaceRoot, 'package.json');
  const catalogVersion = readManifest(rootManifestPath).catalog?.[SELECTED_ENGINE];
  if (catalogVersion !== SELECTED_ENGINE_VERSION) {
    violations.push({
      file: relative(packageRoot, rootManifestPath),
      line: 1,
      message: `root catalog must pin ${SELECTED_ENGINE} to ${SELECTED_ENGINE_VERSION}, found ${catalogVersion ?? 'nothing'}`,
    });
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
  for (const path of workspaceManifestPaths(workspaceRoot)) {
    const manifest = readManifest(path);
    const file = relative(packageRoot, path);
    for (const [name, specifier] of declaredSpecifiers(manifest)) {
      if (COMPARISON_ENGINE.test(name)) {
        violations.push({
          file,
          line: 1,
          message: `${name} is a comparison engine the terminal contract rejected`,
        });
      } else if (COMPARISON_ENGINE.test(specifier)) {
        violations.push({
          file,
          line: 1,
          message: `${name} (${specifier}) resolves to a comparison engine the terminal contract rejected`,
        });
      }
    }
    for (const section of OVERRIDE_SECTIONS) {
      const retargets = overrideTexts(manifest[section] ?? {}).some(
        (text) => SELECTED_ENGINE_NAME.test(text) || COMPARISON_ENGINE.test(text),
      );
      if (retargets) {
        violations.push({
          file,
          line: 1,
          message: `${section} may not name the terminal engine or a comparison engine`,
        });
      }
    }
  }
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
    console.log('Terminal boundaries hold: browser imports, engine manifest, and package import.');
    return 0;
  }
  console.error(`Terminal boundary violations:\n${formatViolations(violations)}`);
  return 1;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
