import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { runWithHangGuard } from '../../testing/testing/src/hang-guard.ts';
import {
  collectLocalEvidence,
  collectLocalEvidenceFromRequest,
  collectProviderEvidenceFromRequest,
  reuseLocalEvidence,
  validateEvidence,
  type LocalEvidenceProcess,
  type VerificationRequest,
} from './evidence.ts';

const scratch = join(process.cwd(), 'tmp/chef/p05-14ef');
mkdirSync(scratch, { recursive: true });
const fixture = mkdtempSync(join(scratch, 'evidence-'));
const git = async (...arguments_: string[]) => {
  const result = await runWithHangGuard(['git', ...arguments_], { cwd: fixture });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
};
const values = await (async () => {
  await git('init');
  await git('config', 'user.email', 'collector@example.test');
  await git('config', 'user.name', 'Collector');
  writeFileSync(join(fixture, 'input'), 'first\n');
  writeFileSync(join(fixture, 'unrelated'), 'first\n');
  await git('add', '.');
  await git('commit', '-m', 'fixture');
  const base = await git('rev-parse', 'HEAD');
  writeFileSync(join(fixture, 'source'), 'head\n');
  await git('add', 'source');
  await git('commit', '-m', 'head');
  const request = async (): Promise<VerificationRequest> => {
    const revision = await git('rev-parse', 'HEAD');
    return {
      repository: 'acme/widgets',
      revision,
      base,
      integrationTree: await git('merge-tree', '--write-tree', base, revision),
      environment: 'requested-only',
      plan: {
        version: 1,
        obligations: [
          {
            criterionId: 'AC1',
            risk: 'root-scripts',
            commandOrProviderJob: 'collector-test',
            expectedInventory: ['input.test.ts'],
            relevantInputs: ['input'],
            environmentToolchain: 'Bun',
            executionBoundary: 'coordinator',
            producer: 'fixture',
            selectionReason: 'test',
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
      providerRuns: [],
      localRuns: [
        {
          obligation: 'AC1:collector-test',
          argv: ['true'],
          reportPaths: ['report.xml'],
          artifactPaths: ['artifact.bin'],
        },
      ],
    };
  };
  const report = join(fixture, 'report.xml');
  const artifact = join(fixture, 'artifact.bin');
  writeFileSync(report, '<testsuite><testcase name="input.test.ts" /></testsuite>');
  writeFileSync(artifact, 'artifact');
  const passing: LocalEvidenceProcess = { run: () => ({ exitCode: 0 }) };
  const cleanRequest = await request();
  const clean = collectLocalEvidence(cleanRequest, passing, fixture);
  const cleanExpected = {
    revision: cleanRequest.revision,
    integrationTree: cleanRequest.integrationTree,
    environment: Bun.version,
  };
  const intactArtifactValidation = validateEvidence(cleanRequest.plan, clean, cleanExpected).ok;
  writeFileSync(artifact, 'tampered artifact');
  const tamperedArtifactValidation = validateEvidence(cleanRequest.plan, clean, cleanExpected).ok;
  writeFileSync(artifact, 'artifact');
  unlinkSync(artifact);
  const deletedArtifactValidation = validateEvidence(cleanRequest.plan, clean, cleanExpected).ok;
  writeFileSync(artifact, 'artifact');
  writeFileSync(join(fixture, 'input'), 'dirty\n');
  const dirty = collectLocalEvidence(await request(), passing, fixture);
  await git('checkout', '--', 'input');
  const mutating = collectLocalEvidence(
    await request(),
    {
      run: () => {
        writeFileSync(join(fixture, 'input'), 'mutated\n');
        return { exitCode: 0, inventory: ['input.test.ts'], assertionPassed: true };
      },
    },
    fixture,
  );
  await git('checkout', '--', 'input');
  const missingRequest = await request();
  missingRequest.localRuns![0] = { ...missingRequest.localRuns![0]!, reportPaths: [] };
  const missing = collectLocalEvidence(missingRequest, { run: () => ({ exitCode: 0 }) }, fixture);
  const processExitBaseRequest = await request();
  const processExitRequest = {
    ...processExitBaseRequest,
    plan: {
      ...processExitBaseRequest.plan,
      obligations: [
        {
          ...processExitBaseRequest.plan.obligations[0]!,
          evidenceKind: 'process-exit' as const,
          expectedInventory: [],
        },
      ],
    },
    localRuns: [
      {
        obligation: 'AC1:collector-test',
        argv: ['true'],
        reportPaths: [],
      },
    ],
  };
  const processExitPass = collectLocalEvidence(
    processExitRequest,
    { run: () => ({ exitCode: 0 }) },
    fixture,
  );
  const processExitFail = collectLocalEvidence(
    processExitRequest,
    { run: () => ({ exitCode: 1 }) },
    fixture,
  );
  const processExitPath = join(fixture, 'process-exit-request.json');
  const processExitText = JSON.stringify(processExitRequest);
  writeFileSync(processExitPath, processExitText);
  const processExitFromRequest = collectLocalEvidenceFromRequest(
    processExitPath,
    createHash('sha256').update(processExitText).digest('hex'),
    { run: () => ({ exitCode: 0 }) },
    fixture,
  );
  const reportedRequest = await request();
  const reported = collectLocalEvidence(
    reportedRequest,
    {
      run: () => ({
        exitCode: 0,
      }),
    },
    fixture,
  );
  writeFileSync(
    report,
    '<testsuite><testcase name="input.test.ts"><failure /></testcase></testsuite>',
  );
  const failedReport = collectLocalEvidence(
    await request(),
    {
      run: () => ({
        exitCode: 0,
      }),
    },
    fixture,
  );
  const defaultRequest = {
    ...reportedRequest,
    plan: {
      ...reportedRequest.plan,
      obligations: [
        {
          ...reportedRequest.plan.obligations[0]!,
          commandOrProviderJob: 'bun writes declared JUnit',
        },
      ],
    },
    localRuns: [
      {
        obligation: 'AC1:bun writes declared JUnit',
        argv: [
          'bun',
          '-e',
          'await Bun.write("report.xml", "<testsuite><testcase name=\\"input.test.ts\\" /></testsuite>")',
        ],
        reportPaths: ['report.xml'],
      },
    ],
  };
  const requestPath = join(fixture, 'default-request.json');
  const requestText = JSON.stringify(defaultRequest);
  writeFileSync(requestPath, requestText);
  const defaultReceipt = collectLocalEvidenceFromRequest(
    requestPath,
    createHash('sha256').update(requestText).digest('hex'),
    undefined,
    fixture,
  );
  const defaultExpected = {
    revision: defaultRequest.revision,
    integrationTree: defaultRequest.integrationTree,
    environment: Bun.version,
  };
  const intactReportValidation = validateEvidence(
    defaultRequest.plan,
    defaultReceipt,
    defaultExpected,
  ).ok;
  writeFileSync(report, 'tampered report');
  const tamperedReportValidation = validateEvidence(
    defaultRequest.plan,
    defaultReceipt,
    defaultExpected,
  ).ok;
  writeFileSync(report, '<testsuite><testcase name="input.test.ts" /></testsuite>');
  unlinkSync(report);
  const deletedReportValidation = validateEvidence(
    defaultRequest.plan,
    defaultReceipt,
    defaultExpected,
  ).ok;
  writeFileSync(report, '<testsuite><testcase name="input.test.ts" /></testsuite>');
  let runtimeCommandCalled = false;
  const runtimeReuse = reuseLocalEvidence(defaultReceipt, defaultRequest, fixture, (argv) => {
    if (argv[0] === 'bun') {
      runtimeCommandCalled = true;
      return 'other-bun';
    }
    if (argv[1] === 'rev-parse' && argv[2] === 'HEAD') return defaultRequest.revision;
    if (argv[1] === 'rev-parse') return defaultReceipt.records[0]!.checkedTree!;
    if (argv[1] === 'merge-tree') return defaultRequest.integrationTree;
    return '';
  });
  writeFileSync(report, '<testsuite><testcase name="input.test.ts" /></testsuite>');
  const initial = collectLocalEvidence(await request(), passing, fixture);
  const traversalRequest = await request();
  const outside = mkdtempSync(join(scratch, 'outside-'));
  const outsideFile = join(outside, 'evidence.xml');
  writeFileSync(outsideFile, '<testsuite><testcase name="input.test.ts" /></testsuite>');
  const outsideInput = join(outside, 'input');
  writeFileSync(outsideInput, 'outside input\n');
  symlinkSync(outsideFile, join(fixture, 'escape-report'));
  symlinkSync(outsideFile, join(fixture, 'escape-artifact'));
  const escapeRequest = await request();
  escapeRequest.localRuns![0] = {
    ...escapeRequest.localRuns![0]!,
    reportPaths: ['escape-report'],
    artifactPaths: ['escape-artifact'],
  };
  let escapeCalls = 0;
  expect(() =>
    collectLocalEvidence(
      escapeRequest,
      {
        run: () => {
          escapeCalls += 1;
          return { exitCode: 0 };
        },
      },
      fixture,
    ),
  ).toThrow();
  unlinkSync(join(fixture, 'input'));
  symlinkSync(outsideInput, join(fixture, 'input'));
  const inputEscapeRequest = await request();
  let inputEscapeCalls = 0;
  expect(() =>
    collectLocalEvidence(
      inputEscapeRequest,
      {
        run: () => {
          inputEscapeCalls += 1;
          return { exitCode: 0 };
        },
      },
      fixture,
    ),
  ).toThrow();
  unlinkSync(join(fixture, 'input'));
  await git('checkout', '--', 'input');
  traversalRequest.localRuns![0] = {
    ...traversalRequest.localRuns![0]!,
    argv: ['true'],
    reportPaths: ['../report.xml'],
    artifactPaths: ['../artifact.bin'],
  };
  let directTraversalCalls = 0;
  expect(() =>
    collectLocalEvidence(
      traversalRequest,
      {
        run: () => {
          directTraversalCalls += 1;
          return { exitCode: 0 };
        },
      },
      fixture,
    ),
  ).toThrow();
  const traversalPath = join(fixture, 'traversal-request.json');
  const traversalText = JSON.stringify(traversalRequest);
  writeFileSync(traversalPath, traversalText);
  let requestTraversalCalls = 0;
  expect(() =>
    collectLocalEvidenceFromRequest(
      traversalPath,
      createHash('sha256').update(traversalText).digest('hex'),
      {
        run: () => {
          requestTraversalCalls += 1;
          return { exitCode: 0 };
        },
      },
      fixture,
    ),
  ).toThrow();
  writeFileSync(join(fixture, 'unrelated'), 'changed\n');
  await git('add', 'unrelated');
  await git('commit', '-m', 'unrelated');
  const unrelatedRequest = await request();
  const reused = reuseLocalEvidence(initial, unrelatedRequest, fixture);
  writeFileSync(report, 'tampered');
  const reportTamper = reuseLocalEvidence(initial, unrelatedRequest, fixture);
  writeFileSync(report, '<testsuite><testcase name="input.test.ts" /></testsuite>');
  writeFileSync(artifact, 'tampered');
  const artifactTamper = reuseLocalEvidence(initial, unrelatedRequest, fixture);
  writeFileSync(artifact, 'artifact');
  writeFileSync(join(fixture, 'input'), 'changed\n');
  const invalidReuse = reuseLocalEvidence(initial, await request(), fixture);
  await git('checkout', '--', 'input');
  const releaseArchive = join(fixture, 'release.tar.gz');
  const releaseReceipt = join(fixture, 'installed-release.json');
  writeFileSync(releaseArchive, 'archive');
  const releaseBaseRequest = await request();
  const releaseRequest = {
    ...releaseBaseRequest,
    plan: {
      ...releaseBaseRequest.plan,
      obligations: [
        {
          ...releaseBaseRequest.plan.obligations[0]!,
          risk: 'installed-artifacts' as const,
          commandOrProviderJob: 'verify-installed-release',
          evidenceKind: 'process-exit' as const,
          expectedInventory: [],
        },
      ],
    },
    localRuns: [
      {
        obligation: 'AC1:verify-installed-release',
        argv: ['verify-installed-release'],
        reportPaths: [],
        installedRelease: {
          receiptPath: 'installed-release.json',
          archivePath: 'release.tar.gz',
          archiveDigest: createHash('sha256').update(readFileSync(releaseArchive)).digest('hex'),
          sourceRevision: releaseBaseRequest.revision,
          target: 'darwin-arm64' as const,
          configuration: [
            {
              path: 'input',
              sha256: createHash('sha256')
                .update(readFileSync(join(fixture, 'input')))
                .digest('hex'),
            },
          ],
        },
      },
    ],
  };
  const [releaseRun] = releaseRequest.localRuns;
  let mismatchedReleaseInvocations = 0;
  let mismatchedReleaseError = '';
  try {
    collectLocalEvidence(
      {
        ...releaseRequest,
        localRuns: [
          {
            ...releaseRun!,
            installedRelease: { ...releaseRun!.installedRelease, sourceRevision: 'f'.repeat(40) },
          },
        ],
      },
      {
        run: () => {
          mismatchedReleaseInvocations += 1;
          return { exitCode: 0 };
        },
      },
      fixture,
    );
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    mismatchedReleaseError = error.message;
  }
  const releaseEvidence = collectLocalEvidence(
    releaseRequest,
    {
      run: () => {
        writeFileSync(
          releaseReceipt,
          JSON.stringify({
            version: 1,
            outcome: 'pass',
            archive: {
              sha256: releaseRequest.localRuns[0]!.installedRelease.archiveDigest,
              target: 'darwin-arm64',
              manifest: { sourceSha: releaseBaseRequest.revision },
            },
            installedExecutable: 'interborough/bin/interborough',
            assertions: [{ exit: 0 }],
            configuration: releaseRequest.localRuns[0]!.installedRelease.configuration,
            producer: { script: 'applications/interborough/scripts/test-installed-release.ts' },
          }),
        );
        return { exitCode: 0 };
      },
    },
    fixture,
  );
  const releaseValidation = validateEvidence(releaseRequest.plan, releaseEvidence, {
    revision: releaseRequest.revision,
    integrationTree: releaseRequest.integrationTree,
    environment: Bun.version,
  }).ok;
  unlinkSync(releaseReceipt);
  const wrongReleaseEvidence = collectLocalEvidence(
    releaseRequest,
    {
      run: () => {
        writeFileSync(
          releaseReceipt,
          JSON.stringify({
            version: 1,
            outcome: 'pass',
            archive: {
              sha256: releaseRequest.localRuns[0]!.installedRelease.archiveDigest,
              target: 'darwin-arm64',
              manifest: { sourceSha: 'f'.repeat(40) },
            },
            installedExecutable: 'interborough/bin/interborough',
            assertions: [{ exit: 0 }],
            configuration: releaseRequest.localRuns[0]!.installedRelease.configuration,
            producer: { script: 'applications/interborough/scripts/test-installed-release.ts' },
          }),
        );
        return { exitCode: 0 };
      },
    },
    fixture,
  );
  return {
    cleanRequest,
    clean,
    intactArtifactValidation,
    tamperedArtifactValidation,
    deletedArtifactValidation,
    dirty,
    mutating,
    missing,
    processExitPass,
    processExitFail,
    processExitFromRequest,
    report,
    reportedRequest,
    reported,
    failedReport,
    defaultReceipt,
    intactReportValidation,
    tamperedReportValidation,
    deletedReportValidation,
    runtimeReuse,
    runtimeCommandCalled,
    reused,
    reportTamper,
    artifactTamper,
    directTraversalCalls,
    requestTraversalCalls,
    escapeCalls,
    inputEscapeCalls,
    invalidReuse,
    releaseRequest,
    releaseEvidence,
    releaseValidation,
    wrongReleaseEvidence,
    mismatchedReleaseInvocations,
    mismatchedReleaseError,
    reportDigest: createHash('sha256').update(readFileSync(report)).digest('hex'),
  };
})();

const unsafeProviderRequest = (() => {
  const directory = mkdtempSync(join(scratch, 'unsafe-provider-'));
  const path = join(directory, 'request.json');
  const text = JSON.stringify({
    repository: 'acme/widgets',
    revision: 'a'.repeat(40),
    base: 'b'.repeat(40),
    integrationTree: 'c'.repeat(40),
    environment: 'runner',
    authority: { runId: 'run', ownerId: 'owner', resource: 'COR-1', generation: 1 },
    operationId: 'operation',
    plan: {
      version: 1,
      obligations: [
        {
          criterionId: 'AC1',
          risk: 'root-scripts',
          commandOrProviderJob: 'test',
          expectedInventory: [],
          relevantInputs: ['../outside'],
          environmentToolchain: 'runner',
          executionBoundary: 'provider',
          producer: 'fixture',
          selectionReason: 'test',
          evidenceKind: 'test-report',
        },
      ],
      risks: {},
      invalidatedBy: {},
    },
    providerRuns: [
      {
        id: 1,
        obligation: 'AC1:test',
        job: 'test',
        workflow: 'workflow',
        workflowPath: '.github/workflows/main.yml',
        event: 'push',
      },
    ],
  });
  writeFileSync(path, text);
  let reads = 0;
  let rejected = false;
  try {
    collectProviderEvidenceFromRequest(path, createHash('sha256').update(text).digest('hex'), {
      run: () => {
        reads += 1;
        throw new Error('must not read');
      },
      job: () => {
        throw new Error('must not read');
      },
      artifact: () => ({ present: false, expired: false }),
    });
  } catch {
    rejected = true;
  }
  return { reads, rejected };
})();

test('request-file provider collection rejects unsafe paths before transport reads', () => {
  expect(unsafeProviderRequest.rejected).toBe(true);
  expect(unsafeProviderRequest.reads).toBe(0);
});

test('collects an actual clean checkout receipt', () =>
  expect(values.clean.records[0]?.status).toBe('pass'));
test('collects a fresh installed-release receipt only when its declared archive identity matches', () =>
  expect(values.releaseValidation).toBe(true));
test('rejects an altered installed-release receipt through local collection', () =>
  expect(values.wrongReleaseEvidence.records[0]?.status).toBe('fail'));
test('rejects release source not equal to the candidate before launch', () => {
  expect(values.mismatchedReleaseError).toContain('invalid or stale receipt');
  expect(values.mismatchedReleaseInvocations).toBe(0);
});
test('validates an actual clean checkout receipt', () =>
  expect(
    validateEvidence(values.cleanRequest.plan, values.clean, {
      revision: values.cleanRequest.revision,
      integrationTree: values.cleanRequest.integrationTree,
      environment: Bun.version,
    }).ok,
  ).toBe(true));
test('ordinary validation rejects modified retained artifacts', () => {
  expect(values.intactArtifactValidation).toBe(true);
  expect(values.tamperedArtifactValidation).toBe(false);
  expect(values.deletedArtifactValidation).toBe(false);
});
test('binds dirty and mutated content instead of clean head', () => {
  expect(values.dirty.records[0]?.dirtyContentIdentity).toBeDefined();
  expect(values.dirty.records[0]?.status).toBe('pending');
  expect(values.mutating.records[0]?.status).toBe('pending');
});
test('requires structured results and retains report identity', () => {
  expect(values.missing.records[0]?.status).toBe('pending');
  expect(values.reported.records[0]?.reports?.[0]?.path).toBe('report.xml');
  expect(values.failedReport.records[0]?.status).toBe('fail');
});
test('process-exit local evidence needs only an actual successful exit', () => {
  expect(values.processExitPass.records[0]?.status).toBe('pass');
  expect(values.processExitFail.records[0]?.status).toBe('fail');
  expect(values.processExitFromRequest.records[0]?.status).toBe('pass');
});
test('default local composition executes explicit argv without a shell', () => {
  expect(values.defaultReceipt.records[0]?.status).toBe('pass');
  expect(values.intactReportValidation).toBe(true);
  expect(values.tamperedReportValidation).toBe(false);
  expect(values.deletedReportValidation).toBe(false);
  expect(values.runtimeReuse.records[0]?.status).toBe('pending');
  expect(values.runtimeCommandCalled).toBe(true);
});
test('reuses only unchanged relevant content', () => {
  expect(values.reused.records[0]?.status).toBe('reused-pass');
  expect(values.reportTamper.records[0]?.status).toBe('pending');
  expect(values.artifactTamper.records[0]?.status).toBe('pending');
  expect(values.invalidReuse.records[0]?.status).toBe('pending');
});
test('rejects traversal report and artifact mappings before either local runner starts', () => {
  expect(values.directTraversalCalls).toBe(0);
  expect(values.requestTraversalCalls).toBe(0);
});
test('rejects symlinked report and artifact escapes before the runner starts', () => {
  expect(values.escapeCalls).toBe(0);
});
test('rejects a symlinked relevant input before the runner starts', () => {
  expect(values.inputEscapeCalls).toBe(0);
});
