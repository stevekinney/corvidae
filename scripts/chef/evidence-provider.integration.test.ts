import { expect, test } from 'bun:test';
import { zipSync } from 'fflate';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runWithHangGuard } from '../../testing/testing/src/hang-guard.ts';
import { createGitHubEvidenceTransport, type RawCommandResponse } from './evidence-provider.ts';
import {
  collectProviderEvidenceFromRequest,
  reuseProviderEvidence,
  validateEvidence,
  type VerificationRequest,
} from './evidence.ts';

const encode = (value: unknown): RawCommandResponse => ({
  exitCode: 0,
  stdout: new TextEncoder().encode(JSON.stringify(value)),
  stderr: new Uint8Array(),
});

const validFixture = (() => {
  const archive = zipSync({
    'reports/result.xml': new TextEncoder().encode(
      '<testsuite><testcase name="unit"/></testsuite>',
    ),
  });
  const digest = `sha256:${createHash('sha256').update(archive).digest('hex')}`;
  const calls: string[] = [];
  const transport = createGitHubEvidenceTransport('acme/widgets', {
    run(argv) {
      const path = argv.at(-1) as string;
      calls.push(path);
      if (path.endsWith('/runs/7'))
        return encode({
          repository: { full_name: 'acme/widgets' },
          head_sha: 'a'.repeat(40),
          status: 'completed',
          conclusion: 'success',
          name: 'Verify',
          event: 'push',
          run_attempt: 2,
        });
      if (path.endsWith('/jobs?per_page=100&page=1'))
        return encode({
          total_count: 101,
          jobs: [
            {
              id: 3,
              name: 'verify',
              status: 'completed',
              conclusion: 'success',
              runner_name: 'linux',
              steps: [{ name: 'unit' }],
            },
            ...Array.from({ length: 99 }, (_, index) => ({
              id: index + 10,
              name: `other-${index}`,
            })),
          ],
        });
      if (path.endsWith('/jobs?per_page=100&page=2'))
        return encode({ total_count: 101, jobs: [{ id: 200, name: 'other-final' }] });
      if (path.endsWith('/artifacts?per_page=100&page=1'))
        return encode({
          total_count: 1,
          artifacts: [{ id: 9, name: 'junit', digest, expired: false }],
        });
      if (path.endsWith('/artifacts/9/zip'))
        return { exitCode: 0, stdout: archive, stderr: new Uint8Array() };
      throw new Error(`unexpected ${path}`);
    },
  });
  const run = transport.run(7);
  const job = transport.job(7, 'verify');
  const artifact = transport.artifact(7, 'junit');
  const downloaded = transport.downloadArtifact?.(9);
  return {
    archive,
    artifact,
    calls,
    digest,
    job,
    run,
    downloaded,
  };
})();

test('the raw production transport follows every page and retains job and artifact identities', () => {
  expect(validFixture.run).toMatchObject({ repository: 'acme/widgets', attempt: 2 });
  expect(validFixture.job).toMatchObject({ id: 3, runtime: 'linux' });
  expect(validFixture.artifact).toMatchObject({ id: 9, digest: validFixture.digest, runId: 7 });
  expect(validFixture.downloaded).toEqual(validFixture.archive);
  expect(validFixture.calls).toEqual([
    'repos/acme/widgets/actions/runs/7',
    'repos/acme/widgets/actions/runs/7/jobs?per_page=100&page=1',
    'repos/acme/widgets/actions/runs/7/jobs?per_page=100&page=2',
    'repos/acme/widgets/actions/runs/7/artifacts?per_page=100&page=1',
    'repos/acme/widgets/actions/artifacts/9/zip',
  ]);
});

const incompleteError = (() => {
  const transport = createGitHubEvidenceTransport('acme/widgets', {
    run(argv) {
      const path = argv.at(-1) as string;
      if (path.endsWith('/jobs?per_page=100&page=1'))
        return encode({ total_count: 2, jobs: [{ id: 1, name: 'verify' }] });
      if (path.endsWith('/jobs?per_page=100&page=2')) return encode({ total_count: 2, jobs: [] });
      throw new Error(`unexpected ${path}`);
    },
  });
  try {
    transport.job(7, 'verify');
  } catch (error) {
    return error;
  }
  return undefined;
})();

