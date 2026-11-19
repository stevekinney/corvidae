// The approved delivery a `deliver` test starts from: a verification request for `acme/widgets`, its
// execution state, and the green landing facts (`landing-evidence.test-support.ts`). No process starts.

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { batchVerificationPlanDigest, type DeliveryRequest } from './delivery-completion.ts';
import {
  prepareDeliveryVerification,
  type DeliveryVerification,
  type DeliveryVerificationDependencies,
} from './delivery-verification.ts';
import {
  acquireDispatch,
  createExecutionStateStore,
  recordMutationIntent,
} from './execution-state.ts';
import {
  greenLandingAnswers,
  landingIdentity,
  landingProvider,
} from './landing-evidence.test-support.ts';
import type { Runner, RunnerResult } from './process-runner.ts';
import { assignmentVersion, digest, type Assignment } from './verification-plan.ts';

export const HEAD = 'a'.repeat(40);
export const BASE = 'c'.repeat(40);
export const TREE = '1'.repeat(40);
export const BRANCH = 'cor-9-widgets';
const BASE_TREE = '2'.repeat(40);
const SQUASH = 'e'.repeat(40);
const NEW_BLOB = '5'.repeat(40);
const OLD_BLOB = '6'.repeat(40);
const OLDER_BLOB = '7'.repeat(40);
const EARLIER = '8'.repeat(40);

const reply = (stdout = '', code = 0, stderr = ''): RunnerResult => ({ code, stdout, stderr });

/**
 * A fake `git` and `gh` that answer a clean branch merge of `BRANCH` into `main`, with every read of
 * a green landing. `answers` override single commands by their arguments (`git`'s or `gh`'s, with
 * the program dropped); `handler` sees every command first and may answer it.
 */
export function branchRunner(
  sandbox: string,
  answers: Record<string, RunnerResult> = {},
  handler: (command: string[]) => RunnerResult | undefined = () => undefined,
) {
  const calls: string[] = [];
  const messageFile = join(sandbox, 'message.md');
  const defaults: Record<string, RunnerResult> = {
    'rev-parse --path-format=absolute --git-common-dir': reply(join(sandbox, '.git')),
    [`fetch origin main ${BRANCH}`]: reply(),
    [`rev-parse --verify refs/remotes/origin/${BRANCH}^{commit}`]: reply(`${HEAD}\n`),
    'rev-parse --verify refs/remotes/origin/main^{commit}': reply(`${BASE}\n`),
    [`merge-base ${HEAD} ${BASE}`]: reply(`${BASE}\n`),
    [`diff --name-only ${BASE} ${HEAD}`]: reply('a.ts\n'),
    [`rev-parse -q --verify ${HEAD}:a.ts`]: reply(`${NEW_BLOB}\n`),
    [`rev-parse -q --verify ${BASE}:a.ts`]: reply(`${OLD_BLOB}\n`),
    [`log -n 60 --since=2 days ago --format=%H ${BASE} -- a.ts`]: reply(`${EARLIER}\n`),
    [`rev-parse -q --verify ${EARLIER}^:a.ts`]: reply(`${OLDER_BLOB}\n`),
    [`merge-tree --write-tree ${BASE} ${HEAD}`]: reply(`${TREE}\n`),
    [`rev-parse ${BASE}^{tree}`]: reply(`${BASE_TREE}\n`),
    [`commit-tree ${TREE} -p ${BASE} -F ${messageFile}`]: reply(`${SQUASH}\n`),
    [`push origin ${SQUASH}:refs/heads/main`]: reply(),
    [`push origin --delete ${BRANCH} --force-with-lease=refs/heads/${BRANCH}:${HEAD}`]: reply(),
    'fetch origin main': reply(),
    'rev-parse origin/main': reply(`${SQUASH}\n`),
    [`rev-parse ${SQUASH}^`]: reply(`${BASE}\n`),
    [`rev-parse ${SQUASH}^{tree}`]: reply(`${TREE}\n`),
    ...greenLandingAnswers('acme/widgets', HEAD, BASE),
  };
  const runner: Runner = (command) => {
    const key = command.slice(1).join(' ');
    calls.push(key);
    return (
      handler(command) ??
      answers[key] ??
      defaults[key] ??
      reply('', 1, `unexpected command: ${key}`)
    );
  };
  return { runner, calls, messageFile };
}

