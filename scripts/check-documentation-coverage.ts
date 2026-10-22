/**
 * Fails when a workspace exports a symbol without a documentation comment.
 *
 * Run from a workspace directory, as each library's and component's `lint` does. The check starts
 * at every entry point in the workspace's `exports` map, follows re-exports to the declaring
 * symbol, and requires that symbol to carry a non-empty documentation comment. It judges only the
 * export itself, not the members of an exported interface or class. A symbol declared in another
 * workspace is that workspace's to document, and a dependency's is no one's, so both are skipped,
 * as are Svelte components, which Cinder's component metadata documents instead.
 *
 * Exports that were undocumented when the check arrived are listed in the workspace's
 * `documentation-coverage-allowlist.json`. The list can only shrink: an undocumented export it does
 * not name fails, and so does an entry for an export that is now documented or gone. `--shrink`
 * drops those stale entries, and `--seed` writes the first list, refusing to run once the file has
 * entries.
 */

import { existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

export const ALLOWLIST_FILE = 'documentation-coverage-allowlist.json';
const ALLOWLIST_DESCRIPTION =
  'Exports allowed to lack a documentation comment, checked by scripts/check-documentation-coverage.ts. The list can only shrink: --shrink drops stale entries, --seed refuses to run once this file has entries.';

/** One `exports` entry: the subpath consumers import and the source module it maps to. */
export interface EntryPoint {
  subpath: string;
  file: string;
}

/** Reads the workspace's `exports` map, which must map each subpath straight to a TypeScript file. */
export function readEntryPoints(directory: string, exports: unknown): EntryPoint[] {
  const map: Record<string, unknown> =
    typeof exports === 'string' ? { '.': exports } : ((exports ?? {}) as Record<string, unknown>);
  return Object.entries(map).map(([subpath, target]) => {
    if (typeof target !== 'string' || !/\.tsx?$/.test(target)) {
      throw new Error(
        `${directory}: export ${subpath} must map to a TypeScript source file, got ${JSON.stringify(target)}`,
      );
    }
    return { subpath, file: resolve(directory, target) };
  });
}

function isAmbientSvelteModule(declaration: ts.Declaration): boolean {
  for (let node: ts.Node | undefined = declaration; node; node = node.parent) {
    if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
      return node.name.text.endsWith('.svelte');
    }
  }
  return false;
}

/**
 * Lists the workspace's undocumented exports as `<subpath> <name>` keys, sorted. A symbol exported
 * from several entry points is judged once, under the first entry point that exports it.
 * `declarationFiles` are the ambient declarations the workspace compiles with, such as its
 * `*.svelte` module declaration.
 */
export function findUndocumentedExports(
  directory: string,
  entryPoints: readonly EntryPoint[],
  options: ts.CompilerOptions,
  declarationFiles: readonly string[] = [],
): string[] {
  const program = ts.createProgram(
    [...entryPoints.map((entry) => entry.file), ...declarationFiles],
    { ...options, noEmit: true },
  );
  const checker = program.getTypeChecker();
  const ownDirectory = resolve(directory) + sep;
  const seen = new Set<ts.Symbol>();
  const undocumented: string[] = [];

  for (const entry of entryPoints) {
    const sourceFile = program.getSourceFile(entry.file);
    const moduleSymbol = sourceFile && checker.getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) throw new Error(`${directory}: cannot load export ${entry.subpath}`);

    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      const symbol =
        exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      if (seen.has(symbol)) continue;
      seen.add(symbol);

      const declarations = symbol.declarations ?? [];
      const owned = declarations.filter((declaration) => {
        const fileName = resolve(declaration.getSourceFile().fileName);
        return fileName.startsWith(ownDirectory) && !fileName.includes(`${sep}node_modules${sep}`);
      });
      if (owned.length === 0 || owned.some(isAmbientSvelteModule)) continue;

      const documentation = ts.displayPartsToString(symbol.getDocumentationComment(checker));
      if (documentation.trim() === '') undocumented.push(`${entry.subpath} ${exported.name}`);
    }
  }
  return undocumented.toSorted();
}