test('the raw transport refuses ambiguous or incomplete provider pages', () => {
  expect(incompleteError).toBeInstanceOf(Error);
  expect((incompleteError as Error).message).toContain('pagination is incomplete');
});

const proofFixture = await (async () => {
  const scratch = join(process.cwd(), 'tmp/chef/p05-proof-finish');
  mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(join(scratch, 'evidence-provider-proof-'));
  const execute = async (argv: string[]) => {
    const result = await runWithHangGuard(argv, { cwd: directory });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    return new TextDecoder().decode(result.stdout).trim();
  };
  await execute(['git', 'init']);
  await execute(['git', 'config', 'user.email', 'collector@example.test']);
  await execute(['git', 'config', 'user.name', 'Collector']);
  writeFileSync(join(directory, 'input'), 'fixture\n');
  await execute(['git', 'add', 'input']);
  await execute(['git', 'commit', '-m', 'base']);
  const base = await execute(['git', 'rev-parse', 'HEAD']);
  writeFileSync(join(directory, 'source'), 'head\n');
  await execute(['git', 'add', 'source']);
  await execute(['git', 'commit', '-m', 'head']);
  const revision = await execute(['git', 'rev-parse', 'HEAD']);
  const integrationTree = await execute(['git', 'merge-tree', '--write-tree', base, revision]);
  const request: VerificationRequest = {
    repository: 'acme/widgets',
    revision,
    base,
    integrationTree,
    environment: 'linux',
    plan: {
      version: 1,
      obligations: [
        {
          criterionId: 'AC1',
          risk: 'root-scripts',
          commandOrProviderJob: 'verify',
          expectedInventory: ['proof.test.ts'],
          relevantInputs: ['input'],
          environmentToolchain: 'linux',
          executionBoundary: 'provider',
          producer: 'fixture',
          selectionReason: 'integration proof',
          evidenceKind: 'test-report',
        },
      ],
      risks: {
        'root-scripts': 'covered',
        'shared-configuration': 'not-applicable',
        'transitive-consumers': 'not-applicable',
        'dynamic-entrypoints': 'not-applicable',
        authorization: 'not-applicable',
        'persistence-protocols': 'not-applicable',
        'installed-artifacts': 'not-applicable',
        'shared-ui-design': 'not-applicable',
        'automatic-deployment': 'not-applicable',
      },
      invalidatedBy: { assignment: 'a', context: 'b', policy: 'c' },
    },
    authority: { runId: 'run', ownerId: 'owner', resource: 'COR-1', generation: 1 },
    operationId: 'operation',
    providerRuns: [
      {
        id: 7,
        obligation: 'AC1:verify',
        job: 'verify',
        workflow: 'Verify',
        workflowPath: '.github/workflows/main.yml',
        event: 'push',
        artifact: 'junit',
      },
    ],
  };
  const requestText = JSON.stringify(request);
  const requestPath = join(directory, 'request.json');
  writeFileSync(requestPath, requestText);
  const digest = createHash('sha256').update(requestText).digest('hex');
  const archive = zipSync({
    'reports/result.xml': new TextEncoder().encode(
      '<testsuite><testcase name="proof.test.ts"/></testsuite>',
    ),
  });
  const replacement = zipSync({
    'reports/result.xml': new TextEncoder().encode(
      '<testsuite><testcase name="proof.test.ts"/></testsuite>',
    ),
    'reports/other.xml': new TextEncoder().encode('<testsuite/>'),
  });
  return {
    archive,
    base,
    digest,
    directory,
    integrationTree,
    replacement,
    request,
    requestPath,
    revision,
  };
})();

