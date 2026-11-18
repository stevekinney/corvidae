import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runWithHangGuard } from '../../testing/testing/src/hang-guard.ts';
import type {
  DeliveryVerification,
  DeliveryVerificationDependencies,
} from './delivery-verification.ts';
import { prepareDeliveryVerification } from './delivery-verification.ts';
import { createGitHubEvidenceTransport, type RawCommandResponse } from './evidence-provider.ts';
import type { VerificationRequest } from './evidence.ts';
import {
  acquireDispatch,
  createExecutionStateStore,
  recordMutationIntent,
} from './execution-state.ts';
import { assignmentVersion, digest, type Assignment } from './verification-plan.ts';

const response = (value: unknown): RawCommandResponse => ({
  exitCode: 0,
  stdout: new TextEncoder().encode(JSON.stringify(value)),
  stderr: new Uint8Array(),
});

export async function createDeliveryVerificationFixture(
  identity?: {
    directory: string;
    base: string;
    revision: string;
    integrationTree: string;
    relevantInputs?: string[];
    outputDirectory?: string;
  },
  options: { route?: string; approved?: boolean; noBehavior?: boolean; hostId?: string } = {},
): Promise<{
  verification: DeliveryVerification;
  dependencies: DeliveryVerificationDependencies;
  request: VerificationRequest;
  assignment: Assignment;
  state: ReturnType<typeof createExecutionStateStore>;
  directory: string;
}> {
  const scratch = join(process.cwd(), 'tmp/chef/p05-delivery-14ef');
  mkdirSync(scratch, { recursive: true });
  const directory = identity?.directory ?? mkdtempSync(join(scratch, 'verification-'));
  const git = async (...argv: string[]) => {
    const result = await runWithHangGuard(['git', ...argv], { cwd: directory });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    return new TextDecoder().decode(result.stdout).trim();
  };
  if (identity === undefined) {
    await git('init');
    await git('config', 'user.email', 'fixture@example.test');
    await git('config', 'user.name', 'Fixture');
    writeFileSync(join(directory, 'input'), 'base\n');
    await git('add', 'input');
    await git('commit', '-m', 'base');
    const base = await git('rev-parse', 'HEAD');
    writeFileSync(join(directory, 'input'), 'head\n');
    await git('add', 'input');
    await git('commit', '-m', 'head');
    const revision = await git('rev-parse', 'HEAD');
    identity = {
      directory,
      base,
      revision,
      integrationTree: await git('merge-tree', '--write-tree', base, revision),
      relevantInputs: ['input'],
    };
  }
  const { base, revision, integrationTree } = identity;
  const outputDirectory = identity.outputDirectory ?? directory;
  const state = createExecutionStateStore({
    stateDirectory: join(outputDirectory, 'state'),
    hostId: options.hostId ?? 'fixture',
  });
  const acquired = await acquireDispatch(state, {
    resource: 'COR-1',
    runId: 'run',
    ownerId: 'owner',
  });
  if (!acquired.granted) throw new Error(acquired.reason);
  const request: VerificationRequest = {
    repository: 'acme/widgets',
    revision,
    base,
    integrationTree,
    environment: 'linux',
    authority: acquired.authority,
    operationId: 'operation',
    plan: {
      version: 1,
      obligations: options.noBehavior
        ? []
        : [
            {
              criterionId: 'AC1',
              risk: 'root-scripts',
              commandOrProviderJob: 'verify',
              expectedInventory: [],
              relevantInputs: identity.relevantInputs ?? [],
              environmentToolchain: 'linux',
              executionBoundary: 'provider',
              producer: 'fixture',
              selectionReason: 'fixture',
              evidenceKind: 'process-exit',
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
      invalidatedBy: { assignment: '', context: 'b', policy: 'c' },
    },
    providerRuns: options.noBehavior
      ? []
      : [
          {
            id: 7,
            obligation: 'AC1:verify',
            job: 'verify',
            workflow: 'Verify',
            workflowPath: '.github/workflows/main.yml',
            event: 'push',
          },
        ],
  };
  const assignment: Assignment = {
    version: assignmentVersion,
    identity: {
      identifier: 'COR-1',
      revision: 'fixture',
      repository: request.repository,
      base,
      digest: '',
    },
    criteria: options.noBehavior ? [] : [{ id: 'AC1', text: 'fixture' }],
    ownedPaths: [],
    exclusions: [],
    dependencies: [],
    sourceReferences: [],
    designRows: [],
    deliveryBoundary: 'fixture',
    allowedConsequentialActions: ['merge'],
    classification: options.noBehavior ? 'no-behavior' : 'behavior',
  };
  assignment.identity.digest = digest(
    JSON.stringify({ ...assignment, identity: { ...assignment.identity, digest: undefined } }),
  );
  request.plan.invalidatedBy.assignment = assignment.identity.digest;
  const text = JSON.stringify(request);
  const file = join(outputDirectory, 'verification.json');
  writeFileSync(file, text);
  const transport = createGitHubEvidenceTransport(
    'acme/widgets',
    {
      run(argv) {
        const path = argv.at(-1) ?? '';
        if (path.endsWith('/runs/7'))
          return response({
            repository: { full_name: 'acme/widgets' },
            head_sha: revision,
            status: 'completed',
            conclusion: 'success',
            name: 'Verify',
            path: '.github/workflows/main.yml',
            event: 'push',
            run_attempt: 1,
          });
        if (path.endsWith('/jobs?per_page=100&page=1'))
          return response({
            total_count: 1,
            jobs: [
              {
                id: 3,
                name: 'verify',
                status: 'completed',
                conclusion: 'success',
                runner_name: 'linux',
                steps: [],
              },
            ],
          });
        throw new Error(`unexpected ${path}`);
      },
    },
    directory,
  );
  const verification = {
    file,
    digest: createHash('sha256').update(text).digest('hex'),
    stateDirectory: state.stateDirectory,
  };
  await recordMutationIntent(state, acquired.authority, {
    operationId: request.operationId,
    action: 'merge',
    intentFingerprint: 'fixture',
  });
  if (options.approved !== false)
    await prepareDeliveryVerification(
      verification,
      assignment,
      { route: options.route ?? 'fixture', action: 'merge' },
      { state },
    );
  return {
    verification,
    dependencies: { state, transport },
    request,
    assignment,
    state,
    directory,
  };
}
