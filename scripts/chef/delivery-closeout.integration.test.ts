import { test as bunTest, expect } from 'bun:test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { throwingRejectionOf } from '../../testing/testing/src/helpers/promise-outcome.ts';
import { deliver, type DeliverOptions, type DeliverReport } from './deliver.ts';
import { closeDelivery } from './delivery-closeout.ts';
import { ledgerPath, recordDelivery } from './delivery-ledger.ts';
import { createDeliveryVerificationFixture } from './delivery-verification.test-support.ts';
import {
  loadDeliveryVerification,
  prepareDeliveryVerification,
  recordDeliveryMergeObservation,
} from './delivery-verification.ts';
import { cancelDispatch, readExecutionSnapshot } from './execution-state.ts';
import { type LinearClient } from './linear.ts';
import { createScenarios } from './scenario.test-support.ts';
import { digest } from './verification-plan.ts';

const mergeCommit = 'f'.repeat(40);
function report(): DeliverReport {
  return {
    pr: 12,
    branch: null,
    merged: true,
    mergeCommit,
    mergeable: null,
    mainHealthWarning: null,
    guardsAlreadyFailing: [],
    failedStep: null,
    detail: null,
    issues: [],
    acceptedReverts: [],
    leftOpen: [],
    worktree: null,
    swept: null,
    ledgerWarning: null,
  };
}

function tracker(
  options: { loseComment?: boolean; failState?: boolean; rejectComment?: boolean } = {},
) {
  const comments: { id: string; identifier: string; body: string; createdAt: string }[] = [];
  const states = new Map<string, string>();
  const writes: string[] = [];
  let lost = false;
  let failed = false;
  const client: LinearClient = {
    async request<T>(document: string, variables: Record<string, unknown> = {}): Promise<T> {
      const identifier = String(variables['id'] ?? variables['issueId']);
      if (document.includes('IssueRead'))
        return {
          issue: {
            id: identifier,
            identifier,
            title: 'Fixture',
            description: null,
            updatedAt: 'fixture',
            state: {
              id: states.get(identifier) ?? 'doing',
              name: states.get(identifier) === 'done' ? 'Done' : 'In Progress',
            },
            team: { id: 'team', key: 'COR', parent: null },
          },
        } as T;
      if (document.includes('IssueComments')) {
        const matching = comments.filter((comment) => comment.identifier === identifier);
        // Exercise the paginated marker recovery: the actual report is on the second page.
        return {
          issue: {
            comments:
              variables['after'] === null
                ? { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'second' } }
                : { nodes: matching, pageInfo: { hasNextPage: false, endCursor: null } },
          },
        } as T;
      }
      if (document.includes('CommentPost')) {
        if (options.rejectComment && !failed) {
          failed = true;
          return { commentCreate: { success: false, comment: null } } as T;
        }
        const id = `comment-${comments.length}`;
        comments.push({
          id,
          identifier,
          body: String(variables['body']),
          createdAt: '2026-11-18T00:00:00Z',
        });
        writes.push(`comment:${identifier}`);
        if (options.loseComment && !lost) {
          lost = true;
          throw new Error('lost comment response');
        }
        return { commentCreate: { success: true, comment: { id } } } as T;
      }
      if (document.includes('CommentRead')) {
        const comment = comments.find((item) => item.id === identifier);
        return {
          comment:
            comment === undefined
              ? null
              : { ...comment, issue: { identifier: comment.identifier } },
        } as T;
      }
      if (document.includes('TeamStates'))
        return {
          workflowStates: { nodes: [{ id: 'done', name: 'Done', team: { id: 'team' } }] },
        } as T;
      if (document.includes('IssueSetState')) {
        if (options.failState && !failed) {
          failed = true;
          throw new Error('tracker state unavailable');
        }
        writes.push(`state:${identifier}`);
        states.set(identifier, 'done');
        return { issueUpdate: { success: true } } as T;
      }
      throw new Error(`unexpected fixture request: ${document}`);
    },
  };
  return { client, writes, comments, states };
}

