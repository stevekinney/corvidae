#!/usr/bin/env bun
/** Replay the existing selector over frozen provider evidence without changing its graph rules. */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  owningWorkspace,
  type SourceTree,
  type WorkspaceDescription,
} from './affected-tests-graph.ts';
import { selectTests } from './affected-tests-selection.ts';
import { discoverWorkspacesInTree } from './affected-tests.ts';
import { failureRecords, type FailureRecord } from './chef/ci-compare.ts';

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

interface ProviderJob {
  name?: string;
  status?: string;
  conclusion?: string;
}

interface ProviderEvidence {
  status?: string;
  conclusion?: string;
  jobs?: ProviderJob[];
}

function normalizedPath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}

function failureLocation(identity: string): { workspace: string; file: string } | undefined {
  const match = /^([^›]+) › ([^›]+?\.(?:[cm]?[jt]sx?|svelte))(?::\d+(?::\d+)?)? › /.exec(identity);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  return { workspace: match[1].trim(), file: normalizedPath(match[2].trim()) };
}

function selectedLocations(
  selected: readonly string[],
  workspaces: readonly WorkspaceDescription[],
): Map<string, Set<string>> {
  const locations = new Map<string, Set<string>>();
  for (const test of selected) {
    const workspace = owningWorkspace(test, workspaces);
    const relative = workspace.directory === '' ? test : test.slice(workspace.directory.length + 1);
    const file = normalizedPath(relative);
    const matches = locations.get(file) ?? new Set<string>();
    matches.add(`${workspace.name}›${file}`);
    locations.set(file, matches);
  }
  return locations;
}

function terminalEvidence(provider: ProviderEvidence): { failures: string[]; reason?: string } {
  const jobs = provider.jobs;
  if (provider.status !== 'completed')
    return { failures: [], reason: 'provider run is not completed' };
  if (provider.conclusion !== 'success' && provider.conclusion !== 'failure')
    return { failures: [], reason: 'provider run has no terminal conclusion' };
  if (jobs === undefined || jobs.length === 0)
    return { failures: [], reason: 'provider run has no job inventory' };
  if (
    jobs.some(
      (job) =>
        job.status !== 'completed' ||
        (job.conclusion !== 'success' && job.conclusion !== 'failure'),
    )
  )
    return {
      failures: [],
      reason: 'provider job is canceled, pending, or lacks a terminal conclusion',
    };
  return {
    failures: jobs
      .filter((job) => job.conclusion === 'failure')
      .map((job) => job.name ?? 'unnamed job'),
  };
}

/** Correlate parser-provided failing test identities with the selector's exact test paths. */
export function omittedFailures(
  selected: readonly string[],
  failures: readonly string[],
  workspaces: readonly WorkspaceDescription[],
): string[] {
  const locations = selectedLocations(selected, workspaces);
  return failures.filter((failure) => {
    const location = failureLocation(failure);
    if (location === undefined) return true;
    const candidates = locations.get(location.file);
    if (candidates === undefined) return true;
    return !candidates.has(`${location.workspace}›${location.file}`) && candidates.size !== 1;
  });
}

/** Serialize qualified and residual parser evidence without hiding an unknown behind a known test. */
export function classifyFailureRecords(
  selected: readonly string[],
  records: readonly FailureRecord[],
  failedJobs: readonly string[],
  workspaces: readonly WorkspaceDescription[],
) {
  const attributedFailures = records.flatMap((record) =>
    record.identity !== undefined && failureLocation(record.identity) !== undefined
      ? [record.identity]
      : [],
  );
  const represented = new Set(records.map((record) => record.job));
  const unclassifiedFailures = [
    ...records
      .filter(
        (record) =>
          record.kind === 'unknown' ||
          (record.identity !== undefined && failureLocation(record.identity) === undefined),
      )
      .map((record) => ({
        job: record.job,
        classification: 'unattributable' as const,
        reason:
          record.diagnostic ??
          (record.identity === undefined
            ? 'unparseable provider failure evidence'
            : 'provider test identity is not workspace-qualified'),
      })),
    ...failedJobs
      .filter((job) => !represented.has(job))
      .map((job) => ({
        job,
        classification: 'unattributable' as const,
        reason: 'missing provider failure evidence',
      })),
  ];
  return {
    attributedFailures,
    omittedFailures: omittedFailures(selected, attributedFailures, workspaces),
    unclassifiedFailures,
  };
}

/** Give an authenticated raw single-job log the job prefix the shared CI parser consumes. */
export function normalizeJobLog(job: string, log: string): string {
  return log
    .split('\n')
    .map((line) => `${job}\tUNKNOWN STEP\t${line}`)
    .join('\n');
}

