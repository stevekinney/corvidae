/**
 * Guards public library exports from silently reaching Bun-only or test-only code.
 */
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
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
export interface ExportRuntimeReachReport {
  findings: ExportRuntimeReachFinding[];
  nodeFindings: ExportRuntimeReachFinding[];
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

function workspaces(root: string): Workspace[] {
  return WORKSPACE_DIRECTORIES.flatMap((parent) => {
    const directory = join(root, parent);
    return existsSync(directory)
      ? readdirSync(directory, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .flatMap((entry) => {
            const workspace = join(directory, entry.name);
            try {
              const manifest = JSON.parse(
                readFileSync(join(workspace, 'package.json'), 'utf8'),
              ) as {
                name?: unknown;
                exports?: Record<string, unknown>;
              };
              if (typeof manifest.name !== 'string' || manifest.exports === undefined) return [];
              return [
                {
                  directory: workspace,
                  name: manifest.name,
                  exports: Object.fromEntries(
                    Object.entries(manifest.exports).flatMap(([subpath, target]) => {
                      const source = sourceFromExport(target);
                      return source === undefined ? [] : [[subpath, source]];
                    }),
                  ),
                },
              ];
            } catch {
              return [];
            }
          })
      : [];
  }).toSorted((left, right) => left.name.localeCompare(right.name));
}

function workspaceSpecifierPaths(allWorkspaces: readonly Workspace[]): Map<string, string> {
  const paths = new Map<string, string>();
  for (const workspace of allWorkspaces) {
    for (const [subpath, source] of Object.entries(workspace.exports)) {
      paths.set(
        subpath === '.' ? workspace.name : `${workspace.name}/${subpath.slice(2)}`,
        join(workspace.directory, source),
      );
    }
  }
  return paths;
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
  return [...members];
}

function inputPath(root: string, input: string): string | undefined {
  return [input, join(root, input), join(process.cwd(), input)].find((candidate) =>
    existsSync(candidate),
  );
}

async function findingsForExport(
  root: string,
  workspace: Workspace,
  subpath: string,
  source: string,
  workspacePaths: ReadonlyMap<string, string>,
): Promise<ExportRuntimeReachReport> {
  const result = await Bun.build({
    entrypoints: [join(workspace.directory, source)],
    target: 'browser',
    conditions: ['workerd', 'worker', 'browser'],
    metafile: true,
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
            if (NODE_BUILTINS.has(argument.path)) return { path: argument.path, external: true };
            return undefined;
          });
        },
      },
    ],
  });
  if (!result.success)
    throw new Error(
      `${workspace.name} ${subpath}: bundle failed\\n${result.logs.map((log) => log.message).join('\\n')}`,
    );
  const findings = new Set<string>();
  const nodeFindings = new Set<string>();
  for (const [input, metadata] of Object.entries(result.metafile?.inputs ?? {})) {
    for (const imported of metadata.imports) {
      if (imported.external && imported.path.startsWith('bun:')) findings.add(imported.path);
      if (imported.external && NODE_BUILTINS.has(imported.path.replace(/^node:/, '')))
        nodeFindings.add(`node:${imported.path.replace(/^node:/, '')}`);
    }
    const path = inputPath(root, input);
    if (path === undefined) continue;
    for (const member of bunMembers(path)) findings.add(member);
    const sourcePath = relative(realpathSync(root), realpathSync(path)).replaceAll('\\\\', '/');
    if (!testingExport(subpath) && TEST_PATH.test(`/${sourcePath}`)) {
      findings.add(`test-kit: ${sourcePath}`);
    }
  }
  const asFindings = (values: ReadonlySet<string>) =>
    [...values].toSorted().map((finding) => ({ package: workspace.name, subpath, finding }));
  return { findings: asFindings(findings), nodeFindings: asFindings(nodeFindings) };
}

export async function scanExportRuntimeReachReport(root = ROOT): Promise<ExportRuntimeReachReport> {
  const allWorkspaces = workspaces(root);
  const paths = workspaceSpecifierPaths(allWorkspaces);
  const findings: ExportRuntimeReachFinding[] = [];
  const nodeFindings: ExportRuntimeReachFinding[] = [];
  for (const workspace of allWorkspaces)
    for (const [subpath, source] of Object.entries(workspace.exports)) {
      if (!subpath.includes('*') && !source.endsWith('.json') && !source.endsWith('.css')) {
        const report = await findingsForExport(root, workspace, subpath, source, paths);
        findings.push(...report.findings);
        nodeFindings.push(...report.nodeFindings);
      }
    }
  const sort = (values: ExportRuntimeReachFinding[]) =>
    values.toSorted((left, right) =>
      `${left.package}\0${left.subpath}\0${left.finding}`.localeCompare(
        `${right.package}\0${right.subpath}\0${right.finding}`,
      ),
    );
  return { findings: sort(findings), nodeFindings: sort(nodeFindings) };
}
export async function scanExportRuntimeReach(root = ROOT): Promise<ExportRuntimeReachFinding[]> {
  return (await scanExportRuntimeReachReport(root)).findings;
}

export function judgeExportRuntimeReach(
  findings: readonly ExportRuntimeReachFinding[],
  allowlist: readonly ExportRuntimeReachAllowlistEntry[],
) {
  const key = (item: ExportRuntimeReachFinding) =>
    `${item.package}\0${item.subpath}\0${item.finding}`;
  const found = new Set(findings.map(key));
  return {
    unlisted: findings.filter((finding) => !allowlist.some((entry) => key(entry) === key(finding))),
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
  const allowlist = (await Bun.file(allowlistPath).json()) as ExportRuntimeReachAllowlistEntry[];
  const verdict = judgeExportRuntimeReach(await scanExportRuntimeReach(root), allowlist);
  if (process.argv.includes('--shrink'))
    await Bun.write(allowlistPath, `${JSON.stringify(verdict.shrunk, null, 2)}\n`);
  if (verdict.unlisted.length === 0 && verdict.stale.length === 0) return;
  for (const finding of verdict.unlisted)
    console.error(`unlisted: ${finding.package} ${finding.subpath} ${finding.finding}`);
  for (const finding of verdict.stale)
    console.error(`stale: ${finding.package} ${finding.subpath} ${finding.finding}`);
  process.exitCode = 1;
}
if (import.meta.main)
  main().catch((error: unknown) => {
    console.error('check-export-runtime-reach failed:', error);
    process.exitCode = 1;
  });
