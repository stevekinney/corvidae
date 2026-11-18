import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
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
  environment: string;
  command: string;
  relevantInputs: string[];
  inventory: string[];
  artifact?: string | undefined;
  exitCode: number | null;
  assertionPassed: boolean | null;
  dirtyContentIdentity?: string | undefined;
}

/** A collection returned by a coordinator-owned local collector or authenticated provider read. */
export interface CollectedEvidence {
  source: 'coordinator' | 'provider';
  records: EvidenceRecord[];
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
}

export interface LocalEvidenceProcess {
  run(
    argv: string[],
    cwd: string,
  ): {
    exitCode: number;
    inventory: string[];
    assertionPassed: boolean | null;
    reportPaths?: string[];
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
  return {
    source: 'provider',
    records: request.providerRuns.map((entry) => {
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
  };
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
  return {
    source: 'coordinator',
    records: request.plan.obligations
      .filter((item) => item.executionBoundary !== 'provider')
      .map((item) => {
        const result = process.run(commandArgv(item.commandOrProviderJob), safeCwd);
        let inventory = result.inventory;
        let assertionPassed = result.assertionPassed;
        for (const reportPath of result.reportPaths ?? []) {
          const path = resolve(safeCwd, reportPath);
          if (!path.startsWith(`${safeCwd}/`) || !existsSync(path) || !statSync(path).isFile())
            throw new EvidenceRequestError('local report path is invalid');
          const parsed = parseJUnit(new Uint8Array(readFileSync(path)));
          inventory = [...inventory, ...parsed.inventory];
          if (!parsed.assertionPassed) assertionPassed = false;
        }
        return {
          obligation: obligationKey(item),
          status: result.exitCode === 0 && assertionPassed !== false ? 'pass' : 'fail',
          revision: request.revision,
          integrationTree: request.integrationTree,
          environment: request.environment,
          command: item.commandOrProviderJob,
          relevantInputs: item.relevantInputs,
          inventory,
          exitCode: result.exitCode,
          assertionPassed,
        };
      }),
  };
}

/** The local collection boundary: parse and validate before any owned process starts. */
export function collectLocalEvidenceFromRequest(
  path: string,
  digest: string,
  executor: LocalEvidenceProcess = {
    run(argv, cwd) {
      const result = Bun.spawnSync(argv, { cwd, stdout: 'pipe', stderr: 'pipe' });
      return { exitCode: result.exitCode, inventory: [], assertionPassed: null };
    },
  },
  cwd = process.cwd(),
): CollectedEvidence {
  return collectLocalEvidence(readVerificationRequest(path, digest), executor, cwd);
}

function obligationKey(obligation: VerificationObligation): string {
  return `${obligation.criterionId}:${obligation.commandOrProviderJob}`;
}

function artifactIsIntact(record: EvidenceRecord): boolean {
  return (
    record.artifact === undefined ||
    (existsSync(record.artifact) && statSync(record.artifact).isFile())
  );
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
  if (!obligation.relevantInputs.every((input) => record.relevantInputs.includes(input)))
    problems.push(`${record.obligation} lacks a relevant input identity`);
  if (obligation.expectedInventory.length > 0 && record.inventory.length === 0)
    problems.push(`${record.obligation} unexpectedly discovered no tests or jobs`);
  if (!obligation.expectedInventory.every((item) => record.inventory.includes(item)))
    problems.push(`${record.obligation} lacks required inventory`);
  if (!artifactIsIntact(record))
    problems.push(`${record.obligation} has a missing or corrupt artifact`);
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
