#!/usr/bin/env bun
/**
 * Says which of Weft's server files are generic: part of the operation layer that does not name
 * Weft's workflow engine, and that a later change can lift out of `packages/weft`.
 *
 * The declared entry files (`ENTRY_FILES`) are walked through every import that stays inside
 * `src/server/`: static imports and re-exports, type-only ones included, and `import('...')` type
 * nodes and dynamic imports with a literal specifier. Every file so reached must import only
 * files under `src/server/` and the package `zod`. An import that leaves the directory, or names
 * another package, fails the check unless the checked-in allowlist names it: one importing file and
 * one imported specifier, as written in the source. Files outside `src/server/` are not walked.
 *
 * The allowlist only shrinks. An entry whose import no longer occurs, or whose file the walk no
 * longer reaches, fails the check, so the cut that removes an import also removes its entry.
 *
 * Usage:
 *
 * - `bun scripts/check-operation-layer-boundary.ts` checks, and exits 1 on a new violation or a
 *   stale allowlist entry.
 * - `--list` prints the reachable files, one per line, and exits 0.
 * - `--violations` prints every current violation as allowlist JSON, and exits 0.
 * - `--update` removes the stale entries from the allowlist file. It never adds one.
 * - `--root <path>` sets the package directory (default: this package). `--entry <path>` (repeat
 *   it) replaces the declared entry files, and `--allowlist <path>` the allowlist file. Both
 *   paths are relative to the root; the script's tests use them to point at fixture trees.
 */

import { file, write } from 'bun';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

/** The directory, relative to the package root, whose files are generic. */
export const GENERIC_DIRECTORY = 'src/server';

/**
 * The files the walk starts from, relative to the package root: the document generators, the
 * catalog snapshot, the JSON-RPC dispatcher, and the engine-free handler's discovery documents.
 */
export const ENTRY_FILES: readonly string[] = [
  'src/server/asyncapi.ts',
  'src/server/authentication/audit.ts',
  'src/server/authentication/index.ts',
  'src/server/authentication/types.ts',
  'src/server/authorization-scope.ts',
  'src/server/authorization.ts',
  'src/server/bind-feed-lifetime.ts',
  'src/server/fault-code.ts',
  'src/server/fault-to-http.ts',
  'src/server/handler/auth-context-principal.ts',
  'src/server/handler/operation-handler-authentication.ts',
  'src/server/handler/operation-handler-discovery.ts',
  'src/server/handler/operation-handler-mounts.ts',
  'src/server/handler/operation-handler.ts',
  'src/server/handler/workspace-release.ts',
  'src/server/in-memory-replay-live-backend.ts',
  'src/server/json-rpc-dispatch.ts',
  'src/server/json-rpc-websocket.ts',
  'src/server/openapi.ts',
  'src/server/openrpc.ts',
  'src/server/operation-catalog-snapshot.ts',
  'src/server/operation-description-audit.ts',
  'src/server/operation-fault.ts',
  'src/server/operation-registry.ts',
  'src/server/operations/closable-iterable.ts',
  'src/server/operations/get-principal.ts',
  'src/server/principal.ts',
  'src/server/replay-live-feed.ts',
  'src/server/rest-binding.ts',
  'src/server/stdio-session.ts',
];

/** The allowlist file, relative to the package root. */
export const ALLOWLIST_PATH = 'documentation/operation-layer-boundary-allowlist.json';

/** One import the boundary tolerates for now: the importing file and the specifier it uses. */
export type AllowlistEntry = { readonly file: string; readonly specifier: string };

/** An import from a reachable file that leaves the generic directory. */
export type Violation = AllowlistEntry & { readonly line: number };

export type BoundaryReport = {
  /** Reachable files, relative to the root, sorted. */
  readonly reachable: readonly string[];
  /** Every import that leaves the generic directory, with its first line, sorted. */
  readonly violations: readonly Violation[];
  /** Specifiers inside the generic directory that name no file. */
  readonly unresolved: readonly Violation[];
};

type Edge = { readonly specifier: string; readonly line: number };

function compareEntries(left: AllowlistEntry, right: AllowlistEntry): number {
  return left.file === right.file
    ? left.specifier.localeCompare(right.specifier)
    : left.file.localeCompare(right.file);
}

