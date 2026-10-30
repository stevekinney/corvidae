/**
 * Fails when production `src` of a package detects which JavaScript runtime it is running on.
 *
 * Code picks its runtime by construction (COR-1784): a package either targets one runtime, uses an
 * API that Bun and Node.js both provide (`process.env`, `node:crypto`, `node:fs/promises`,
 * `process.getBuiltinModule`), or takes the runtime-specific piece from its caller. Branching on
 * `typeof Bun !== 'undefined'` hides a second code path that only one runtime exercises, so the
 * other path is untested wherever it is not the host.
 *
 * Detection walks the TypeScript AST and judges value positions only. It flags:
 *
 * - `typeof Bun` as an expression, including through `globalThis`, `global` and `self`;
 * - `globalThis.Bun`, `globalThis['Bun']`, `'Bun' in globalThis`, and `Reflect.get(globalThis, 'Bun')`;
 * - `process.versions.bun`;
 * - the identifiers `isBunRuntime`, `detectRuntime` and `detectRuntimeVersion`, however they are
 *   declared, imported, or called.
 *
 * A `typeof Bun.serve` in a type position (`ReturnType<typeof Bun.serve>`) is a type query, a
 * different syntax node from the `typeof` expression, and selects nothing at runtime, so it is not
 * flagged. Running the guard over `packages/*` only: tests,
 * test-support files, and `test` and `testing` directories are exempt, because a test may pick a
 * runtime-specific adapter deliberately. The storage adapters (`packages/storage-*`) are scanned
 * like any other package, because COR-1783 removed their detection.
 *
 * A site that must stay is listed in `scripts/runtime-detection-allowlist.json` with the file, the
 * flagged kind, how many such sites the file holds, and the reason. The list can only shrink: an
 * unlisted site fails, and so does an entry that no longer matches a site or names more sites than
 * remain. `--shrink` drops stale entries and lowers counts. Adding an entry is a reviewed edit
 * that needs a reason. The check cannot read `.svelte` files, and it does not see detection spelled
 * through an alias it cannot resolve (`const g = globalThis; g.Bun`).
 */

import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const root = join(import.meta.dir, '..');
export const ALLOWLIST_FILE = join(import.meta.dir, 'runtime-detection-allowlist.json');

const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'coverage']);
const SOURCE_FILE = /\.tsx?$/;
const TEST_FILE =
  /(\.(test|spec|test-d|type-test|playwright|test-support)\.tsx?$)|(-test-[^/]*\.ts$)|(\.d\.ts$)|(\/testing\.ts$)/;
const TEST_DIRECTORY = /\/(test|tests|testing|__tests__|__fixtures__|__test-helpers__)\//;

/** The kinds of detection the guard names, which an allowlist entry refers to. */
export type RuntimeDetectionKind =
  'typeof-bun' | 'global-bun' | 'process-versions-bun' | 'detection-identifier';

/** One flagged site: where it is, which kind, and the text the author wrote. */
export interface RuntimeDetectionFinding {
  line: number;
  kind: RuntimeDetectionKind;
  text: string;
}

/** One reviewed exception. */
export interface RuntimeDetectionAllowlistEntry {
  file: string;
  kind: RuntimeDetectionKind;
  count: number;
  reason: string;
}

const GLOBAL_OBJECTS = new Set(['globalThis', 'global', 'self']);
const DETECTION_IDENTIFIERS = new Set(['isBunRuntime', 'detectRuntime', 'detectRuntimeVersion']);

const isGlobalObject = (node: ts.Node): boolean =>
  ts.isIdentifier(node) && GLOBAL_OBJECTS.has(node.text);

function memberName(node: ts.Node): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return node.argumentExpression.text;
  }
  return undefined;
}

function memberObject(node: ts.Node): ts.Expression | undefined {
  return ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)
    ? node.expression
    : undefined;
}

/** `globalThis.Bun` or `globalThis['Bun']` (also through `global` or `self`). */
function isGlobalBunAccess(node: ts.Node): boolean {
  const object = memberObject(node);
  return object !== undefined && isGlobalObject(object) && memberName(node) === 'Bun';
}

/** `process.versions.bun`, `process.versions['bun']`, and the optional-chained spellings. */
function isProcessVersionsBun(node: ts.Node): boolean {
  if (memberName(node) !== 'bun') return false;
  const versions = memberObject(node);
  if (versions === undefined || memberName(versions) !== 'versions') return false;
  const owner = memberObject(versions);
  return owner !== undefined && ts.isIdentifier(owner) && owner.text === 'process';
}

/** `Reflect.get(globalThis, 'Bun')`. */
function isReflectGetBun(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const [target, key] = node.arguments;
  return (
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'Reflect' &&
    node.expression.name.text === 'get' &&
    target !== undefined &&
    isGlobalObject(target) &&
    key !== undefined &&
    ts.isStringLiteralLike(key) &&
    key.text === 'Bun'
  );
}

function classify(node: ts.Node): RuntimeDetectionKind | undefined {
  if (ts.isTypeOfExpression(node)) {
    const operand = node.expression;
    if (ts.isIdentifier(operand) && operand.text === 'Bun') return 'typeof-bun';
    if (isGlobalBunAccess(operand)) return 'typeof-bun';
  }
  if (isGlobalBunAccess(node) || isReflectGetBun(node)) return 'global-bun';
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.InKeyword &&
    ts.isStringLiteralLike(node.left) &&
    node.left.text === 'Bun' &&
    isGlobalObject(node.right)
  ) {
    return 'global-bun';
  }
  if (isProcessVersionsBun(node)) return 'process-versions-bun';
  if (ts.isIdentifier(node) && DETECTION_IDENTIFIERS.has(node.text)) return 'detection-identifier';
  return undefined;
}