function proofTransport(
  options: {
    archive?: Uint8Array;
    artifactId?: number;
    artifactDigest?: string;
    attempt?: unknown;
    expired?: boolean;
    missingAttempt?: boolean;
    workflowPath?: string;
    withoutArtifact?: boolean;
  } = {},
) {
  const archive = options.archive ?? proofFixture.archive;
  const digest =
    options.artifactDigest ?? `sha256:${createHash('sha256').update(archive).digest('hex')}`;
  return createGitHubEvidenceTransport(
    'acme/widgets',
    {
      run(argv) {
        const path = argv.at(-1) as string;
        if (path.endsWith('/runs/7'))
          return encode({
            repository: { full_name: 'acme/widgets' },
            head_sha: proofFixture.revision,
            status: 'completed',
            conclusion: 'success',
            name: 'Verify',
            path: options.workflowPath ?? '.github/workflows/main.yml',
            event: 'push',
            ...(options.missingAttempt ? {} : { run_attempt: options.attempt ?? 1 }),
          });
        if (path.endsWith('/jobs?per_page=100&page=1'))
          return encode({
            total_count: 1,
            jobs: [
              {
                id: 3,
                name: 'verify',
                status: 'completed',
                conclusion: 'success',
                runner_name: 'linux',
                steps: [{ name: 'unit' }],
              },
            ],
          });
        if (path.endsWith('/artifacts?per_page=100&page=1'))
          return encode({
            total_count: options.withoutArtifact ? 0 : 1,
            artifacts: options.withoutArtifact
              ? []
              : [
                  {
                    id: options.artifactId ?? 9,
                    name: 'junit',
                    digest,
                    expired: options.expired ?? false,
                  },
                ],
          });
        if (path.includes('/artifacts/') && path.endsWith('/zip'))
          return { exitCode: 0, stdout: archive, stderr: new Uint8Array() };
        throw new Error(`unexpected ${path}`);
      },
    },
    proofFixture.directory,
  );
}

const proofResults = (() => {
  const collected = collectProviderEvidenceFromRequest(
    proofFixture.requestPath,
    proofFixture.digest,
    proofTransport(),
  );
  const valid = validateEvidence(proofFixture.request.plan, collected, {
    revision: proofFixture.revision,
    integrationTree: proofFixture.integrationTree,
    environment: 'linux',
  }).ok;
  const pathMismatch = collectProviderEvidenceFromRequest(
    proofFixture.requestPath,
    proofFixture.digest,
    proofTransport({ workflowPath: '.github/workflows/other.yml' }),
  ).records[0]?.status;
  const noStructuredProof = {
    ...proofFixture.request,
    providerRuns: [{ ...proofFixture.request.providerRuns[0]!, artifact: undefined }],
  };
  const noProofText = JSON.stringify(noStructuredProof);
  const noProofPath = join(proofFixture.directory, 'no-structured-proof.json');
  writeFileSync(noProofPath, noProofText);
  const noProof = collectProviderEvidenceFromRequest(
    noProofPath,
    createHash('sha256').update(noProofText).digest('hex'),
    proofTransport(),
  ).records[0]?.status;

  const initial = collectProviderEvidenceFromRequest(
    proofFixture.requestPath,
    proofFixture.digest,
    proofTransport(),
  );
  const unchanged = reuseProviderEvidence(initial, proofFixture.request, proofTransport())
    .records[0]?.status;
  const replaced = reuseProviderEvidence(
    initial,
    proofFixture.request,
    proofTransport({ archive: proofFixture.replacement, artifactId: 10 }),
  ).records[0]?.status;
  const expired = reuseProviderEvidence(
    initial,
    proofFixture.request,
    proofTransport({ expired: true }),
  ).records[0]?.status;
  const corrupt = reuseProviderEvidence(
    initial,
    proofFixture.request,
    proofTransport({ artifactDigest: `sha256:${'0'.repeat(64)}` }),
  ).records[0]?.status;

  const invalidAttempts = [{ missingAttempt: true }, { attempt: 0 }, { attempt: 1.5 }].map(
    (options) =>
      collectProviderEvidenceFromRequest(
        proofFixture.requestPath,
        proofFixture.digest,
        proofTransport(options),
      ).records[0]?.status,
  );
  const validAttempt = collectProviderEvidenceFromRequest(
    proofFixture.requestPath,
    proofFixture.digest,
    proofTransport({ attempt: 1 }),
  ).records[0]?.status;
  const missingKind = JSON.stringify({
    ...proofFixture.request,
    plan: {
      ...proofFixture.request.plan,
      obligations: [{ ...proofFixture.request.plan.obligations[0]!, evidenceKind: undefined }],
    },
  });
  const unsafeInput = JSON.stringify({
    ...proofFixture.request,
    plan: {
      ...proofFixture.request.plan,
      obligations: [{ ...proofFixture.request.plan.obligations[0]!, relevantInputs: ['../input'] }],
    },
  });
  const rejectedCommands = [missingKind, unsafeInput].map((text) => {
    const path = join(
      proofFixture.directory,
      `${createHash('sha256').update(text).digest('hex')}.json`,
    );
    writeFileSync(path, text);
    let commands = 0;
    const transport = proofTransport();
    let rejected = false;
    try {
      collectProviderEvidenceFromRequest(path, createHash('sha256').update(text).digest('hex'), {
        ...transport,
        run(id) {
          commands += 1;
          return transport.run(id);
        },
      });
    } catch {
      rejected = true;
    }
    return { commands, rejected };
  });
  return {
    corrupt,
    expired,
    invalidAttempts,
    noProof,
    pathMismatch,
    rejectedCommands,
    replaced,
    unchanged,
    valid,
    validAttempt,
  };
})();

