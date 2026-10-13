import { readdirSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';

export type BoundaryViolation = {
  file: string;
  line: number;
  message: string;
};

/** The one ventriloquist entry browser code may import. */
const NEUTRAL_VENTRILOQUIST = '@lostgradient/ventriloquist';
/** Engines the terminal contract rejected. None may appear in any manifest. */
const COMPARISON_ENGINES = [/^ghostty-web$/, /^@wterm\//];
const SELECTED_ENGINE = '@xterm/xterm';
const SELECTED_ENGINE_VERSION = '6.0.0';

/** Why browser source may not import `specifier`, or `undefined` when it may. */
export function forbiddenImportReason(specifier: string): string | undefined {
  if (specifier === NEUTRAL_VENTRILOQUIST) return undefined;
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
const SOURCE_FILE = /\.(?:ts|svelte)$/;

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

/**
 * Every module specifier a TypeScript or Svelte source file imports: static imports, re-exports,
 * dynamic `import()` and `require()`. A Svelte file contributes the contents of its `<script>`
 * blocks, with line numbers relative to the whole file.
 */
export function importReferences(source: string, fileName: string): ImportReference[] {
  const blocks = fileName.endsWith('.svelte')
    ? [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((match) => ({
        text: match[1] ?? '',
        offset: (match.index ?? 0) + match[0].indexOf('>') + 1,
      }))
    : [{ text: source, offset: 0 }];
  const references: ImportReference[] = [];
  for (const { text, offset } of blocks) {
    for (const imported of ts.preProcessFile(text, true, true).importedFiles) {
      references.push({
        specifier: imported.fileName,
        line: lineAt(source, offset + imported.pos),
      });
    }
  }
  return references;
}

/** Browser source under `<packageRoot>/src` that imports something the browser cannot run. */
export function findImportViolations(packageRoot: string): BoundaryViolation[] {
  const sourceRoot = join(packageRoot, 'src');
  const violations: BoundaryViolation[] = [];
  for (const file of browserSourceFiles(sourceRoot)) {
    for (const { specifier, line } of importReferences(readFileSync(file, 'utf8'), file)) {
      const message = forbiddenImportReason(specifier);
      if (message !== undefined) {
        violations.push({ file: relative(packageRoot, file), line, message });
      }
    }
  }
  return violations;
}

type Manifest = {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  catalog?: Record<string, string>;
};

function readManifest(path: string): Manifest {
  return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
}

function workspaceManifestPaths(workspaceRoot: string): string[] {
  const paths = [join(workspaceRoot, 'package.json')];
  for (const group of ['applications', 'components', 'packages', 'internal']) {
    let entries;
    try {
      entries = readdirSync(join(workspaceRoot, group), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) paths.push(join(workspaceRoot, group, entry.name, 'package.json'));
    }
  }
  return paths.filter((path) => {
    try {
      readFileSync(path);
      return true;
    } catch {
      return false;
    }
  });
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
    const names = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(manifest.catalog ?? {}),
    ];
    for (const name of names) {
      if (COMPARISON_ENGINES.some((engine) => engine.test(name))) {
        violations.push({
          file: relative(packageRoot, path),
          line: 1,
          message: `${name} is a comparison engine the terminal contract rejected`,
        });
      }
    }
  }
  return violations;
}

export type ImportProbeReport = {
  /** Source modules the entry's import graph loaded that it must not: the engine and Bun-only entries. */
  forbiddenModules: string[];
  /** Calls to `fetch`, WebAssembly compilation, workers, or sockets made while importing. */
  trappedCalls: string[];
  /** DOM globals the import read, which a plain Bun process does not define. */
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