/** Every runtime-detection site in a parsed file. A type query (`typeof Bun.serve`) is never one. */
export function findRuntimeDetection(sourceFile: ts.SourceFile): RuntimeDetectionFinding[] {
  const findings: RuntimeDetectionFinding[] = [];
  const visit = (node: ts.Node): void => {
    const kind = classify(node);
    if (kind !== undefined) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      findings.push({ line: line + 1, kind, text: node.getText(sourceFile) });
      // The matching site has been reported; its parts (`globalThis`, `Bun`) are not new findings.
      if (kind !== 'detection-identifier') return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

/** Whether a repository-relative path is production `src` of a package. */
export function isProductionSource(path: string): boolean {
  return (
    /^packages\/[^/]+\/src\//.test(path) &&
    SOURCE_FILE.test(path) &&
    !TEST_FILE.test(path) &&
    !TEST_DIRECTORY.test(path)
  );
}

function collect(directory: string, paths: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collect(path, paths);
    else if (entry.isFile()) paths.push(path);
  }
}

/** The result of judging findings against the allowlist. */
export interface RuntimeDetectionVerdict {
  /** Sites no entry covers, as `file:line kind text`. */
  unlisted: string[];
  /** Entries that no longer match a site, or name more sites than remain. */
  stale: string[];
  /** The allowlist with stale entries dropped and counts lowered, for `--shrink`. */
  shrunk: RuntimeDetectionAllowlistEntry[];
}

/** Judges findings by file against the allowlist: an unlisted site and a stale entry both fail. */
export function judge(
  findingsByFile: ReadonlyMap<string, RuntimeDetectionFinding[]>,
  allowlist: readonly RuntimeDetectionAllowlistEntry[],
): RuntimeDetectionVerdict {
  const unlisted: string[] = [];
  const stale: string[] = [];
  const shrunk: RuntimeDetectionAllowlistEntry[] = [];
  for (const [file, findings] of findingsByFile) {
    for (const kind of new Set(findings.map((finding) => finding.kind))) {
      const sites = findings.filter((finding) => finding.kind === kind);
      const allowed = allowlist
        .filter((entry) => entry.file === file && entry.kind === kind)
        .reduce((total, entry) => total + entry.count, 0);
      for (const site of sites.slice(allowed)) {
        unlisted.push(`${file}:${site.line} ${site.kind} ${site.text}`);
      }
    }
  }
  for (const entry of allowlist) {
    const found = (findingsByFile.get(entry.file) ?? []).filter(
      (finding) => finding.kind === entry.kind,
    ).length;
    if (found === 0) {
      stale.push(`${entry.file} ${entry.kind}: no site remains; remove the entry`);
    } else if (found < entry.count) {
      stale.push(`${entry.file} ${entry.kind}: lists ${entry.count} sites but ${found} remain`);
      shrunk.push({ ...entry, count: found });
    } else {
      shrunk.push(entry);
    }
  }
  return { unlisted, stale, shrunk };
}

/** Scans every production source file under `repositoryRoot/packages`. */
export async function scan(
  repositoryRoot: string = root,
): Promise<Map<string, RuntimeDetectionFinding[]>> {
  const paths: string[] = [];
  collect(join(repositoryRoot, 'packages'), paths);
  const result = new Map<string, RuntimeDetectionFinding[]>();
  for (const path of paths.toSorted()) {
    const relativePath = relative(repositoryRoot, path).replaceAll('\\', '/');
    if (!isProductionSource(relativePath)) continue;
    const source = await Bun.file(path).text();
    const sourceFile = ts.createSourceFile(
      path,
      source,
      ts.ScriptTarget.Latest,
      true,
      path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const findings = findRuntimeDetection(sourceFile);
    if (findings.length > 0) result.set(relativePath, findings);
  }
  return result;
}

async function main(): Promise<void> {
  const allowlist: RuntimeDetectionAllowlistEntry[] = await Bun.file(ALLOWLIST_FILE).json();
  const verdict = judge(await scan(), allowlist);
  if (process.argv.includes('--shrink')) {
    await Bun.write(ALLOWLIST_FILE, `${JSON.stringify(verdict.shrunk, null, 2)}\n`);
    process.stdout.write(`check-runtime-detection — shrank ${ALLOWLIST_FILE}.\n`);
    process.exitCode = verdict.unlisted.length > 0 ? 1 : 0;
    if (verdict.unlisted.length === 0) return;
  }
  if (verdict.unlisted.length === 0 && verdict.stale.length === 0) {
    process.stdout.write('check-runtime-detection — OK (no runtime detection in package src).\n');
    return;
  }
  process.stderr.write(
    'check-runtime-detection — code picks its runtime by construction (COR-1784), not by detecting it.\n' +
      'Remove the branch because the package is single-runtime, use an API Bun and Node.js both provide\n' +
      '(`process.env`, `node:crypto`, `process.getBuiltinModule`), or take the runtime-specific piece from\n' +
      'the caller. A site that must stay goes in scripts/runtime-detection-allowlist.json with a reason.\n\n',
  );
  for (const site of verdict.unlisted) process.stderr.write(`  ${site}\n`);
  for (const entry of verdict.stale) process.stderr.write(`  stale allowlist entry: ${entry}\n`);
  process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error('check-runtime-detection failed:', error);
    process.exitCode = 1;
  });
}
