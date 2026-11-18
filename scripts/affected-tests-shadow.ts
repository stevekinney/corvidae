#!/usr/bin/env bun
/** Replay the existing selector over frozen provider evidence without changing its graph rules. */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { type SourceTree, type WorkspaceDescription } from './affected-tests-graph.ts';
import { selectTests } from './affected-tests-selection.ts';
import { failureRecords } from './chef/ci-compare.ts';

interface FrozenRun {
  frozenSample?: { databaseId?: number; headSha?: string; status?: string; conclusion?: string };
  jobs?: { name?: string; conclusion?: string; status?: string }[];
  evidenceDisposition?: string;
  gitInputs?: { changedPaths?: string[]; toolchain?: unknown; workflow?: unknown };
  failureJobs?: unknown;
}

interface ShadowFailure {
  job: string;
  classification: 'unattributable';
  reason: string;
}

/** Correlate parser-provided failing test identities with the selector's exact test paths. */
export function omittedFailures(
  selected: readonly string[],
  failures: readonly string[],
): string[] {
  return failures.filter(
    (failure) =>
      !selected.some((test) => failure.includes(test.split('/').at(-1)!.replace(/\.ts$/, ''))),
  );
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
  // `git cat-file --batch` accepts every revision:path request on one stream. The selector reads
  // source and manifests repeatedly, so one object process per file made replay impractically slow.
  const requested = [...paths]
    .filter((path) => /\.(?:[cm]?[jt]sx?|svelte|css)$/.test(path) || path.endsWith('package.json'))
    .map((path) => `${revision}:${path}`);
  const result = Bun.spawnSync({
    cmd: ['git', '-C', root, 'cat-file', '--batch'],
    stdin: new Blob([`${requested.join('\n')}\n`]),
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  const output = result.stdout;
  const cache = new Map<string, string>();
  let offset = 0;
  for (const path of requested.map((request) => request.slice(revision.length + 1))) {
    const newline = output.indexOf(10, offset);
    if (newline < 0) throw new Error('git cat-file batch ended before its header');
    const header = output.subarray(offset, newline).toString();
    offset = newline + 1;
    const match = /^(\S+) (\S+) (\d+)$/.exec(header);
    if (match === null) throw new Error(`git cat-file could not read ${path}: ${header}`);
    const size = Number(match[3]);
    cache.set(path, output.subarray(offset, offset + size).toString());
    offset += size + 1;
  }
  return {
    paths,
    read: (path) => cache.get(path),
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

function changedBetween(root: string, base: string, revision: string): string[] {
  return git(root, ['diff', '--name-only', '--no-renames', `${base}...${revision}`])
    .split('\n')
    .filter(Boolean);
}

export function replayRevision(
  root: string,
  input: { name: string; revision: string; base: string; provider: unknown; failureLog?: string },
) {
  const changed = changedBetween(root, input.base, input.revision);
  const tree = treeAt(root, input.revision);
  const selection = selectTests({ changed, tree, workspaces: workspacesAt(tree) });
  const selected = selection.workspaces.flatMap((workspace) => [...workspace.tests.keys()]);
  const jobs = (input.provider as { jobs?: { name?: string; conclusion?: string }[] }).jobs ?? [];
  const fullRunFailures = jobs
    .filter((job) => job.conclusion === 'failure')
    .map((job) => job.name ?? 'unnamed job');
  const attributedFailures =
    input.failureLog === undefined
      ? []
      : [...failureRecords(readFileSync(input.failureLog, 'utf8')).values()].flatMap((records) =>
          records
            .filter((record) => record.kind === 'test' && record.identity !== undefined)
            .map((record) => record.identity!),
        );
  const omitted = omittedFailures(selected, attributedFailures);
  return {
    name: input.name,
    disposition: 'complete',
    revision: input.revision,
    base: input.base,
    changed,
    selected,
    fullRunFailures,
    attributedFailures,
    omittedFailures: omitted,
    unclassifiedFailures: fullRunFailures.map((job) => ({
      job,
      classification: 'unattributable',
      reason:
        'Candidate provider evidence has no test-level execution inventory for this failed job.',
    })),
    inputIdentity: input.provider,
  };
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
  // Job-level conclusions and text logs do not contain the executed test inventory. A job failure
  // therefore cannot demonstrate that an omitted test caused it. Preserve it as inconclusive
  // instead of turning missing attribution into a false zero-miss result.
  const unclassifiedFailures: ShadowFailure[] = fullRunFailures.map((job) => ({
    job,
    classification: 'unattributable',
    reason: 'Frozen provider evidence has no test-level execution inventory for this failed job.',
  }));
  return {
    disposition: unclassifiedFailures.length === 0 ? 'complete' : 'inconclusive',
    revision,
    changed,
    selected,
    fullRunFailures,
    omittedFailures: [],
    unclassifiedFailures,
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
  const programRoot = join(directory, '..');
  const candidates = [
    {
      name: 'P01 accepted full run 44228027813',
      revision: '42b4d875a5f3fe1577a5d267144fc747a456c57b',
      base: '721367ba220dc2384c83ee1c33b3a38bdf702e5b',
      provider: JSON.parse(
        readFileSync(join(programRoot, 'p01/44228027813-final-provider.json'), 'utf8'),
      ),
    },
    {
      name: 'P02 accepted full run 44228086147',
      revision: '7d249e3844835d78700a2bf01e2ef95aaa41fbcc',
      base: '42b4d875a5f3fe1577a5d267144fc747a456c57b',
      provider: JSON.parse(
        readFileSync(join(programRoot, 'p02/44228086147-final-provider.json'), 'utf8'),
      ),
    },
    {
      name: 'P03 accepted full run 44263346832',
      revision: 'da7aaee4858196b0c186efaf50c76b931637d22f',
      base: '4f46c230831feee0459eec754762ed7b317f4b51',
      provider: JSON.parse(
        readFileSync(join(programRoot, 'p03/44263346832-provider-jobs.json'), 'utf8'),
      ),
    },
    {
      name: 'P10 accepted full run 44242619821',
      revision: '11ace640a1f670159bee00aa9fccb20432d2d652',
      base: '4e5a72dc4d1afff1a5adcd9ce0b9e2277cd92ec5',
      provider: JSON.parse(
        readFileSync(join(programRoot, 'p10/44242619821-final-provider.json'), 'utf8'),
      ),
    },
    {
      name: 'P10 failed full run 44228035610',
      revision: '485d8a3300e4f98e774c128684617c5cd5ad0592',
      base: '42b4d875a5f3fe1577a5d267144fc747a456c57b',
      provider: JSON.parse(
        readFileSync(join(programRoot, 'p10/44228035610-final-provider.json'), 'utf8'),
      ),
      failureLog: join(programRoot, 'p10/full-slow-failure.log'),
    },
  ].map((candidate) => replayRevision(root, candidate));
  const summary = {
    version: 1,
    runs,
    programCandidates: candidates,
    unresolvedDemonstratedMisses: [...runs, ...candidates].flatMap((run) => run.omittedFailures),
  };
  writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(
    JSON.stringify({
      runs: runs.length,
      unresolvedDemonstratedMisses: summary.unresolvedDemonstratedMisses.length,
    }),
  );
}
