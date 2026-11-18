import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runWithHangGuard } from '../../testing/testing/src/hang-guard.ts';
import {
  collectLocalEvidence,
  collectLocalEvidenceFromRequest,
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
        },
      ],
    };
  };
  const report = join(fixture, 'report.xml');
  writeFileSync(report, '<testsuite><testcase name="input.test.ts" /></testsuite>');
  const passing: LocalEvidenceProcess = { run: () => ({ exitCode: 0 }) };
  const cleanRequest = await request();
  const clean = collectLocalEvidence(cleanRequest, passing, fixture);
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
          commandOrProviderJob: 'touch actual-command-ran',
        },
      ],
    },
    localRuns: [
      {
        obligation: 'AC1:touch actual-command-ran',
        argv: ['touch', 'actual-command-ran'],
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
  writeFileSync(report, '<testsuite><testcase name="input.test.ts" /></testsuite>');
  const initial = collectLocalEvidence(await request(), passing, fixture);
  writeFileSync(join(fixture, 'unrelated'), 'changed\n');
  await git('add', 'unrelated');
  await git('commit', '-m', 'unrelated');
  const unrelatedRequest = await request();
  const reused = reuseLocalEvidence(initial, unrelatedRequest, fixture);
  writeFileSync(join(fixture, 'input'), 'changed\n');
  const invalidReuse = reuseLocalEvidence(initial, await request(), fixture);
  await git('checkout', '--', 'input');
  return {
    cleanRequest,
    clean,
    dirty,
    mutating,
    missing,
    report,
    reportedRequest,
    reported,
    failedReport,
    defaultReceipt,
    defaultCommandRan: readFileSync(join(fixture, 'actual-command-ran')).byteLength === 0,
    reused,
    invalidReuse,
    reportDigest: createHash('sha256').update(readFileSync(report)).digest('hex'),
  };
})();

test('collects an actual clean checkout receipt', () =>
  expect(values.clean.records[0]?.status).toBe('pass'));
test('validates an actual clean checkout receipt', () =>
  expect(
    validateEvidence(values.cleanRequest.plan, values.clean, {
      revision: values.cleanRequest.revision,
      integrationTree: values.cleanRequest.integrationTree,
      environment: Bun.version,
    }).ok,
  ).toBe(true));
test('binds dirty and mutated content instead of clean head', () => {
  expect(values.dirty.records[0]?.dirtyContentIdentity).toBeDefined();
  expect(values.mutating.records[0]?.status).toBe('pending');
});
test('requires structured results and retains report identity', () => {
  expect(values.missing.records[0]?.status).toBe('pending');
  expect(values.reported.records[0]?.reports?.[0]?.path).toBe(values.report);
  expect(values.failedReport.records[0]?.status).toBe('fail');
});
test('default local composition executes explicit argv without a shell', () => {
  expect(values.defaultCommandRan).toBe(true);
  expect(values.defaultReceipt.records[0]?.status).toBe('fail');
});
test('reuses only unchanged relevant content', () => {
  expect(values.reused.records[0]?.status).toBe('reused-pass');
  expect(values.invalidReuse.records[0]?.status).toBe('pending');
});
