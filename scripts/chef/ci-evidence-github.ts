// Usage:
//   bun scripts/chef/ci-evidence-github.ts --request <file> --state-directory <dir> [--ref <branch>]
// Exit 0 for bound, 1 for pending/failed/ambiguous, 2 for invalid input or configuration.
import { createHash } from 'node:crypto';

import { unzipSync } from 'fflate';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';

import {
  CiEvidenceError,
  createCiEvidenceStore,
  reconcileCiEvidenceRequest,
  type CiEvidenceObservation,
  type CiEvidenceProvider,
  type CiEvidenceRequest,
  type CiEvidenceRun,
} from './ci-evidence.ts';
import {
  createGitHubEvidenceTransport,
  type RawCommandResponse,
  type RawCommandTransport,
} from './evidence-provider.ts';
import { createExecutionStateStore } from './execution-state.ts';
import { parseOptions, requireOption, UsageError } from './process-runner.ts';

interface GitHubObject {
  object?: unknown;
  id?: unknown;
  total_count?: unknown;
  workflow_runs?: unknown;
  jobs?: unknown;
  head_sha?: unknown;
  event?: unknown;
  name?: unknown;
  path?: unknown;
  display_title?: unknown;
  run_attempt?: unknown;
  status?: unknown;
  conclusion?: unknown;
  pull_requests?: unknown;
  head?: unknown;
  base?: unknown;
  sha?: unknown;
  repository?: unknown;
  workflowPath?: unknown;
  workflowRevision?: unknown;
  requestKey?: unknown;
  planDigest?: unknown;
  candidate?: unknown;
  checkedRevision?: unknown;
  checkedTree?: unknown;
  runId?: unknown;
  attempt?: unknown;
  reports?: unknown;
  testCases?: unknown;
}

export interface GitReader {
  tree(revision: string): string | undefined;
  parents(revision: string): string[] | undefined;
}

export interface GitHubCiEvidenceProviderOptions {
  repository: string;
  /** A published branch or tag, never an arbitrary SHA, used for workflow dispatch. */
  dispatchRef?: string;
  raw?: RawCommandTransport;
  git?: GitReader;
  cwd?: string;
}

interface Receipt {
  repository: string;
  event: string;
  workflowPath: string;
  workflowRevision: string;
  requestKey: string;
  planDigest: string;
  base: string;
  candidate: string;
  checkedRevision: string;
  checkedTree: string;
  runId: number;
  attempt: number;
  jobs: Record<string, 'success' | 'not-applicable'>;
  reports?: Record<string, { reports: number; testCases: number }>;
}

const sha = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
const digest = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const integer = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;

function object(value: unknown): GitHubObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new CiEvidenceError('authenticated GitHub response has invalid shape');
  return value;
}

function defaultRaw(): RawCommandTransport {
  return {
    run(argv) {
      const result = Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'pipe' });
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    },
  };
}

function defaultGit(cwd: string): GitReader {
  const output = (arguments_: string[]): string | undefined => {
    const result = Bun.spawnSync(['git', ...arguments_], { cwd, stdout: 'pipe', stderr: 'pipe' });
    return result.exitCode === 0 ? new TextDecoder().decode(result.stdout).trim() : undefined;
  };
  return {
    tree(revision) {
      return output(['rev-parse', '--verify', `${revision}^{tree}`]);
    },
    parents(revision) {
      const value = output(['show', '--no-patch', '--format=%P', revision]);
      return value === undefined ? undefined : value.split(' ').filter(sha);
    },
  };
}

function query(raw: RawCommandTransport, arguments_: string[]): GitHubObject {
  const result = raw.run(arguments_);
  if (result.exitCode !== 0) throw new CiEvidenceError('authenticated GitHub query failed');
  try {
    return object(JSON.parse(new TextDecoder().decode(result.stdout)));
  } catch (error) {
    if (error instanceof CiEvidenceError) throw error;
    throw new CiEvidenceError('authenticated GitHub response was not JSON');
  }
}

/** Reads every numbered page and rejects incomplete or inconsistent provider pagination. */
function pages(
  raw: RawCommandTransport,
  repository: string,
  path: string,
  key: 'workflow_runs' | 'jobs',
): GitHubObject[] {
  const values: GitHubObject[] = [];
  let expected: number | undefined;
  for (let page = 1; page <= 1000; page += 1) {
    const separator = path.includes('?') ? '&' : '?';
    const response = query(raw, [
      'gh',
      'api',
      `repos/${repository}/${path}${separator}per_page=100&page=${page}`,
    ]);
    const total = integer(response.total_count);
    const entries = response[key];
    if (total === undefined || !Array.isArray(entries))
      throw new CiEvidenceError('authenticated GitHub page has invalid shape');
    if (expected === undefined) expected = total;
    if (expected !== total || values.length + entries.length > expected)
      throw new CiEvidenceError('authenticated GitHub pagination is inconsistent');
    values.push(...entries.map(object));
    if (values.length === expected) return values;
    if (entries.length === 0)
      throw new CiEvidenceError('authenticated GitHub pagination is incomplete');
  }
  throw new CiEvidenceError('authenticated GitHub pagination exceeds limit');
}