function git(root: string, args: string[]) {
  const result = Bun.spawnSync(['git', '-C', root, ...args]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}

/** Resolve only an exact immutable commit object; a ref or abbreviated object cannot name evidence. */
export function immutableCommit(root: string, value: string): string {
  if (!/^[0-9a-f]{40}$/i.test(value))
    throw new Error(
      `shadow replay requires an exact 40-hex commit SHA, received ${JSON.stringify(value)}`,
    );
  const resolved = git(root, ['rev-parse', '--verify', '--quiet', `${value}^{commit}`]).trim();
  if (resolved.toLowerCase() !== value.toLowerCase())
    throw new Error(`shadow replay commit resolution changed ${value} to ${resolved}`);
  return resolved;
}

function treeAt(root: string, revision: string): SourceTree {
  const paths = new Set(
    git(root, ['ls-tree', '-r', '--name-only', revision]).split('\n').filter(Boolean),
  );
  // `git cat-file --batch` accepts every revision:path request on one stream. The selector reads
  // source and manifests repeatedly, so one object process per file made replay impractically slow.
  const requested = [...paths]
    .filter(
      (path) =>
        /\.(?:[cm]?[jt]sx?|svelte|css)$/.test(path) ||
        path.endsWith('package.json') ||
        /(?:^|\/)bunfig[^/]*\.toml$/.test(path),
    )
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

/** Read a pinned revision through the same workspace discovery used for a live tree. */
export function workspacesAtRevision(root: string, revision: string): WorkspaceDescription[] {
  return discoverWorkspacesInTree(treeAt(root, immutableCommit(root, revision)));
}

/** Select against immutable source using the exact same discovery contract as live selection. */
export function selectionAtRevision(root: string, revision: string, changed: readonly string[]) {
  const pinnedRevision = immutableCommit(root, revision);
  const tree = treeAt(root, pinnedRevision);
  const workspaces = discoverWorkspacesInTree(tree);
  return selectTests({ changed, tree, workspaces });
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
  const base = immutableCommit(root, input.base);
  const revision = immutableCommit(root, input.revision);
  const changed = changedBetween(root, base, revision);
  const tree = treeAt(root, revision);
  const workspaces = discoverWorkspacesInTree(tree);
  const selection = selectTests({ changed, tree, workspaces });
  const selected = selection.workspaces.flatMap((workspace) => [...workspace.tests.keys()]);
  const evidence = terminalEvidence(input.provider as ProviderEvidence);
  const fullRunFailures = evidence.failures;
  const records: FailureRecord[] =
    input.failureLog === undefined
      ? []
      : [
          ...failureRecords(
            normalizeJobLog(
              fullRunFailures[0] ?? input.name,
              readFileSync(input.failureLog, 'utf8'),
            ),
          ).values(),
        ].flatMap((group) => group);
  const classified = classifyFailureRecords(selected, records, fullRunFailures, workspaces);
  return {
    name: input.name,
    disposition:
      evidence.reason === undefined && classified.unclassifiedFailures.length === 0
        ? 'complete'
        : 'inconclusive',
    revision,
    base,
    changed,
    selected,
    fullRunFailures,
    ...classified,
    ...(evidence.reason === undefined ? {} : { reason: evidence.reason }),
    inputIdentity: input.provider,
  };
}

export function shadowRun(root: string, frozen: FrozenRun) {
  const revision = frozen.frozenSample?.headSha;
  const changed = frozen.gitInputs?.changedPaths ?? [];
  const pinnedRevision = revision === undefined ? undefined : immutableCommit(root, revision);
  const evidence = terminalEvidence({
    ...(frozen.frozenSample?.status === undefined ? {} : { status: frozen.frozenSample.status }),
    ...(frozen.frozenSample?.conclusion === undefined
      ? {}
      : { conclusion: frozen.frozenSample.conclusion }),
    ...(frozen.jobs === undefined ? {} : { jobs: frozen.jobs }),
  });
  if (pinnedRevision === undefined || evidence.reason !== undefined)
    return {
      disposition: 'inconclusive',
      revision: revision ?? null,
      changed,
      selected: [],
      fullRunFailures: [],
      omittedFailures: [],
      reason: evidence.reason ?? 'provider revision is missing',
    };
  const tree = treeAt(root, pinnedRevision);
  const workspaces = discoverWorkspacesInTree(tree);
  const selection = selectTests({ changed, tree, workspaces });
  const selected = selection.workspaces.flatMap((workspace) => [...workspace.tests.keys()]);
  const fullRunFailures = evidence.failures;
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
    revision: pinnedRevision,
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
