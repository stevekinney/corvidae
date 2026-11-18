import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { createGitHubEvidenceTransport, inspectArtifact, parseJUnit } from './evidence-provider.ts';
import { EvidenceRequestError, type ProviderEvidenceTransport } from './evidence-transport.ts';
import type { VerificationObligation, VerificationPlan } from './verification-plan.ts';

export { createGitHubEvidenceTransport } from './evidence-provider.ts';
export { EvidenceRequestError, type ProviderEvidenceTransport } from './evidence-transport.ts';

export type EvidenceStatus =
  'pass' | 'reused-pass' | 'fail' | 'pending' | 'canceled' | 'skipped' | 'not-applicable';

export interface EvidenceRecord {
  obligation: string;
  status: EvidenceStatus;
  revision: string;
  integrationTree: string;
  checkedTree?: string | undefined;
  environment: string;
  command: string;
  relevantInputs: string[];
  inventory: string[];
  artifact?: string | undefined;
  exitCode: number | null;
  assertionPassed: boolean | null;
  dirtyContentIdentity?: string | undefined;
  sourceRevision?: string | undefined;
  inputIdentity?: string | undefined;
  reports?: { path: string; digest: string }[] | undefined;
  artifacts?: { path: string; digest: string }[] | undefined;
  localRoot?: string | undefined;
}

/** A collection returned by a coordinator-owned local collector or authenticated provider read. */
export interface CollectedEvidence {
  source: 'coordinator' | 'provider';
  records: EvidenceRecord[];
}
const issuedCollections = new WeakSet<CollectedEvidence>();
function collected(
  source: CollectedEvidence['source'],
  records: EvidenceRecord[],
): CollectedEvidence {
  const value = { source, records };
  issuedCollections.add(value);
  return value;
}

export interface EvidenceExpectation {
  revision: string;
  integrationTree: string;
  environment: string;
}

export interface EvidenceValidation {
  ok: boolean;
  problems: string[];
  records: EvidenceRecord[];
}

export interface VerificationRequest {
  repository: string;
  revision: string;
  base: string;
  integrationTree: string;
  environment: string;
  plan: VerificationPlan;
  authority: { runId: string; ownerId: string; resource: string; generation: number };
  operationId: string;
  providerRuns: { id: number; obligation: string; job: string; artifact?: string }[];
  localRuns?: {
    obligation: string;
    argv: string[];
    reportPaths: string[];
    artifactPaths?: string[];
  }[];
}

export interface LocalEvidenceProcess {
  run(
    argv: string[],
    cwd: string,
  ): {
    exitCode: number;
  };
}

function sha256(text: string | Uint8Array): string {
  return createHash('sha256').update(text).digest('hex');
}

function safeArtifactName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
}

function commandArgv(command: string): string[] {
  const argv = command.trim().split(/\s+/);
  if (
    argv.length === 0 ||
    argv[0] === '' ||
    argv.some((part) => part.includes('\0') || part.startsWith('-'))
  )
    throw new EvidenceRequestError('verification request has invalid command argv');
  return argv;
}

