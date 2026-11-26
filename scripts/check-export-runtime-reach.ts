/**
 * Checks the runtime-specific and test-only implementation reachability of every public library
 * export. A library's Node and workerd suites prove whether a Node builtin works. This guard has
 * the narrower job of ensuring a public entry point cannot silently start importing Bun-only
 * code or a test kit.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, relative } from 'node:path';
import ts from 'typescript';

const ROOT = join(import.meta.dir, '..');
const ALLOWLIST_FILE = join(import.meta.dir, 'export-runtime-reach-allowlist.json');
const WORKSPACE_DIRECTORIES = ['packages', 'components'] as const;
const NODE_BUILTINS = new Set(builtinModules.map((name) => name.replace(/^node:/, '')));
const TEST_PATH =
  /\/(?:src\/(?:test|testing)|__fixtures__)\/|(?:\.test-support|-test-fixture)\.[^/]+$/;

export interface ExportRuntimeReachFinding {
  package: string;
  subpath: string;
  finding: string;
}

export interface ExportRuntimeReachAllowlistEntry extends ExportRuntimeReachFinding {
  reason: string;
}

interface Workspace {
  directory: string;
  name: string;
  exports: Record<string, string>;
}

function sourceFromExport(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value === null || typeof value !== 'object') return undefined;
  const conditions = value as Record<string, unknown>;
  for (const condition of ['workerd', 'worker', 'browser', 'default', 'import', 'require']) {
    const source = sourceFromExport(conditions[condition]);
    if (source !== undefined) return source;
  }
  return undefined;
}

function workspaceDirectories(root: string): string[] {
  return WORKSPACE_DIRECTORIES.flatMap((directory) => {
    const parent = join(root, directory);
    if (!existsSync(parent)) return [];
    return readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(parent, entry.name));
  });
}

function workspaces(root: string): Workspace[] {
  return workspaceDirectories(root)
    .flatMap((directory) => {
      const manifest = join(directory, 'package.json');
      try {
        return [{ directory, value: JSON.parse(readFileSync(manifest, 'utf8')) as unknown }];
      } catch {
        return [];
      }
    })
    .filter(
      (
        item,
      ): item is {
        directory: string;
        value: { name: string; exports?: Record<string, unknown> };
      } => {
        const manifest = item.value as { name?: unknown; exports?: unknown };
        return typeof manifest.name === 'string' && typeof manifest.exports === 'object';
      },
    )
    .map(({ directory, value }) => ({
      directory,
      name: value.name,
      exports: Object.fromEntries(
        Object.entries(value.exports ?? []).flatMap(([subpath, target]) => {
          const source = sourceFromExport(target);
          return source === undefined ? [] : [[subpath, source]];
        }),
      ),
    }))
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

function workspaceSpecifierPaths(allWorkspaces: readonly Workspace[]): Map<string, string> {
  const paths = new Map<string, string>();
  for (const workspace of allWorkspaces) {
    for (const [subpath, source] of Object.entries(workspace.exports)) {
      const specifier = subpath === '.' ? workspace.name : `${workspace.name}/${subpath.slice(2)}`;
      paths.set(specifier, join(workspace.directory, source));
    }
  }
  return paths;
}

function isCheckedExport(subpath: string, source: string): boolean {
  return !subpath.includes('*') && !source.endsWith('.json') && !source.endsWith('.css');
}

function testingExport(subpath: string): boolean {
  return (
    subpath === './testing' ||
    subpath.startsWith('./testing/') ||
    /^\.\/[^/]+-testing$/.test(subpath)
  );
}

function bunMembers(path: string): string[] {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const members = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Bun'
    ) {
      members.add(`Bun.${node.name.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...members].toSorted();
}

function pathFromInput(root: string, input: string): string | undefined {
  const candidates = [input, join(root, input), join(process.cwd(), input)];
  return candidates.find((candidate) => Bun.file(candidate).size > 0);
}

/** Bundles one export under workerd conditions and lists its exceptional reachable implementation. */
async function findingsForExport(
  root: string,
  workspace: Workspace,
  subpath: string,
  source: string,
  workspacePaths: ReadonlyMap<string, string> = new Map(),
): Promise<ExportRuntimeReachFinding[]> {
  const entrypoint = join(workspace.directory, source);
  const result = await Bun.build({
    entrypoints: [entrypoint],
    target: 'browser',
    conditions: ['workerd', 'worker', 'browser'],
    plugins: [
      {
        name: 'external-runtime-builtins',
        setup(build) {
          build.onResolve({ filter: /^(?:bun:|node:)/ }, (argument) => ({
            path: argument.path,
            external: true,
          }));
          build.onResolve({ filter: /\.(?:json|css)$/ }, (argument) => ({
            path: argument.path,
            external: true,
          }));
          build.onResolve({ filter: /.*/ }, (argument) => {
            const workspacePath = workspacePaths.get(argument.path);
            if (workspacePath !== undefined) return { path: workspacePath };
            if (
              /\.generated\.(?:[cm]?[jt]s)$/.test(argument.path) &&
              !existsSync(
                argument.path.startsWith('/')
                  ? argument.path
                  : join(argument.resolveDir, argument.path),
              )
            ) {
              return { path: argument.path, external: true };
            }
            if (!NODE_BUILTINS.has(argument.path)) return undefined;
            return { path: argument.path, external: true };
          });
        },
      },
    ],
    metafile: true,
  });
  if (!result.success) {
    throw new Error(
      `${workspace.name} ${subpath}: bundle failed\n${result.logs
        .map((log) => log.message)
        .join('\n')}`,
    );
  }
  const findings = new Set<string>();
  const inputs = result.metafile?.inputs ?? {};
  for (const [input, metadata] of Object.entries(inputs)) {
    for (const imported of metadata.imports) {
      if (imported.external && imported.path.startsWith('bun:')) findings.add(imported.path);
    }
    const path = pathFromInput(root, input);
    if (path === undefined) continue;
    const relativePath = relative(root, path).replaceAll('\\', '/');
    for (const member of bunMembers(path)) findings.add(member);
    if (
      !testingExport(subpath) &&
      path.startsWith(`${workspace.directory}/`) &&
      TEST_PATH.test(`/${relativePath}`)
    ) {
      findings.add(`test-kit: ${relativePath}`);
    }
  }
  return [...findings].toSorted().map((finding) => ({ package: workspace.name, subpath, finding }));
}

