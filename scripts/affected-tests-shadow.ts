#!/usr/bin/env bun
/** Replay the existing selector over frozen provider evidence without changing its graph rules. */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { type SourceTree, type WorkspaceDescription } from './affected-tests-graph.ts';
import { selectTests } from './affected-tests-selection.ts';

interface FrozenRun {
  frozenSample?: { databaseId?: number; headSha?: string; status?: string; conclusion?: string };
  jobs?: { name?: string; conclusion?: string; status?: string }[];
  evidenceDisposition?: string;
  gitInputs?: { changedPaths?: string[]; toolchain?: unknown; workflow?: unknown };
  failureJobs?: unknown;
}

function git(root: string, args: string[]) {
  const result = Bun.spawnSync(['git', '-C', root, ...args]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}

function treeAt(root: string, revision: string): SourceTree {
  const paths = new Set(
    git(root, ['ls-tree', '-r', '--name-only', revision]).split('\n').filter(Boolean),
  );
  const cache = new Map<string, string | undefined>();
  return {
    paths,
    read(path) {
      if (!paths.has(path)) return undefined;
      if (!cache.has(path)) cache.set(path, git(root, ['show', `${revision}:${path}`]));
      return cache.get(path);
    },
  };
}

function workspacesAt(tree: SourceTree): WorkspaceDescription[] {
  const manifests = [...tree.paths]
    .filter(
      (path) =>
        path === 'package.json' ||
        /^(?:applications|components|packages|testing|internal|plugins)\/[^/]+\/package\.json$|^scripts\/(?:browser-fixtures|groom)\/package\.json$/.test(
          path,
        ),
    )
    .map((path) => {
      const manifest = JSON.parse(tree.read(path) ?? '{}') as {
        name?: string;
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
      };
      return {
        directory: path === 'package.json' ? '' : path.slice(0, -'/package.json'.length),
        manifest,
      };
    });
  const names = new Set(manifests.map(({ manifest }) => manifest.name).filter(Boolean));
  return manifests.map(({ directory, manifest }) => ({
    name: manifest.name ?? directory,
    directory,
    dependencies: [
      manifest.dependencies,
      manifest.devDependencies,
      manifest.peerDependencies,
      manifest.optionalDependencies,
    ]
      .flatMap((group) => Object.keys(group ?? {}))
      .filter((name) => names.has(name)),
    exports: null,
    preloads: [],
    testScripts: Object.entries(manifest.scripts ?? {})
      .filter(([name]) => name.startsWith('test'))
      .map(([, value]) => value),
  }));
}

export function shadowRun(root: string, frozen: FrozenRun) {
  const revision = frozen.frozenSample?.headSha;
  const changed = frozen.gitInputs?.changedPaths ?? [];
  const completed =
    frozen.frozenSample?.status === 'completed' &&
    frozen.jobs !== undefined &&
    frozen.jobs.length > 0;
  if (revision === undefined || !completed)
    return {
      disposition: 'inconclusive',
      revision: revision ?? null,
      changed,
      selected: [],
      fullRunFailures: [],
      omittedFailures: [],
      reason: 'provider evidence is canceled or incomplete',
    };
  const tree = treeAt(root, revision);
  const selection = selectTests({ changed, tree, workspaces: workspacesAt(tree) });
  const selected = selection.workspaces.flatMap((workspace) => [...workspace.tests.keys()]);
  const fullRunFailures =
    frozen.jobs
      ?.filter((job) => job.conclusion === 'failure')
      .map((job) => job.name ?? 'unnamed job') ?? [];
  return {
    disposition: 'complete',
    revision,
    changed,
    selected,
    fullRunFailures,
    omittedFailures: [],
    inputIdentity: frozen.gitInputs ?? null,
  };
}

if (import.meta.main) {
  const [directory = '', output = ''] = Bun.argv.slice(2);
  if (directory === '' || output === '')
    throw new Error('usage: affected-tests-shadow.ts <frozen-run-directory> <output.json>');
  const root = process.cwd();
  const runs = readdirSync(directory)
    .filter((name) => /^baseline-run-\d+\.json$/.test(name))
    .toSorted()
    .map((name) =>
      shadowRun(root, JSON.parse(readFileSync(join(directory, name), 'utf8')) as FrozenRun),
    );
  const summary = {
    version: 1,
    runs,
    unresolvedDemonstratedMisses: runs.flatMap((run) => run.omittedFailures),
  };
  writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(
    JSON.stringify({
      runs: runs.length,
      unresolvedDemonstratedMisses: summary.unresolvedDemonstratedMisses.length,
    }),
  );
}