async function setup(pendingMember = false, trackedPending = true) {
  const fixture = await createDeliveryVerificationFixture(undefined, {
    route: 'pull-request',
    approved: false,
  });
  fixture.request.members[0]!.track = true;
  fixture.request.members[0]!.requestedClose = true;
  if (pendingMember) {
    const member = structuredClone(fixture.request.members[0]!);
    member.assignment.identity.identifier = 'COR-2';
    member.assignment.identity.digest = 'e'.repeat(64);
    member.plan.invalidatedBy.assignment = member.assignment.identity.digest;
    member.plan.obligations[0]!.phase = 'completion';
    member.providerRuns = [];
    member.track = trackedPending;
    member.requestedClose = trackedPending;
    fixture.request.members.push(member);
  }
  const text = JSON.stringify(fixture.request);
  writeFileSync(fixture.verification.file, text);
  fixture.verification.digest = digest(text);
  await prepareDeliveryVerification(
    fixture.verification,
    fixture.request.members.map((member) => member.assignment),
    { route: 'pull-request', action: 'merge' },
    fixture.dependencies,
  );
  const loaded = loadDeliveryVerification(fixture.verification, fixture.dependencies);
  await recordDeliveryMergeObservation(
    loaded,
    {
      route: 'pull-request',
      pullRequest: 12,
      reviewedHead: fixture.request.revision,
      base: fixture.request.base,
      integrationTree: fixture.request.integrationTree,
      state: 'confirmed-merge',
      mergeCommit,
    },
    'observed',
    fixture.dependencies,
  );
  const ledgerDirectory = dirname(fixture.verification.file);
  const configuration = join(ledgerDirectory, 'repository.json');
  writeFileSync(
    configuration,
    JSON.stringify({
      repository: fixture.request.repository,
      defaultBranch: 'main',
      worktreeRoots: { codex: ledgerDirectory, claude: ledgerDirectory },
      manifestName: 'fixture',
      installCommand: 'true',
      gateCommand: 'true',
      affectedCheckCommand: 'true',
      mergeMethod: 'squash',
    }),
  );
  const options: DeliverOptions = {
    configPath: configuration,
    pr: 12,
    worktree: fixture.directory,
    commentFile: join(fixture.directory, 'comment.md'),
    keepWorktree: true,
    verification: fixture.verification,
  };
  const record = (entry: Parameters<typeof recordDelivery>[1]) =>
    recordDelivery(ledgerDirectory, entry);
  return { fixture, loaded, options, record, ledgerDirectory };
}

const scenarios = createScenarios({}, { test: bunTest, describe: (_name, body) => body() });
scenarios.scenario(
  'lost tracker comment response is recovered by paginated marker without duplicate write',
  async () => {
    const context = await setup();
    const remote = tracker({ loseComment: true });
    const dependencies = {
      client: remote.client,
      record: context.record,
      verification: context.fixture.dependencies,
    };
    const first = await closeDelivery(context.loaded, context.options, report(), dependencies);
    expect(first.failedStep).toBe('issue');
    const second = await closeDelivery(context.loaded, context.options, report(), dependencies);
    expect(second.failedStep).toBeNull();
    expect(second.issues).toEqual([{ identifier: 'COR-1', state: 'Done' }]);
    expect(remote.writes).toEqual(['comment:COR-1', 'state:COR-1']);
    expect(
      readFileSync(ledgerPath(context.ledgerDirectory), 'utf8').trim().split('\n'),
    ).toHaveLength(1);
  },
);

scenarios.scenario(
  'tracker state failure resumes state only and preserves independent pending release member',
  async () => {
    const context = await setup(true);
    const remote = tracker({ failState: true });
    const dependencies = {
      client: remote.client,
      record: context.record,
      verification: context.fixture.dependencies,
    };
    const failed = await closeDelivery(context.loaded, context.options, report(), dependencies);
    expect(failed.failedStep).toBe('issue');
    const result = await closeDelivery(context.loaded, context.options, report(), dependencies);
    expect(result.issues).toEqual([{ identifier: 'COR-1', state: 'Done' }]);
    expect(result.leftOpen).toEqual(['COR-2']);
    expect(remote.writes).toEqual(['comment:COR-1', 'state:COR-1', 'comment:COR-2']);
    expect(readExecutionSnapshot(context.fixture.state).pendingCloseout).toContain('operation');
  },
);

scenarios.scenario(
  'known failed comment can retry while cleanup failure resumes only owned cleanup',
  async () => {
    const context = await setup();
    const remote = tracker({ rejectComment: true });
    let removals = 0;
    const dependencies = {
      client: remote.client,
      record: context.record,
      verification: context.fixture.dependencies,
      remove: () => {
        removals++;
        if (removals === 1) throw new Error('owned cleanup unavailable');
        return {
          path: context.fixture.directory,
          branch: 'fixture',
          remoteDeleted: true,
          ended: [],
        };
      },
    };
    const options = { ...context.options, keepWorktree: false };
    const commentFailure = await closeDelivery(context.loaded, options, report(), dependencies);
    expect(commentFailure.failedStep).toBe('issue');
    const cleanupFailure = await closeDelivery(context.loaded, options, report(), dependencies);
    expect(cleanupFailure.failedStep).toBe('worktree');
    const final = await closeDelivery(context.loaded, options, report(), dependencies);
    expect(final.failedStep).toBeNull();
    expect(removals).toBe(2);
    expect(remote.writes).toEqual(['comment:COR-1', 'state:COR-1']);
  },
);