/** Returns all guarded reachability findings across public packages and components. */
export async function scanExportRuntimeReach(
  root: string = ROOT,
): Promise<ExportRuntimeReachFinding[]> {
  const findings: ExportRuntimeReachFinding[] = [];
  const allWorkspaces = workspaces(root);
  const workspacePaths = workspaceSpecifierPaths(allWorkspaces);
  for (const workspace of allWorkspaces) {
    for (const [subpath, source] of Object.entries(workspace.exports)) {
      if (!isCheckedExport(subpath, source)) continue;
      findings.push(...(await findingsForExport(root, workspace, subpath, source, workspacePaths)));
    }
  }
  return findings.toSorted((left, right) =>
    `${left.package}\0${left.subpath}\0${left.finding}`.localeCompare(
      `${right.package}\0${right.subpath}\0${right.finding}`,
    ),
  );
}

export interface ExportRuntimeReachVerdict {
  unlisted: ExportRuntimeReachFinding[];
  stale: ExportRuntimeReachAllowlistEntry[];
  shrunk: ExportRuntimeReachAllowlistEntry[];
}

/** Judges exact findings against the reviewed allowlist. */
export function judgeExportRuntimeReach(
  findings: readonly ExportRuntimeReachFinding[],
  allowlist: readonly ExportRuntimeReachAllowlistEntry[],
): ExportRuntimeReachVerdict {
  const key = (finding: ExportRuntimeReachFinding) =>
    `${finding.package}\0${finding.subpath}\0${finding.finding}`;
  const found = new Set(findings.map(key));
  const allowed = new Set(allowlist.map(key));
  return {
    unlisted: findings.filter((finding) => !allowed.has(key(finding))),
    stale: allowlist.filter((entry) => !found.has(key(entry))),
    shrunk: allowlist.filter((entry) => found.has(key(entry))),
  };
}

async function main(): Promise<void> {
  const rootIndex = process.argv.indexOf('--root');
  const root = rootIndex === -1 ? ROOT : process.argv[rootIndex + 1];
  if (root === undefined) throw new Error('--root needs a directory');
  const allowlistPath =
    root === ROOT ? ALLOWLIST_FILE : join(root, 'scripts/export-runtime-reach-allowlist.json');
  const allowlist: ExportRuntimeReachAllowlistEntry[] = (await Bun.file(
    allowlistPath,
  ).json()) as ExportRuntimeReachAllowlistEntry[];
  const verdict = judgeExportRuntimeReach(await scanExportRuntimeReach(root), allowlist);
  if (process.argv.includes('--shrink')) {
    await Bun.write(allowlistPath, `${JSON.stringify(verdict.shrunk, null, 2)}\n`);
    process.stdout.write(`check-export-runtime-reach — shrank ${allowlistPath}.\n`);
  }
  if (verdict.unlisted.length === 0 && verdict.stale.length === 0) {
    process.stdout.write('check-export-runtime-reach — OK.\n');
    return;
  }
  for (const finding of verdict.unlisted) {
    process.stderr.write(`unlisted: ${finding.package} ${finding.subpath} ${finding.finding}\n`);
  }
  for (const finding of verdict.stale) {
    process.stderr.write(`stale: ${finding.package} ${finding.subpath} ${finding.finding}\n`);
  }
  process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error('check-export-runtime-reach failed:', error);
    process.exitCode = 1;
  });
}