function workflowFile(path: string): string {
  return path.startsWith('.github/workflows/') ? path.slice('.github/workflows/'.length) : path;
}

function pullRequestIdentity(run: GitHubObject): { head: string; base: string } | undefined {
  if (!Array.isArray(run.pull_requests) || run.pull_requests.length !== 1) return undefined;
  const pullRequest = object(run.pull_requests[0]);
  const head = object(pullRequest.head);
  const base = object(pullRequest.base);
  return sha(head.sha) && sha(base.sha) ? { head: head.sha, base: base.sha } : undefined;
}

function parseReceipt(value: unknown): Receipt {
  const receipt = object(value);
  const strings = [
    'repository',
    'event',
    'workflowPath',
    'workflowRevision',
    'requestKey',
    'planDigest',
    'base',
    'candidate',
    'checkedRevision',
    'checkedTree',
  ] as const;
  if (!strings.every((field) => typeof receipt[field] === 'string'))
    throw new CiEvidenceError('CI evidence receipt has invalid fields');
  const names = Object.keys(receipt);
  if (
    !names.every((name) => [...strings, 'runId', 'attempt', 'jobs', 'reports'].includes(name)) ||
    !['runId', 'attempt', 'jobs'].every((name) => Object.hasOwn(receipt, name))
  )
    throw new CiEvidenceError('CI evidence receipt has an invalid contract');
  if (
    !sha(receipt.workflowRevision) ||
    !digest(receipt.planDigest) ||
    ![receipt.base, receipt.candidate, receipt.checkedRevision, receipt.checkedTree].every(sha) ||
    !Number.isSafeInteger(receipt.runId) ||
    (receipt.runId as number) < 1 ||
    !Number.isSafeInteger(receipt.attempt) ||
    (receipt.attempt as number) < 1
  )
    throw new CiEvidenceError('CI evidence receipt has invalid identity');
  const jobs = object(receipt.jobs);
  if (
    Object.keys(jobs).length === 0 ||
    !Object.entries(jobs).every(
      ([name, status]) =>
        /^[A-Za-z0-9_-]+$/.test(name) && (status === 'success' || status === 'not-applicable'),
    )
  )
    throw new CiEvidenceError('CI evidence receipt has an invalid job inventory');
  const reports = receipt.reports === undefined ? undefined : object(receipt.reports);
  if (
    reports !== undefined &&
    !Object.entries(reports).every(([name, summary]) => {
      const detail = object(summary);
      return (
        /^[A-Za-z0-9_.-]+$/.test(name) &&
        Number.isSafeInteger(detail.reports) &&
        (detail.reports as number) > 0 &&
        Number.isSafeInteger(detail.testCases) &&
        (detail.testCases as number) > 0
      );
    })
  )
    throw new CiEvidenceError('CI evidence receipt has invalid report summaries');
  return receipt as unknown as Receipt;
}

const MAX_RECEIPT_BYTES = 64 * 1024;

function readReceipt(bytes: Uint8Array, artifactDigest: string | undefined): Receipt {
  if (bytes.length === 0 || bytes.length > MAX_RECEIPT_BYTES)
    throw new CiEvidenceError('CI receipt archive exceeds its size bound');
  const computed = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (artifactDigest !== computed)
    throw new CiEvidenceError('CI receipt digest does not match authenticated artifact metadata');
  let files: Record<string, Uint8Array>;
  try {
    let entries = 0;
    files = unzipSync(bytes, {
      filter(entry) {
        entries++;
        if (entries !== 1 || entry.name !== 'ci-evidence-receipt.json')
          throw new CiEvidenceError('CI receipt artifact has an invalid inventory');
        if (entry.originalSize < 1 || entry.originalSize > MAX_RECEIPT_BYTES)
          throw new CiEvidenceError('CI receipt archive exceeds its expansion bound');
        return true;
      },
    });
  } catch (error) {
    if (error instanceof CiEvidenceError) throw error;
    throw new CiEvidenceError('CI receipt artifact is not a ZIP archive');
  }
  const content = files['ci-evidence-receipt.json'];
  if (
    content === undefined ||
    content.length > MAX_RECEIPT_BYTES ||
    Object.keys(files).length !== 1
  )
    throw new CiEvidenceError('CI receipt artifact has an invalid inventory');
  try {
    return parseReceipt(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content)));
  } catch (error) {
    if (error instanceof CiEvidenceError) throw error;
    throw new CiEvidenceError('CI receipt artifact is not JSON');
  }
}