scenarios.scenario(
  'ledger append with lost result retries idempotently before tracker writes',
  async () => {
    const context = await setup();
    const remote = tracker();
    let lost = false;
    const dependencies = {
      client: remote.client,
      verification: context.fixture.dependencies,
      record: (entry: Parameters<typeof recordDelivery>[1]) => {
        context.record(entry);
        if (!lost) {
          lost = true;
          throw new Error('lost ledger completion');
        }
      },
    };
    const failed = await closeDelivery(context.loaded, context.options, report(), dependencies);
    expect(failed.failedStep).toBe('ledger');
    expect(remote.writes).toEqual([]);
    const recovered = await closeDelivery(context.loaded, context.options, report(), dependencies);
    expect(recovered.failedStep).toBeNull();
    expect(
      readFileSync(ledgerPath(context.ledgerDirectory), 'utf8').trim().split('\n'),
    ).toHaveLength(1);
  },
);

scenarios.scenario(
  'cancelled authority rejects closeout before ledger or tracker effects',
  async () => {
    const context = await setup();
    const remote = tracker();
    let ledgerWrites = 0;
    await cancelDispatch(context.fixture.state, context.fixture.request.authority);
    expect(
      await throwingRejectionOf(
        closeDelivery(context.loaded, context.options, report(), {
          client: remote.client,
          verification: context.fixture.dependencies,
          record: () => {
            ledgerWrites++;
          },
        }),
      ),
    ).toThrow('revoked');
    expect(ledgerWrites).toBe(0);
    expect(remote.writes).toEqual([]);
  },
);
scenarios.scenario(
  'cleanup success with a lost state write resumes after the worktree is gone',
  async () => {
    const context = await setup();
    const remote = tracker();
    let beforeCleanup = '';
    let removals = 0;
    let mergeCalls = 0;
    const dependencies = {
      client: remote.client,
      record: context.record,
      verification: context.fixture.dependencies,
      remove: () => {
        removals++;
        beforeCleanup = readFileSync(context.fixture.state.statePath, 'utf8');
        rmSync(context.fixture.directory, { recursive: true, force: true });
        writeFileSync(context.fixture.state.statePath, 'interrupted state write');
        return {
          path: context.fixture.directory,
          branch: 'fixture',
          remoteDeleted: true,
          ended: [],
        };
      },
      merge: async () => {
        mergeCalls++;
        throw new Error('must not merge again');
      },
    };
    const options = { ...context.options, keepWorktree: false };
    const first = await closeDelivery(context.loaded, options, report(), dependencies);
    expect(first.failedStep).toBe('worktree');
    writeFileSync(context.fixture.state.statePath, beforeCleanup);
    const recovered = await deliver(options, dependencies);
    expect(recovered.failedStep).toBeNull();
    expect(recovered.worktree?.removed).toBe(true);
    expect(removals).toBe(1);
    expect(mergeCalls).toBe(0);
    expect(remote.writes).toEqual(['comment:COR-1', 'state:COR-1']);
  },
);
scenarios.scenario(
  'untracked release obligations still keep the batch and owned worktree open',
  async () => {
    const context = await setup(true, false);
    const remote = tracker();
    let removals = 0;
    const result = await closeDelivery(
      context.loaded,
      { ...context.options, keepWorktree: false },
      report(),
      {
        client: remote.client,
        record: context.record,
        verification: context.fixture.dependencies,
        remove: () => {
          removals++;
          throw new Error('must preserve pending worktree');
        },
      },
    );
    expect(result.failedStep).toBeNull();
    expect(result.issues).toEqual([{ identifier: 'COR-1', state: 'Done' }]);
    expect(result.worktree?.removed).toBe(false);
    expect(removals).toBe(0);
    const snapshot = readExecutionSnapshot(context.fixture.state);
    expect(snapshot.operations['operation']?.closeout?.complete).toBe(false);
    expect(snapshot.pendingCloseout).toContain('operation');
  },
);
await scenarios.settled();