export interface CoverageJudgement {
  /** Undocumented exports the allowlist does not name. */
  missing: string[];
  /** Allowlist entries for exports that are documented now, or no longer exported. */
  stale: string[];
}

export function judgeCoverage(
  undocumented: readonly string[],
  allowlist: readonly string[],
): CoverageJudgement {
  const allowed = new Set(allowlist);
  const current = new Set(undocumented);
  return {
    missing: undocumented.filter((key) => !allowed.has(key)),
    stale: allowlist.filter((key) => !current.has(key)),
  };
}

function readConfiguration(directory: string): ts.ParsedCommandLine {
  const path = join(directory, 'tsconfig.json');
  const loaded = ts.readConfigFile(path, (file) => ts.sys.readFile(file));
  if (loaded.error) {
    throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, '\n'));
  }
  return ts.parseJsonConfigFileContent(loaded.config, ts.sys, directory);
}

async function readAllowlist(path: string): Promise<string[]> {
  if (!existsSync(path)) return [];
  const contents: { entries?: string[] } = await Bun.file(path).json();
  return contents.entries ?? [];
}

async function writeAllowlist(path: string, entries: readonly string[]): Promise<void> {
  await Bun.write(
    path,
    `${JSON.stringify({ description: ALLOWLIST_DESCRIPTION, entries: entries.toSorted() }, null, 2)}\n`,
  );
}

async function main(argv: readonly string[]): Promise<number> {
  const mode = argv[0];
  if (mode !== undefined && mode !== '--seed' && mode !== '--shrink') {
    process.stderr.write(`check-documentation-coverage — unknown argument ${mode}\n`);
    return 2;
  }
  const directory = process.cwd();
  const name = relative(join(import.meta.dir, '..'), directory);
  const manifest: { exports?: unknown } = await Bun.file(join(directory, 'package.json')).json();
  const configuration = readConfiguration(directory);
  const undocumented = findUndocumentedExports(
    directory,
    readEntryPoints(directory, manifest.exports),
    configuration.options,
    configuration.fileNames.filter((fileName) => fileName.endsWith('.d.ts')),
  );
  const allowlistPath = join(directory, ALLOWLIST_FILE);
  const allowlist = await readAllowlist(allowlistPath);

  if (mode === '--seed') {
    if (allowlist.length > 0) {
      process.stderr.write(
        `check-documentation-coverage — ${name}: the allowlist already has entries; not seeding.\n`,
      );
      return 1;
    }
    if (undocumented.length > 0) await writeAllowlist(allowlistPath, undocumented);
    process.stdout.write(
      `check-documentation-coverage — ${name}: seeded ${undocumented.length} entries.\n`,
    );
    return 0;
  }

  const { missing, stale } = judgeCoverage(undocumented, allowlist);
  if (mode === '--shrink') {
    if (allowlist.length > 0) {
      await writeAllowlist(
        allowlistPath,
        allowlist.filter((key) => !stale.includes(key)),
      );
    }
    process.stdout.write(
      `check-documentation-coverage — ${name}: removed ${stale.length} stale entries.\n`,
    );
    return missing.length > 0 ? 1 : 0;
  }

  if (missing.length === 0 && stale.length === 0) {
    process.stdout.write(
      `check-documentation-coverage — ${name}: OK (${allowlist.length} allowlisted).\n`,
    );
    return 0;
  }
  const lines = [
    ...missing.map((key) => `undocumented export: ${key}`),
    ...stale.map((key) => `stale allowlist entry (documented or no longer exported): ${key}`),
  ];
  process.stderr.write(
    `check-documentation-coverage — ${name}:\n${lines.map((line) => `  ${line}`).join('\n')}\n\n` +
      'Add a documentation comment to each undocumented export. ' +
      `Remove stale entries with: bun ../../scripts/check-documentation-coverage.ts --shrink\n`,
  );
  return 1;
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