function isRelative(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

function isZod(specifier: string): boolean {
  return specifier === 'zod' || specifier.startsWith('zod/');
}

function stringValue(node: ts.Node | undefined): string | undefined {
  return node !== undefined && ts.isStringLiteralLike(node) ? node.text : undefined;
}

/** Every module specifier a source file names, type-only imports and re-exports included. */
export function collectSpecifiers(sourceText: string, fileName: string): Edge[] {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const edges: Edge[] = [];
  const add = (node: ts.Node, specifier: string | undefined): void => {
    if (specifier === undefined) return;
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    edges.push({ specifier, line: line + 1 });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      add(node, stringValue(node.moduleSpecifier));
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference)) {
        add(node, stringValue(node.moduleReference.expression));
      }
    } else if (ts.isImportTypeNode(node)) {
      if (ts.isLiteralTypeNode(node.argument)) add(node, stringValue(node.argument.literal));
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
      if (isDynamicImport || isRequire) add(node, stringValue(node.arguments[0]));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return edges;
}

async function resolveInside(importer: string, specifier: string): Promise<string | undefined> {
  const base = resolve(dirname(importer), specifier);
  for (const candidate of [base, `${base}.ts`, join(base, 'index.ts')]) {
    if (candidate.endsWith('.ts') && (await file(candidate).exists())) return candidate;
  }
  return undefined;
}

function isInside(directory: string, path: string): boolean {
  const relativePath = relative(directory, path);
  return relativePath !== '' && !relativePath.startsWith('..') && !relativePath.startsWith('/');
}

/** Walk the entry files and report what is reachable and what leaves the generic directory. */
export async function analyzeBoundary(options: {
  readonly root: string;
  readonly entries: readonly string[];
}): Promise<BoundaryReport> {
  const root = resolve(options.root);
  const genericDirectory = join(root, GENERIC_DIRECTORY);
  const reachable = new Set<string>();
  const violations: Violation[] = [];
  const unresolved: Violation[] = [];
  const queue = options.entries.map((entry) => resolve(root, entry));

  for (let path = queue.pop(); path !== undefined; path = queue.pop()) {
    if (reachable.has(path)) continue;
    reachable.add(path);
    const repositoryPath = relative(root, path).split('\\').join('/');
    const seen = new Set<string>();
    for (const { specifier, line } of collectSpecifiers(await file(path).text(), path)) {
      if (seen.has(specifier)) continue;
      seen.add(specifier);
      if (!isRelative(specifier)) {
        if (!isZod(specifier)) violations.push({ file: repositoryPath, specifier, line });
        continue;
      }
      const target = await resolveInside(path, specifier);
      if (target === undefined) {
        const outside = !isInside(genericDirectory, resolve(dirname(path), specifier));
        (outside ? violations : unresolved).push({ file: repositoryPath, specifier, line });
      } else if (isInside(genericDirectory, target)) {
        queue.push(target);
      } else {
        violations.push({ file: repositoryPath, specifier, line });
      }
    }
  }

  return {
    reachable: [...reachable].map((path) => relative(root, path).split('\\').join('/')).toSorted(),
    violations: violations.toSorted(compareEntries),
    unresolved: unresolved.toSorted(compareEntries),
  };
}

const entryKey = (entry: AllowlistEntry): string => `${entry.file}\u0000${entry.specifier}`;

/** The checks: violations the allowlist does not name, and allowlist entries nothing needs. */
export function compareWithAllowlist(
  report: BoundaryReport,
  allowlist: readonly AllowlistEntry[],
): { readonly newViolations: readonly Violation[]; readonly staleEntries: AllowlistEntry[] } {
  const allowed = new Set(allowlist.map(entryKey));
  const present = new Set(report.violations.map(entryKey));
  return {
    newViolations: report.violations.filter((violation) => !allowed.has(entryKey(violation))),
    staleEntries: allowlist.filter((entry) => !present.has(entryKey(entry))),
  };
}