/** Reads a coordinator-pinned request. Its contents are requests, never evidence. */
export function readVerificationRequest(path: string, digest: string): VerificationRequest {
  if (!/^[0-9a-f]{64}$/.test(digest))
    throw new EvidenceRequestError('verification digest is not SHA-256');
  if (!existsSync(path) || !statSync(path).isFile())
    throw new EvidenceRequestError('verification file is not a readable regular file');
  const text = readFileSync(path, 'utf8');
  if (sha256(text) !== digest)
    throw new EvidenceRequestError('verification file digest does not match');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new EvidenceRequestError('verification file is not JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new EvidenceRequestError('verification request is not an object');
  const request = value as VerificationRequest;
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(request.repository) ||
    !/^[0-9a-f]{40}$/.test(request.revision) ||
    !/^[0-9a-f]{40}$/.test(request.base) ||
    !/^[0-9a-f]{40,64}$/.test(request.integrationTree) ||
    request.environment === '' ||
    request.operationId === ''
  )
    throw new EvidenceRequestError('verification request has invalid identity');
  if (
    !request.authority ||
    request.authority.runId === '' ||
    request.authority.ownerId === '' ||
    request.authority.resource === '' ||
    !Number.isSafeInteger(request.authority.generation) ||
    request.authority.generation < 1
  )
    throw new EvidenceRequestError('verification request has invalid authority');
  if (
    !request.plan ||
    !Array.isArray(request.plan.obligations) ||
    !Array.isArray(request.providerRuns)
  )
    throw new EvidenceRequestError('verification request has invalid plan or provider runs');
  const obligations = new Map<string, VerificationObligation>();
  for (const obligation of request.plan.obligations) {
    const key = obligationKey(obligation);
    if (
      obligations.has(key) ||
      !['worker', 'coordinator', 'provider'].includes(obligation.executionBoundary) ||
      !Array.isArray(obligation.expectedInventory) ||
      !Array.isArray(obligation.relevantInputs) ||
      !obligation.expectedInventory.every((entry) => typeof entry === 'string' && entry !== '') ||
      !obligation.relevantInputs.every((entry) => typeof entry === 'string' && entry !== '') ||
      obligation.commandOrProviderJob.trim() === '' ||
      obligation.environmentToolchain.trim() === ''
    )
      throw new EvidenceRequestError('verification request has malformed plan obligation');
    if (obligation.executionBoundary !== 'provider') commandArgv(obligation.commandOrProviderJob);
    obligations.set(key, obligation);
  }
  const providerKeys = new Set<string>();
  for (const run of request.providerRuns) {
    const obligation = obligations.get(run.obligation);
    if (
      !Number.isSafeInteger(run.id) ||
      run.id < 1 ||
      run.job === '' ||
      obligation?.executionBoundary !== 'provider' ||
      providerKeys.has(run.obligation)
    )
      throw new EvidenceRequestError('verification request has invalid provider run');
    if (run.artifact !== undefined && !safeArtifactName(run.artifact))
      throw new EvidenceRequestError('verification request has invalid artifact identifier');
    providerKeys.add(run.obligation);
  }
  for (const [key, obligation] of obligations)
    if (obligation.executionBoundary === 'provider' && !providerKeys.has(key))
      throw new EvidenceRequestError('verification request lacks a provider run');
  return request;
}

/** Derives records from authenticated provider reads; it never consumes a serialized result claim. */
export function collectProviderEvidence(
  request: VerificationRequest,
  transport: ProviderEvidenceTransport,
): CollectedEvidence {
  return collected(
    'provider',
    request.providerRuns.map((entry) => {
      const run = transport.run(entry.id);
      const job = transport.job(entry.id, entry.job);
      const obligation =
        request.plan.obligations.find((item) => obligationKey(item) === entry.obligation) ??
        (() => {
          throw new EvidenceRequestError('provider run has unknown obligation');
        })();
      const artifact =
        entry.artifact === undefined ? true : transport.artifact(entry.id, entry.artifact).present;
      let inventory = job.inventory;
      let assertionPassed = job.assertionPassed;
      let artifactUsable = artifact;
      if (entry.artifact !== undefined) {
        const metadata = transport.artifact(entry.id, entry.artifact);
        try {
          if (
            !metadata.present ||
            metadata.id === undefined ||
            transport.downloadArtifact === undefined
          )
            throw new EvidenceRequestError('required artifact unavailable');
          const parsed = inspectArtifact(transport.downloadArtifact(metadata.id), metadata.digest);
          inventory = parsed.inventory;
          assertionPassed = parsed.assertionPassed;
        } catch {
          assertionPassed = false;
          artifactUsable = false;
        }
      }
      const status: EvidenceStatus =
        run.status === 'cancelled'
          ? 'canceled'
          : run.status === 'completed' && run.conclusion === 'skipped'
            ? 'skipped'
            : run.status !== 'completed' || !artifactUsable
              ? 'pending'
              : run.status === 'completed' &&
                  run.conclusion === 'success' &&
                  job.conclusion === 'success' &&
                  assertionPassed !== false &&
                  artifact
                ? 'pass'
                : 'fail';
      return {
        obligation: entry.obligation,
        status,
        revision: run.revision,
        integrationTree: request.integrationTree,
        environment: run.environment,
        command: obligation.commandOrProviderJob,
        relevantInputs: obligation.relevantInputs,
        inventory,
        exitCode: job.conclusion === 'success' ? 0 : 1,
        assertionPassed,
        artifact: entry.artifact,
      };
    }),
  );
}

