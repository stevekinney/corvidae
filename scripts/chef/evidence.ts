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
  evidenceKind: 'process-exit' | 'test-report';
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
  provider?: {
    runId: number;
    attempt: number;
    repository: string;
    workflow: string;
    event: string;
    workflowPath: string;
    jobId: number;
    jobName: string;
    artifactRequired: boolean;
    artifact?: { id: number; digest: string; archiveDigest: string; expired: boolean };
  };
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

/** The coordinator's expected identity for a disposable installed-release verification. */
export interface InstalledReleaseReceiptExpectation {
  sourceRevision: string;
  target: 'darwin-arm64';
  archiveDigest: string;
  configuration: readonly { readonly path: string; readonly sha256: string }[];
}

/**
 * Compare the machine-written installed-release receipt with its accepted obligation. A receipt is
 * not a completion claim: publication and deployment need their own authenticated evidence.
 */
export function compareInstalledReleaseReceipt(
  receipt: unknown,
  expected: InstalledReleaseReceiptExpectation,
): string[] {
  if (typeof receipt !== 'object' || receipt === null || Array.isArray(receipt))
    return ['installed-release receipt is not an object'];
  const value = receipt as Record<string, unknown>;
  const archive = value['archive'];
  const producer = value['producer'];
  const configuration = value['configuration'];
  const assertions = value['assertions'];
  const problems: string[] = [];
  if (value['version'] !== 1 || value['outcome'] !== 'pass')
    problems.push('installed-release receipt is not a successful version 1 receipt');
  if (typeof archive !== 'object' || archive === null || Array.isArray(archive))
    problems.push('installed-release receipt has no archive identity');
  else {
    const manifest = (archive as Record<string, unknown>)['manifest'];
    if ((archive as Record<string, unknown>)['sha256'] !== expected.archiveDigest)
      problems.push('installed-release receipt archive digest does not match the obligation');
    if ((archive as Record<string, unknown>)['target'] !== expected.target)
      problems.push('installed-release receipt target does not match the obligation');
    if (
      typeof manifest !== 'object' ||
      manifest === null ||
      Array.isArray(manifest) ||
      (manifest as Record<string, unknown>)['sourceSha'] !== expected.sourceRevision
    )
      problems.push('installed-release receipt source revision does not match the obligation');
  }
  if (typeof value['installedExecutable'] !== 'string' || value['installedExecutable'] === '')
    problems.push('installed-release receipt has no installed executable');
  if (!Array.isArray(assertions) || assertions.length === 0)
    problems.push('installed-release receipt has no verification assertions');
  else if (
    assertions.some(
      (assertion) =>
        typeof assertion !== 'object' ||
        assertion === null ||
        Array.isArray(assertion) ||
        (assertion as Record<string, unknown>)['exit'] !== 0,
    )
  )
    problems.push('installed-release receipt has a failed verification assertion');
  if (
    typeof producer !== 'object' ||
    producer === null ||
    Array.isArray(producer) ||
    (producer as Record<string, unknown>)['script'] !==
      'applications/interborough/scripts/test-installed-release.ts'
  )
    problems.push('installed-release receipt has an unexpected producer');
  if (!Array.isArray(configuration))
    problems.push('installed-release receipt has no configuration');
  else
    for (const required of expected.configuration)
      if (
        !configuration.some(
          (entry) =>
            typeof entry === 'object' &&
            entry !== null &&
            !Array.isArray(entry) &&
            (entry as Record<string, unknown>)['path'] === required.path &&
            (entry as Record<string, unknown>)['sha256'] === required.sha256,
        )
      )
        problems.push(
          `installed-release receipt lacks configuration identity for ${required.path}`,
        );
  return problems;
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
  providerRuns: {
    id: number;
    obligation: string;
    job: string;
    workflow: string;
    event: string;
    workflowPath: string;
    artifact?: string;
  }[];
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

function safeProviderInput(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path !== '' &&
    !path.includes('\0') &&
    !isAbsolute(path) &&
    !path.split(/[\\/]/).some((part) => part === '..' || part === '')
  );
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
  return validateVerificationRequest(request);
}