function bindsCheckout(request: CiEvidenceRequest, receipt: Receipt, git: GitReader): boolean {
  if (git.tree(receipt.checkedRevision) !== receipt.checkedTree) return false;
  if (request.event !== 'pull_request')
    return (
      receipt.checkedRevision === request.candidate &&
      receipt.checkedTree === request.integrationTree
    );
  const parents = git.parents(receipt.checkedRevision);
  return (
    receipt.checkedTree === request.integrationTree &&
    parents?.length === 2 &&
    parents[0] === request.base &&
    parents[1] === request.candidate
  );
}

/**
 * Authenticated `gh` implementation for the durable CI evidence provider. A run becomes usable
 * only after its attempt-scoped receipt artifact binds the requested identity to local Git data.
 */
export function createGitHubCiEvidenceProvider(
  options: GitHubCiEvidenceProviderOptions,
): CiEvidenceProvider {
  const raw = options.raw ?? defaultRaw();
  const git = options.git ?? defaultGit(options.cwd ?? process.cwd());
  const transport = createGitHubEvidenceTransport(options.repository, raw, options.cwd);
  const dispatchRef = options.dispatchRef;
  return {
    async findRuns(request) {
      if (request.repository !== options.repository)
        throw new CiEvidenceError('CI evidence request repository differs from provider');
      const candidates = pages(
        raw,
        request.repository,
        `actions/workflows/${workflowFile(request.workflowPath)}/runs?event=${encodeURIComponent(request.event)}&head_sha=${request.candidate}`,
        'workflow_runs',
      ).filter(
        (run) =>
          text(run.event) === request.event &&
          text(run.head_sha) === request.candidate &&
          text(run.path) === request.workflowPath &&
          text(run.name) === request.workflow &&
          (request.event === 'workflow_dispatch'
            ? text(run.display_title) === `P07 ${request.requestKey}`
            : true) &&
          (request.event === 'pull_request'
            ? pullRequestIdentity(run)?.head === request.candidate &&
              pullRequestIdentity(run)?.base === request.base
            : true),
      );
      return candidates.map((run): CiEvidenceObservation => {
        const id = integer(run.id);
        const attempt = integer(run.run_attempt);
        if (id === undefined || id < 1 || attempt === undefined || attempt < 1)
          throw new CiEvidenceError('authenticated CI run has invalid identity');
        const runDetail = transport.run(id);
        if (
          runDetail.repository !== request.repository ||
          runDetail.revision !== request.candidate ||
          runDetail.workflow !== request.workflow ||
          runDetail.workflowPath !== request.workflowPath ||
          runDetail.event !== request.event ||
          runDetail.attempt !== attempt
        )
          throw new CiEvidenceError('authenticated CI run details changed during collection');
        if (runDetail.status !== 'completed') return { state: 'pending', id, attempt };
        if (runDetail.conclusion === 'cancelled') return { state: 'canceled', id, attempt };
        if (runDetail.conclusion !== 'success') return { state: 'failed', id, attempt };
        const metadata = transport.artifact(id, `ci-evidence-receipt-${attempt}`);
        if (!metadata.present || metadata.expired || metadata.id === undefined)
          throw new CiEvidenceError('authenticated CI run has no usable receipt artifact');
        if (
          metadata.sizeBytes === undefined ||
          metadata.sizeBytes < 1 ||
          metadata.sizeBytes > MAX_RECEIPT_BYTES
        )
          throw new CiEvidenceError('authenticated CI receipt exceeds its declared size bound');
        const archive = transport.downloadArtifact?.(metadata.id);
        if (archive === undefined) throw new CiEvidenceError('CI receipt download is unavailable');
        const receipt = readReceipt(archive, metadata.digest);
        if (
          receipt.repository !== request.repository ||
          receipt.event !== request.event ||
          receipt.workflowPath !== request.workflowPath ||
          receipt.workflowRevision !== request.workflowRevision ||
          (request.event === 'pull_request'
            ? receipt.requestKey !== ''
            : receipt.requestKey !== request.requestKey) ||
          receipt.planDigest !== request.verificationPlanDigest ||
          receipt.base !== request.base ||
          receipt.candidate !== request.candidate ||
          receipt.runId !== id ||
          receipt.attempt !== attempt ||
          !bindsCheckout(request, receipt, git)
        )
          throw new CiEvidenceError(
            'authenticated CI receipt does not bind the requested candidate',
          );
        const jobRecords = pages(raw, request.repository, `actions/runs/${id}/jobs`, 'jobs');
        const jobs = jobRecords.map((job) => text(job.name)).filter(Boolean);
        if (jobs.length === 0 || new Set(jobs).size !== jobs.length)
          throw new CiEvidenceError('authenticated CI run has invalid job inventory');
        const aggregate = jobRecords.filter((job) => text(job.name) === 'Evidence aggregate');
        if (
          aggregate.length !== 1 ||
          text(aggregate[0]?.status) !== 'completed' ||
          text(aggregate[0]?.conclusion) !== 'success'
        )
          throw new CiEvidenceError(
            'authenticated CI Evidence aggregate did not complete successfully',
          );
        if (Object.values(receipt.jobs).some((status) => status !== 'success'))
          throw new CiEvidenceError('CI receipt declares a required job not successful');
        const evidenceRun: CiEvidenceRun = {
          id,
          repository: request.repository,
          head: request.candidate,
          base: request.base,
          integrationTree: receipt.checkedTree,
          event: request.event,
          workflow: request.workflow,
          workflowPath: request.workflowPath,
          workflowRevision: receipt.workflowRevision,
          verificationPlanDigest: receipt.planDigest,
          requestKey: request.requestKey,
          receiptRequestKey: receipt.requestKey,
          checkedRevision: receipt.checkedRevision,
          checkedTree: receipt.checkedTree,
          receiptJobs: receipt.jobs,
          ...(receipt.reports === undefined ? {} : { receiptReports: receipt.reports }),
          attempt,
          jobs,
        };
        return evidenceRun;
      });
    },
    async dispatch(request) {
      if (dispatchRef === undefined || !/^[A-Za-z0-9._/-]+$/.test(dispatchRef))
        throw new CiEvidenceError('CI evidence dispatch requires a named branch or tag ref');
      const reference = query(raw, [
        'gh',
        'api',
        `repos/${request.repository}/git/ref/heads/${encodeURIComponent(dispatchRef)}`,
      ]);
      const published = object(reference.object).sha;
      if (!sha(published) || published !== request.candidate)
        throw new CiEvidenceError(
          'CI evidence dispatch ref does not publish the requested candidate',
        );
      const result: RawCommandResponse = raw.run([
        'gh',
        'workflow',
        'run',
        workflowFile(request.workflowPath),
        '--repo',
        request.repository,
        '--ref',
        dispatchRef,
        '-f',
        `verification_request=${request.requestKey}`,
        '-f',
        `verification_plan=${request.verificationPlanDigest}`,
        '-f',
        `verification_base=${request.base}`,
      ]);
      if (result.exitCode !== 0) throw new CiEvidenceError('CI evidence dispatch failed');
    },
  };
}