/** The provider collection boundary: parse and validate before any authenticated read. */
export function collectProviderEvidenceFromRequest(
  path: string,
  digest: string,
  transport?: ProviderEvidenceTransport,
): CollectedEvidence {
  const request = readVerificationRequest(path, digest);
  return collectProviderEvidence(
    request,
    transport ?? createGitHubEvidenceTransport(request.repository),
  );
}

/** Executes the request's explicit argv through the coordinator-owned process boundary. */
export function collectLocalEvidence(
  request: VerificationRequest,
  process: LocalEvidenceProcess,
  cwd: string,
): CollectedEvidence {
  if (!isAbsolute(cwd) || !existsSync(cwd) || !statSync(cwd).isDirectory())
    throw new EvidenceRequestError('local collection cwd is not a readable directory');
  const safeCwd = resolve(cwd);
  const obligations = request.plan.obligations.filter(
    (item) => item.executionBoundary !== 'provider',
  );
  const localRuns = new Map((request.localRuns ?? []).map((run) => [run.obligation, run]));
  const commands = obligations.map((item) => {
    const run = localRuns.get(obligationKey(item));
    if (
      run === undefined ||
      !Array.isArray(run.argv) ||
      !run.argv.length ||
      !Array.isArray(run.reportPaths)
    )
      throw new EvidenceRequestError('verification request lacks a local run mapping');
    if (run.argv.some((part) => typeof part !== 'string' || part === '' || part.includes('\0')))
      throw new EvidenceRequestError('verification request has invalid local argv');
    for (const path of [...run.reportPaths, ...(run.artifactPaths ?? [])])
      if (
        typeof path !== 'string' ||
        path === '' ||
        path.includes('\0') ||
        isAbsolute(path) ||
        path.split(/[\\/]/).some((part) => part === '..')
      )
        throw new EvidenceRequestError('verification request has invalid local path');
      else if (existsSync(resolve(safeCwd, path))) validateLocalPath(safeCwd, path);
    return { item, run };
  });
  const inputPaths = [...new Set(obligations.flatMap((item) => item.relevantInputs))];
  for (const path of inputPaths) validateLocalPath(safeCwd, path);
  const before = localProvenance(safeCwd, request.base, inputPaths);
  return collected(
    'coordinator',
    commands.map(({ item, run }) => {
      const result = process.run(run.argv, safeCwd);
      let inventory: string[] = [];
      let assertionPassed: boolean | null = null;
      const reports = run.reportPaths.map((reportPath) => {
        const path = validateLocalPath(safeCwd, reportPath);
        const bytes = new Uint8Array(readFileSync(path));
        const parsed = parseJUnit(bytes);
        inventory = [...inventory, ...parsed.inventory];
        assertionPassed = assertionPassed === false || !parsed.assertionPassed ? false : true;
        return { path: relative(safeCwd, path), digest: sha256(bytes) };
      });
      const artifacts = (run.artifactPaths ?? []).map((artifactPath) => {
        const path = validateLocalPath(safeCwd, artifactPath);
        return { path: relative(safeCwd, path), digest: sha256(readFileSync(path)) };
      });
      const after = localProvenance(safeCwd, request.base, inputPaths);
      const stableInputs = before.inputIdentity === after.inputIdentity;
      const identityMatches =
        before.revision === request.revision && before.integrationTree === request.integrationTree;
      return {
        obligation: obligationKey(item),
        status:
          !identityMatches ||
          before.revision === '' ||
          before.checkedTree === '' ||
          before.integrationTree === '' ||
          before.checkedTree !== before.integrationTree ||
          after.dirtyContentIdentity !== undefined ||
          !stableInputs ||
          assertionPassed === null ||
          inventory.length === 0
            ? 'pending'
            : result.exitCode === 0 && assertionPassed
              ? 'pass'
              : 'fail',
        revision: after.revision,
        checkedTree: after.checkedTree,
        integrationTree: after.integrationTree,
        environment: after.runtime,
        command: item.commandOrProviderJob,
        relevantInputs: item.relevantInputs.map((path) => `${path}:${after.inputs[path] ?? ''}`),
        inventory,
        exitCode: result.exitCode,
        assertionPassed,
        ...(after.dirtyContentIdentity === undefined
          ? {}
          : { dirtyContentIdentity: after.dirtyContentIdentity }),
        sourceRevision: before.revision,
        inputIdentity: after.inputIdentity,
        localRoot: safeCwd,
        ...(reports.length === 0 ? {} : { reports }),
        ...(artifacts.length === 0 ? {} : { artifacts }),
      };
    }),
  );
}