test('request-file collection composes authenticated raw GitHub responses with a real Git fixture', () => {
  expect(proofResults.valid).toBe(true);
  expect(proofResults.pathMismatch).toBe('pending');
  expect(proofResults.noProof).toBe('pending');
});

test('provider reuse recollects changing authenticated archive facts', () => {
  expect(proofResults.unchanged).toBe('reused-pass');
  expect(proofResults.replaced).toBe('pending');
  expect(proofResults.expired).toBe('pending');
  expect(proofResults.corrupt).toBe('pending');
});

test('raw provider attempt identity rejects manufactured proof', () => {
  expect(proofResults.invalidAttempts).toEqual(['pending', 'pending', 'pending']);
  expect(proofResults.validAttempt).toBe('pass');
  expect(proofResults.rejectedCommands).toEqual([
    { commands: 0, rejected: true },
    { commands: 0, rejected: true },
  ]);
});

const absentArtifact = (() => {
  try {
    return {
      collection: collectProviderEvidenceFromRequest(
        proofFixture.requestPath,
        proofFixture.digest,
        proofTransport({ withoutArtifact: true }),
      ),
      error: undefined,
    };
  } catch (error) {
    return { collection: undefined, error };
  }
})();

test('an authenticated empty artifact listing leaves the obligation pending', () => {
  expect(absentArtifact.error).toBeUndefined();
  expect(absentArtifact.collection?.records[0]?.status).toBe('pending');
});

const divergentProvider = await (async () => {
  const git = async (...argv: string[]) => {
    const result = await runWithHangGuard(['git', ...argv], { cwd: proofFixture.directory });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    return new TextDecoder().decode(result.stdout).trim();
  };
  await git('switch', '--detach', proofFixture.base);
  writeFileSync(join(proofFixture.directory, 'base-only'), 'unchecked base change\n');
  await git('add', 'base-only');
  await git('commit', '-m', 'divergent base');
  const base = await git('rev-parse', 'HEAD');
  const integrationTree = await git('merge-tree', '--write-tree', base, proofFixture.revision);
  const checkedTree = await git('rev-parse', `${proofFixture.revision}^{tree}`);
  const request = { ...proofFixture.request, base, integrationTree };
  const text = JSON.stringify(request);
  const path = join(proofFixture.directory, 'divergent-request.json');
  writeFileSync(path, text);
  return {
    integrationTree,
    checkedTree,
    collection: collectProviderEvidenceFromRequest(
      path,
      createHash('sha256').update(text).digest('hex'),
      proofTransport(),
    ),
  };
})();

test('a branch provider run cannot attest to an untested prospective merge tree', () => {
  expect(divergentProvider.checkedTree).not.toBe(divergentProvider.integrationTree);
  expect(divergentProvider.collection.records[0]?.status).toBe('pending');
  expect(divergentProvider.collection.records[0]?.integrationTree).toBe(
    divergentProvider.checkedTree,
  );
});