/** Reconcile one coordinator-pinned request and emit the run or compact pending state. */
export async function runCiEvidence(
  argv: string[],
  provider?: CiEvidenceProvider,
): Promise<{ code: number; output: string }> {
  const parsed = parseOptions(argv, { values: ['request', 'state-directory', 'ref'] });
  if (parsed.positionals.length > 0) throw new UsageError('Unexpected CI evidence argument');
  const request: CiEvidenceRequest = JSON.parse(
    readFileSync(requireOption(parsed, 'request'), 'utf8'),
  );
  const stateDirectory = resolve(requireOption(parsed, 'state-directory'));
  const dispatchRef = parsed.values['ref'];
  if (request.event === 'workflow_dispatch' && dispatchRef === undefined)
    throw new UsageError('--ref is required for a manual CI evidence request');

  const state = createExecutionStateStore({ stateDirectory, hostId: hostname() });
  const result = await reconcileCiEvidenceRequest(
    createCiEvidenceStore(state),
    request,
    provider ??
      createGitHubCiEvidenceProvider({
        repository: request.repository,
        ...(dispatchRef === undefined ? {} : { dispatchRef }),
      }),
  );
  return { code: result.state === 'bound' ? 0 : 1, output: JSON.stringify(result) };
}

if (import.meta.main) {
  try {
    const result = await runCiEvidence(Bun.argv.slice(2));
    process.stdout.write(result.output + '\n');
    process.exitCode = result.code;
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
    process.exitCode = 2;
  }
}