/** The local collection boundary: parse and validate before any owned process starts. */
export function collectLocalEvidenceFromRequest(
  path: string,
  digest: string,
  executor: LocalEvidenceProcess = {
    run(argv, cwd) {
      const result = Bun.spawnSync(argv, { cwd, stdout: 'pipe', stderr: 'pipe' });
      return { exitCode: result.exitCode };
    },
  },
  cwd = process.cwd(),
): CollectedEvidence {
  return collectLocalEvidence(readVerificationRequest(path, digest), executor, cwd);
}

interface LocalProvenance {
  revision: string;
  checkedTree: string;
  integrationTree: string;
  runtime: string;
  inputs: Record<string, string>;
  inputIdentity: string;
  dirtyContentIdentity?: string;
}

function output(argv: string[], cwd: string): string {
  const result = Bun.spawnSync(argv, { cwd, stdout: 'pipe', stderr: 'pipe' });
  return result.exitCode === 0 ? new TextDecoder().decode(result.stdout).trim() : '';
}

function validateLocalPath(cwd: string, candidate: string): string {
  if (
    candidate === '' ||
    candidate.includes('\0') ||
    isAbsolute(candidate) ||
    candidate.split(/[\\/]/).some((part) => part === '..')
  )
    throw new EvidenceRequestError('local evidence path is invalid');
  const path = resolve(cwd, candidate);
  if (!path.startsWith(`${cwd}${sep}`) || !existsSync(path))
    throw new EvidenceRequestError('local evidence path is not a readable regular file');
  const realCwd = realpathSync(cwd);
  const realPath = realpathSync(path);
  if (!realPath.startsWith(`${realCwd}${sep}`) || !statSync(realPath).isFile())
    throw new EvidenceRequestError('local evidence path escapes the checkout');
  return realPath;
}

function localProvenance(
  cwd: string,
  requestedBase: string,
  inputs: string[],
  command = output,
): LocalProvenance {
  const revision = command(['git', 'rev-parse', 'HEAD'], cwd);
  const checkedTree = command(['git', 'rev-parse', 'HEAD^{tree}'], cwd);
  const integrationTree = command(
    ['git', 'merge-tree', '--write-tree', requestedBase, revision],
    cwd,
  );
  const runtime = command(['bun', '--version'], cwd);
  const entries = Object.fromEntries(
    inputs.map((path) => [path, sha256(readFileSync(validateLocalPath(cwd, path)))]),
  );
  const inputIdentity = sha256(JSON.stringify(entries));
  const dirty = command(
    ['git', 'status', '--porcelain', '--untracked-files=all', '--', ...inputs],
    cwd,
  );
  return {
    revision,
    checkedTree,
    integrationTree,
    runtime,
    inputs: entries,
    inputIdentity,
    ...(dirty === '' ? {} : { dirtyContentIdentity: sha256(`${dirty}\0${inputIdentity}`) }),
  };
}