/** The approved request bound to `directory`, for `route`, and the dependencies that read it. */
export async function createDeliveryFixture(
  directory: string,
  worktree: string,
  route = 'pull-request',
  /** `dispatch`: a manual dispatch, whose pinned digest is the batch digest unless `stale`. */
  identity: { dispatch?: boolean; stale?: boolean; none?: boolean } = {},
): Promise<{ binding: DeliveryVerification; dependencies: DeliveryVerificationDependencies }> {
  const state = createExecutionStateStore({
    stateDirectory: join(directory, 'state'),
    hostId: 'fixture',
  });
  const acquired = await acquireDispatch(state, {
    resource: 'COR-1',
    runId: 'run',
    ownerId: 'owner',
  });
  if (!acquired.granted) throw new Error(acquired.reason);
  const assignment: Assignment = {
    version: assignmentVersion,
    identity: {
      identifier: 'COR-1',
      revision: 'fixture',
      repository: 'acme/widgets',
      base: BASE,
      digest: '',
    },
    criteria: [{ id: 'AC1', text: 'fixture' }],
    ownedPaths: [],
    exclusions: [],
    dependencies: [],
    sourceReferences: [],
    designRows: [],
    deliveryBoundary: 'fixture',
    allowedConsequentialActions: ['merge'],
    classification: 'behavior',
  };
  assignment.identity.digest = digest(
    JSON.stringify({ ...assignment, identity: { ...assignment.identity, digest: undefined } }),
  );
  const request: DeliveryRequest = {
    repository: 'acme/widgets',
    revision: HEAD,
    base: BASE,
    integrationTree: TREE,
    environment: 'linux',
    authority: acquired.authority,
    operationId: 'operation',
    worktree,
    members: [
      {
        assignment,
        plan: {
          version: 1,
          obligations: [
            {
              criterionId: 'AC1',
              risk: 'root-scripts',
              commandOrProviderJob: 'verify',
              expectedInventory: [],
              relevantInputs: [],
              environmentToolchain: 'linux',
              executionBoundary: 'provider',
              producer: 'fixture',
              selectionReason: 'fixture',
              evidenceKind: 'process-exit',
              phase: 'pre-integration',
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
        providerRuns: [
          {
            id: 7,
            obligation: 'AC1:verify',
            job: 'verify',
            workflow: 'Verify',
            workflowPath: '.github/workflows/verify.yml',
            event: 'push',
          },
        ],
        track: false,
        requestedClose: false,
        changes: ['fixture'],
        blockers: [],
      },
    ],
  };
  request.members[0]!.plan.invalidatedBy.assignment = assignment.identity.digest;
  // `none`: a request that pins no CI run, as one covered by a targeted run has none to pin.
  if (identity.none !== true)
    request.ciEvidence = [
      identity.dispatch === true
        ? landingIdentity(request, {
            event: 'workflow_dispatch',
            ...(identity.stale === true
              ? {}
              : { verificationPlanDigest: batchVerificationPlanDigest(request.members) }),
          })
        : landingIdentity(request),
    ];
  const text = JSON.stringify(request);
  const file = join(directory, 'verification.json');
  writeFileSync(file, text);
  const dependencies: DeliveryVerificationDependencies = {
    state,
    ciProvider: landingProvider(request),
    transport: {
      run: () => ({
        repository: 'acme/widgets',
        revision: HEAD,
        status: 'completed',
        conclusion: 'success',
        workflow: 'Verify',
        workflowPath: '.github/workflows/verify.yml',
        event: 'push',
        attempt: 1,
      }),
      job: () => ({
        id: 3,
        name: 'verify',
        status: 'completed',
        conclusion: 'success',
        runtime: 'linux',
        inventory: [],
        assertionPassed: null,
      }),
      content: () => ({ integrationTree: TREE, relevantInputs: [] }),
      artifact: () => ({ present: false, expired: false }),
    },
  };
  const binding = {
    file,
    digest: createHash('sha256').update(text).digest('hex'),
    stateDirectory: state.stateDirectory,
  };
  await recordMutationIntent(state, acquired.authority, {
    operationId: request.operationId,
    action: 'merge',
    intentFingerprint: 'fixture',
  });
  await prepareDeliveryVerification(binding, [assignment], { route, action: 'merge' }, { state });
  return { binding, dependencies };
}