function parseAllowlist(text: string, path: string): AllowlistEntry[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error(`${path} must hold a JSON array of entries`);
  return parsed.map((entry: unknown): AllowlistEntry => {
    const candidate = entry as Partial<AllowlistEntry> | null;
    if (typeof candidate?.file !== 'string' || typeof candidate.specifier !== 'string') {
      throw new Error(`${path}: every entry needs a string "file" and "specifier"`);
    }
    return { file: candidate.file, specifier: candidate.specifier };
  });
}

function formatAllowlist(entries: readonly AllowlistEntry[]): string {
  const sorted = entries
    .map(({ file: importer, specifier }) => ({ file: importer, specifier }))
    .toSorted(compareEntries);
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

type CliOptions = {
  root: string;
  entries: string[];
  allowlist: string;
  list: boolean;
  violations: boolean;
  update: boolean;
};

function parseArguments(args: readonly string[]): CliOptions {
  const options: CliOptions = {
    root: resolve(import.meta.dir, '..'),
    entries: [],
    allowlist: ALLOWLIST_PATH,
    list: false,
    violations: false,
    update: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = (): string => {
      const next = args[index + 1];
      if (next === undefined) throw new Error(`${argument} needs a value`);
      index += 1;
      return next;
    };
    if (argument === '--root') options.root = resolve(value());
    else if (argument === '--entry') options.entries.push(value());
    else if (argument === '--allowlist') options.allowlist = value();
    else if (argument === '--list') options.list = true;
    else if (argument === '--violations') options.violations = true;
    else if (argument === '--update') options.update = true;
    else throw new Error(`unknown argument ${argument}`);
  }
  return options;
}

async function readAllowlist(path: string): Promise<AllowlistEntry[]> {
  const allowlistFile = file(path);
  return (await allowlistFile.exists()) ? parseAllowlist(await allowlistFile.text(), path) : [];
}

/**
 * Run the checker as `bun scripts/check-operation-layer-boundary.ts <args>` would. Returns the
 * exit code and prints through `console`, so a test runs it in process.
 */
export async function runCli(args: readonly string[]): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArguments(args);
  } catch (error) {
    console.error(`check-operation-layer-boundary: ${(error as Error).message}`);
    return 2;
  }
  const entries = options.entries.length > 0 ? options.entries : ENTRY_FILES;
  const report = await analyzeBoundary({ root: options.root, entries });

  if (options.list) {
    console.log(report.reachable.join('\n'));
    return 0;
  }
  if (options.violations) {
    console.log(formatAllowlist(report.violations).trimEnd());
    return 0;
  }

  const allowlistPath = resolve(options.root, options.allowlist);
  const allowlist = await readAllowlist(allowlistPath);
  const { newViolations, staleEntries } = compareWithAllowlist(report, allowlist);

  if (options.update) {
    const kept = new Set(staleEntries.map(entryKey));
    await write(
      allowlistPath,
      formatAllowlist(allowlist.filter((entry) => !kept.has(entryKey(entry)))),
    );
    console.log(`Removed ${staleEntries.length} stale allowlist entries.`);
    return newViolations.length > 0 || report.unresolved.length > 0 ? 1 : 0;
  }

  for (const violation of report.unresolved) {
    console.error(
      `${violation.file}:${violation.line} imports "${violation.specifier}", which names no file.`,
    );
  }
  for (const violation of newViolations) {
    console.error(
      `${violation.file}:${violation.line} imports "${violation.specifier}", outside ` +
        `${GENERIC_DIRECTORY}/ and not zod. Move the dependency in, pass it as an input, or (only for a ` +
        `cut a later issue makes) add it to ${ALLOWLIST_PATH}.`,
    );
  }
  for (const entry of staleEntries) {
    console.error(
      `${ALLOWLIST_PATH}: ${entry.file} no longer imports "${entry.specifier}" (or is no longer ` +
        `reached). Remove the entry, or run with --update.`,
    );
  }
  if (newViolations.length > 0 || staleEntries.length > 0 || report.unresolved.length > 0) return 1;
  console.log(
    `OK: ${report.reachable.length} reachable files; ${allowlist.length} allowlisted imports remain.`,
  );
  return 0;
}

if (import.meta.main) {
  process.exit(await runCli(process.argv.slice(2)));
}