/** Reissues in-memory local evidence only when the current task inputs still match the receipt. */
export function reuseLocalEvidence(
  evidence: CollectedEvidence,
  request: VerificationRequest,
  cwd: string,
  command = output,
): CollectedEvidence {
  if (!issuedCollections.has(evidence) || evidence.source !== 'coordinator')
    throw new EvidenceRequestError('local evidence was not returned by a collector');
  if (!isAbsolute(cwd) || !existsSync(cwd) || !statSync(cwd).isDirectory())
    throw new EvidenceRequestError('local collection cwd is not a readable directory');
  const safeCwd = resolve(cwd);
  const records: EvidenceRecord[] = [];
  for (const obligation of request.plan.obligations.filter(
    (item) => item.executionBoundary !== 'provider',
  )) {
    const previous = evidence.records.filter(
      (record) => record.obligation === obligationKey(obligation),
    );
    if (previous.length !== 1)
      throw new EvidenceRequestError('local evidence has no unique obligation');
    const inputs = obligation.relevantInputs;
    for (const path of inputs) validateLocalPath(safeCwd, path);
    const current = localProvenance(safeCwd, request.base, inputs, command);
    const prior = previous[0] as EvidenceRecord;
    const reportsIntact = (prior.reports ?? []).every(({ path, digest }) => {
      try {
        return sha256(readFileSync(validateLocalPath(safeCwd, path))) === digest;
      } catch {
        return false;
      }
    });
    const reusable =
      prior.status === 'pass' &&
      prior.command === obligation.commandOrProviderJob &&
      prior.inputIdentity === current.inputIdentity &&
      prior.environment === current.runtime &&
      reportsIntact &&
      artifactIsIntact(prior, safeCwd) &&
      current.dirtyContentIdentity === undefined &&
      current.revision === request.revision &&
      current.integrationTree === request.integrationTree &&
      current.checkedTree === current.integrationTree;
    records.push({
      ...prior,
      status: reusable ? 'reused-pass' : 'pending',
      revision: current.revision,
      checkedTree: current.checkedTree,
      integrationTree: current.integrationTree,
      environment: current.runtime,
      relevantInputs: inputs.map((path) => `${path}:${current.inputs[path] ?? ''}`),
      inputIdentity: current.inputIdentity,
      sourceRevision: prior.sourceRevision ?? prior.revision,
      ...(current.dirtyContentIdentity === undefined
        ? {}
        : { dirtyContentIdentity: current.dirtyContentIdentity }),
    });
  }
  return collected('coordinator', records);
}

function obligationKey(obligation: VerificationObligation): string {
  return `${obligation.criterionId}:${obligation.commandOrProviderJob}`;
}

function artifactIsIntact(record: EvidenceRecord, cwd?: string): boolean {
  if (record.artifacts !== undefined)
    return record.artifacts.every(({ path, digest }) => {
      try {
        const root = cwd ?? record.localRoot;
        if (root === undefined) return false;
        const target = validateLocalPath(root, path);
        return (
          existsSync(target) && statSync(target).isFile() && sha256(readFileSync(target)) === digest
        );
      } catch {
        return false;
      }
    });
  return (
    record.artifact === undefined ||
    (existsSync(record.artifact) && statSync(record.artifact).isFile())
  );
}

function reportsAreIntact(record: EvidenceRecord): boolean {
  if (record.reports === undefined) return true;
  if (record.localRoot === undefined) return false;
  return record.reports.every(({ path, digest }) => {
    try {
      return sha256(readFileSync(validateLocalPath(record.localRoot!, path))) === digest;
    } catch {
      return false;
    }
  });
}