/** Validate the complete declared plan before any member can trigger provider work. */
export function validateEvidenceObligations(
  plan: VerificationPlan,
): Map<string, VerificationObligation> {
  const obligations = new Map<string, VerificationObligation>();
  for (const obligation of plan.obligations) {
    const key = obligationKey(obligation);
    if (
      obligations.has(key) ||
      !['worker', 'coordinator', 'provider'].includes(obligation.executionBoundary) ||
      !Array.isArray(obligation.expectedInventory) ||
      !Array.isArray(obligation.relevantInputs) ||
      !['process-exit', 'test-report'].includes(obligation.evidenceKind) ||
      !obligation.expectedInventory.every((entry) => typeof entry === 'string' && entry !== '') ||
      !obligation.relevantInputs.every(safeProviderInput) ||
      obligation.commandOrProviderJob.trim() === '' ||
      obligation.environmentToolchain.trim() === ''
    )
      throw new EvidenceRequestError('verification request has malformed plan obligation');
    if (obligation.executionBoundary !== 'provider') commandArgv(obligation.commandOrProviderJob);
    obligations.set(key, obligation);
  }
  return obligations;
}

export function validateVerificationRequest(request: VerificationRequest): VerificationRequest {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(request.repository) ||
    !/^[0-9a-f]{40}$/.test(request.revision) ||
    !/^[0-9a-f]{40}$/.test(request.base) ||
    !/^[0-9a-f]{40,64}$/.test(request.integrationTree) ||
    request.environment === '' ||
    request.operationId === ''
  )
    throw new EvidenceRequestError('verification request has invalid identity');
  const obligations = validateEvidenceObligations(request.plan);
  const providerKeys = new Set<string>();
  for (const run of request.providerRuns) {
    const obligation = obligations.get(run.obligation);
    if (
      !Number.isSafeInteger(run.id) ||
      run.id < 1 ||
      run.job === '' ||
      run.workflow === '' ||
      run.event === '' ||
      run.workflowPath === '' ||
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
  validateVerificationRequest(request);
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
      const content = transport.content?.(run.revision, request.base, obligation.relevantInputs);
      const metadata =
        entry.artifact === undefined ? undefined : transport.artifact(entry.id, entry.artifact);
      const artifact = metadata === undefined ? true : metadata.present && !metadata.expired;
      let inventory = job.inventory;
      let assertionPassed = job.assertionPassed;
      let artifactUsable = artifact;
      let archiveDigest: string | undefined;
      if (entry.artifact !== undefined) {
        try {
          if (
            metadata === undefined ||
            !metadata.present ||
            metadata.expired ||
            metadata.id === undefined ||
            metadata.digest === undefined ||
            transport.downloadArtifact === undefined
          )
            throw new EvidenceRequestError('required artifact unavailable');
          const parsed = inspectArtifact(transport.downloadArtifact(metadata.id), metadata.digest);
          inventory = parsed.inventory;
          assertionPassed = parsed.assertionPassed;
          archiveDigest = parsed.digest;
        } catch {
          assertionPassed = false;
          artifactUsable = false;
        }
      }
      const status: EvidenceStatus =
        run.status === 'cancelled' ||
        run.conclusion === 'cancelled' ||
        job.status === 'cancelled' ||
        job.conclusion === 'cancelled'
          ? 'canceled'
          : (run.status === 'completed' && run.conclusion === 'skipped') ||
              (job.status === 'completed' && job.conclusion === 'skipped')
            ? 'skipped'
            : run.repository !== request.repository ||
                run.revision !== request.revision ||
                content === undefined ||
                content.integrationTree !== request.integrationTree ||
                content.relevantInputs.some((input) => input.endsWith(':')) ||
                run.workflow !== entry.workflow ||
                run.workflowPath !== entry.workflowPath ||
                run.event !== entry.event ||
                !Number.isSafeInteger(run.attempt) ||
                run.attempt < 1 ||
                job.name !== entry.job ||
                job.runtime !== request.environment ||
                run.status !== 'completed' ||
                job.status !== 'completed' ||
                (obligation.evidenceKind === 'test-report' &&
                  (entry.artifact === undefined ||
                    assertionPassed !== true ||
                    inventory.length === 0)) ||
                !artifactUsable
              ? 'pending'
              : run.status === 'completed' &&
                  run.conclusion === 'success' &&
                  job.status === 'completed' &&
                  job.conclusion === 'success' &&
                  assertionPassed !== false &&
                  artifact
                ? 'pass'
                : 'fail';
      return {
        obligation: entry.obligation,
        status,
        revision: run.revision,
        integrationTree: content?.integrationTree ?? '',
        environment: job.runtime,
        command: obligation.commandOrProviderJob,
        evidenceKind: obligation.evidenceKind,
        relevantInputs: content?.relevantInputs ?? [],
        inventory,
        exitCode: job.conclusion === 'success' ? 0 : 1,
        assertionPassed,
        provider: {
          runId: entry.id,
          attempt: run.attempt,
          repository: run.repository,
          workflow: run.workflow,
          event: run.event,
          workflowPath: run.workflowPath,
          jobId: job.id,
          jobName: job.name,
          artifactRequired: entry.artifact !== undefined,
          ...(metadata?.id === undefined ||
          metadata.digest === undefined ||
          archiveDigest === undefined
            ? {}
            : {
                artifact: {
                  id: metadata.id,
                  digest: metadata.digest,
                  archiveDigest,
                  expired: metadata.expired,
                },
              }),
        },
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

/** Recollects authenticated provider state before reusing a provider receipt. */
export function reuseProviderEvidence(
  evidence: CollectedEvidence,
  request: VerificationRequest,
  transport: ProviderEvidenceTransport,
): CollectedEvidence {
  if (!issuedCollections.has(evidence) || evidence.source !== 'provider')
    throw new EvidenceRequestError('provider evidence was not returned by a collector');
  const current = collectProviderEvidence(request, transport);
  const records = current.records.map((record) => {
    const prior = evidence.records.find((candidate) => candidate.obligation === record.obligation);
    const sameArchive =
      prior?.provider?.artifact?.id === record.provider?.artifact?.id &&
      prior?.provider?.artifact?.digest === record.provider?.artifact?.digest &&
      prior?.provider?.artifact?.archiveDigest === record.provider?.artifact?.archiveDigest;
    const sameProvider =
      prior?.provider?.runId === record.provider?.runId &&
      prior?.provider?.attempt === record.provider?.attempt &&
      prior?.provider?.jobId === record.provider?.jobId &&
      sameArchive;
    return {
      ...record,
      status: record.status !== 'pass' ? record.status : sameProvider ? 'reused-pass' : 'pending',
    };
  });
  return collected('provider', records);
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
        assertionPassed = assertionPassed !== false && parsed.assertionPassed;
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
      const lacksRequiredTestProof =
        item.evidenceKind === 'test-report' && (assertionPassed === null || inventory.length === 0);
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
          lacksRequiredTestProof
            ? 'pending'
            : result.exitCode === 0 && assertionPassed !== false
              ? 'pass'
              : 'fail',
        revision: after.revision,
        checkedTree: after.checkedTree,
        integrationTree: after.integrationTree,
        environment: after.runtime,
        command: item.commandOrProviderJob,
        evidenceKind: item.evidenceKind,
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
  if (record.provider !== undefined) {
    if (!record.provider.artifactRequired) return true;
    const artifact = record.provider.artifact;
    return (
      artifact !== undefined &&
      !artifact.expired &&
      /^sha256:[0-9a-f]{64}$/.test(artifact.digest) &&
      artifact.digest === `sha256:${artifact.archiveDigest}`
    );
  }
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
  if (record.evidenceKind !== obligation.evidenceKind)
    problems.push(`${record.obligation} has a different evidence kind`);
  if (
    obligation.evidenceKind === 'test-report' &&
    (record.assertionPassed !== true || record.inventory.length === 0)
  )
    problems.push(`${record.obligation} lacks structured test proof`);
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