function recordProblems(
  record: EvidenceRecord,
  obligation: VerificationObligation,
  expected: EvidenceExpectation,
): string[] {
  const problems: string[] = [];
  if (
    record.status !== 'pass' &&
    record.status !== 'reused-pass' &&
    record.status !== 'not-applicable'
  )
    problems.push(`${record.obligation} is ${record.status}`);
  if (record.status === 'not-applicable' && obligation.expectedInventory.length > 0)
    problems.push(`${record.obligation} is not applicable but has a required inventory`);
  if (record.revision !== expected.revision)
    problems.push(
      `${record.obligation} is for revision ${record.revision}, not ${expected.revision}`,
    );
  if (record.integrationTree !== expected.integrationTree)
    problems.push(`${record.obligation} is for a different integration tree`);
  if (record.environment !== expected.environment)
    problems.push(`${record.obligation} is for a different environment`);
  if (record.command !== obligation.commandOrProviderJob)
    problems.push(`${record.obligation} has a different command or provider job`);
  if (
    !obligation.relevantInputs.every((input) =>
      record.relevantInputs.some(
        (identity) => identity === input || identity.startsWith(`${input}:`),
      ),
    )
  )
    problems.push(`${record.obligation} lacks a relevant input identity`);
  if (obligation.expectedInventory.length > 0 && record.inventory.length === 0)
    problems.push(`${record.obligation} unexpectedly discovered no tests or jobs`);
  if (!obligation.expectedInventory.every((item) => record.inventory.includes(item)))
    problems.push(`${record.obligation} lacks required inventory`);
  if (!artifactIsIntact(record))
    problems.push(`${record.obligation} has a missing or corrupt artifact`);
  if (!reportsAreIntact(record))
    problems.push(`${record.obligation} has a missing or corrupt report`);
  if (record.exitCode !== 0 && record.status !== 'not-applicable')
    problems.push(`${record.obligation} exited ${String(record.exitCode)}`);
  if (record.assertionPassed === false)
    problems.push(`${record.obligation} has a failed structured assertion`);
  if (record.dirtyContentIdentity !== undefined && record.revision === expected.revision)
    problems.push(
      `${record.obligation} is dirty-tree evidence presented as clean revision evidence`,
    );
  return problems;
}

/**
 * Validate only records obtained by a coordinator collector or authenticated provider query. JSON
 * a worker writes is intentionally not a `CollectedEvidence` and cannot satisfy this boundary.
 */
export function validateEvidence(
  plan: VerificationPlan,
  evidence: CollectedEvidence,
  expected: EvidenceExpectation,
): EvidenceValidation {
  const problems: string[] = [];
  if (!issuedCollections.has(evidence)) problems.push('evidence was not returned by a collector');
  const records = [...evidence.records];
  for (const obligation of plan.obligations) {
    const key = obligationKey(obligation);
    const matches = records.filter((record) => record.obligation === key);
    if (matches.length !== 1) {
      problems.push(`${key} has ${matches.length === 0 ? 'no' : 'multiple'} evidence records`);
      continue;
    }
    problems.push(...recordProblems(matches[0] as EvidenceRecord, obligation, expected));
  }
  return { ok: problems.length === 0, problems, records };
}

export function renderCompletionReport(input: {
  records: EvidenceRecord[];
  requirements: { id: string; text: string }[];
  changes: string[];
  blockers: string[];
}): string {
  const requirementLines = input.requirements.map(({ id, text }) => `- ${id}: ${text}`).join('\n');
  const evidenceLines = input.records
    .map((record) => `- ${record.obligation}: ${record.status} (${record.command})`)
    .join('\n');
  return [
    'Execution report: coordinator attempt 1',
    '',
    '## Requirements implemented',
    requirementLines || '- None.',
    '',
    '## Verification',
    evidenceLines || '- No evidence collected.',
    '',
    '## Changes',
    input.changes.map((change) => `- ${change}`).join('\n') || '- None.',
    '',
    '## Blockers and open questions',
    input.blockers.map((blocker) => `- ${blocker}`).join('\n') || '- None.',
  ].join('\n');
}
