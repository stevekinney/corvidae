import { expect } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { rejectionOf } from '../../testing/testing/src/helpers/promise-outcome.ts';
import { createDeliveryFixture, branchRunner as landingRunner } from './deliver.test-support.ts';
import { deliver, renderDeliver, run, type DeliverOptions, type LeaseReading } from './deliver.ts';
import { readDeliveryRequest } from './delivery-completion.ts';
import { ledgerLine, type LedgerEntry } from './delivery-ledger.ts';
import {
  loadDeliveryVerification,
  prepareDeliveryVerification,
  recordDeliveryMergeObservation,
  type DeliveryVerification,
  type DeliveryVerificationDependencies,
} from './delivery-verification.ts';
import { designVerdictPath } from './design-verdict.ts';
import { directMerge, type DirectMergeOptions } from './direct-merge.ts';
import { recordMutationIntent } from './execution-state.ts';
import {
  changedAnswer,
  greenLandingAnswers,
  jobsAnswer,
  landingProvider,
  runsAnswer,
} from './landing-evidence.test-support.ts';
import { targetedRunName } from './landing-evidence.ts';
import { landingPlan } from './landing-plan.ts';
import { LinearError, type LinearClient } from './linear.ts';
import type { MergeGateOptions, MergeGateReport } from './merge-gate.ts';
import { UsageError, type Runner, type RunnerResult } from './process-runner.ts';
import { createScenarios } from './scenario.test-support.ts';
import type { GuardsResult } from './text-guards.ts';
import type { UsageTotals } from './transcript-usage.ts';
import { digest } from './verification-plan.ts';
import { Refusal, type RemoveOptions } from './worktree.ts';

const HEAD = 'a'.repeat(40);
const BASE = 'c'.repeat(40);
const TREE = '1'.repeat(40);
const MERGE_COMMIT = 'd'.repeat(40);

let sandbox: string;
let control: string;
let options: DeliverOptions;
let verification: DeliveryVerificationDependencies;

async function deliveryVerification(
  directory: string,
  worktree: string,
  route = 'pull-request',
): Promise<DeliveryVerification> {
  const made = await createDeliveryFixture(directory, worktree, route);
  verification = made.dependencies;
  return made.binding;
}

let operationSequence = 0;
async function approvedMembers<T extends Partial<DeliverOptions>>(
  base: T,
  identifiers: string[],
  closes: string[] = [],
  route = 'pull-request',
): Promise<T & { verification: DeliveryVerification }> {
  if (closes.some((identifier) => !identifiers.includes(identifier)))
    throw new UsageError('requested close has no tracked member');
  const original = readDeliveryRequest(options.verification.file, options.verification.digest);
  const request = structuredClone(original);
  request.operationId = `scenario-${++operationSequence}`;
  const template = original.members[0]!;
  request.members =
    identifiers.length === 0
      ? [{ ...structuredClone(template), track: false, requestedClose: false }]
      : identifiers.map((identifier) => {
          const member = structuredClone(template);
          member.assignment.identity.identifier = identifier;
          member.assignment.identity.digest = digest(
            JSON.stringify({
              ...member.assignment,
              identity: { ...member.assignment.identity, digest: undefined },
            }),
          );
          member.plan.invalidatedBy.assignment = member.assignment.identity.digest;
          member.track = true;
          member.requestedClose = closes.includes(identifier);
          return member;
        });
  const text = JSON.stringify(request);
  const binding = {
    ...options.verification,
    file: join(control, `${request.operationId}.json`),
    digest: digest(text),
  };
  writeFileSync(binding.file, text);
  await recordMutationIntent(verification.state, request.authority, {
    operationId: request.operationId,
    action: 'merge',
    intentFingerprint: digest(text),
  });
  await prepareDeliveryVerification(
    binding,
    request.members.map((member) => member.assignment),
    { route, action: 'merge' },
    verification,
  );
  return { ...base, verification: binding };
}

async function setUp(): Promise<void> {
  sandbox = mkdtempSync(join(tmpdir(), 'deliver-'));
  control = mkdtempSync(join(tmpdir(), 'deliver-control-'));
  const configPath = join(control, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      repository: 'acme/widgets',
      defaultBranch: 'main',
      worktreeRoots: { claude: '/c', codex: '/x' },
      manifestName: 'widgets',
      installCommand: 'install-command',
      gateCommand: 'true',
      affectedCheckCommand: 'true',
      mergeMethod: 'squash',
    }),
  );
  writeFileSync(join(sandbox, 'comment.md'), 'Accepted.\n');
  options = {
    configPath,
    pr: 12,
    run: 'run',
    project: 'Widgets',
    worktree: sandbox,
    commentFile: join(sandbox, 'comment.md'),
    verification: await deliveryVerification(control, sandbox),
  };
}

function tearDown(): void {
  rmSync(sandbox, { recursive: true, force: true });
  rmSync(control, { recursive: true, force: true });
}

const scenarios = createScenarios({ setUp, tearDown });

const mergedReport = (overrides: Partial<MergeGateReport> = {}): MergeGateReport => ({
  pr: 12,
  head: HEAD,
  base: BASE,
  mergeable: 'MERGEABLE',
  threads: { seen: 1, total: 1, unresolved: 0 },
  merged: true,
  mergeCommit: MERGE_COMMIT,
  treesMatch: true,
  failedStep: null,
  detail: null,
  ...overrides,
});

/** The merge gate and the closeout steps, recording what each was asked. */
function seams(
  overrides: {
    merge?: MergeGateReport;
    refusal?: string;
    usageError?: string;
    /** The processes the removal reports it ended. */
    ended?: { pid: number; command: string; cwd: string }[];
    /** The identifier whose state change Linear rejects. */
    failState?: string;
    /** The ledger write throws this. */
    ledgerFailure?: string;
  } = {},
) {
  const record = {
    ledger: [] as LedgerEntry[],
    merges: [] as MergeGateOptions[],
    removals: [] as string[],
    removeCalls: [] as RemoveOptions[],
    requests: [] as string[],
    /** The identifier each comment and state change was made on, in order. */
    writes: [] as string[],
  };
  const states = new Map<string, string>();
  const comments = new Map<string, { body: string; identifier: string }>();
  const stateOf = (identifier: string) => states.get(identifier) ?? 'In Progress';
  const client: LinearClient = {
    async request<T>(document: string, variables: Record<string, unknown> = {}): Promise<T> {
      record.requests.push(document.split(/[ (]/)[1] ?? document);
      const identifier = String(variables['id'] ?? variables['issueId']).replace(/^uuid-/, '');
      const issue = (key: string) => ({
        id: `uuid-${key}`,
        identifier: key,
        title: 'T',
        description: null,
        updatedAt: 'x',
        state: {
          id: stateOf(key) === 'Done' ? 's-done' : 's-doing',
          name: stateOf(key),
        },
        team: { id: 'team', key: 'COR', parent: null },
      });
      if (document.includes('IssueRead')) return { issue: issue(identifier) } as T;
      if (document.includes('IssueComments'))
        return {
          issue: {
            comments: {
              nodes: [...comments.entries()]
                .filter(([, comment]) => comment.identifier === identifier)
                .map(([id, comment], index) => ({
                  id,
                  body: comment.body,
                  createdAt: `2026-11-18T00:00:0${index}.000Z`,
                })),
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        } as T;
      if (document.includes('CommentPost')) {
        const id = `c${comments.size + 1}`;
        comments.set(id, { body: String(variables['body']), identifier });
        record.writes.push(`comment ${identifier}`);
        return { commentCreate: { success: true, comment: { id } } } as T;
      }
      if (document.includes('CommentRead')) {
        const found = comments.get(String(variables['id']));
        return {
          comment: found && {
            id: variables['id'],
            body: found.body,
            issue: { identifier: found.identifier },
          },
        } as T;
      }
      if (document.includes('TeamStates'))
        return {
          workflowStates: { nodes: [{ id: 's-done', name: 'Done', team: { id: 'team' } }] },
        } as T;
      if (document.includes('IssueSetState')) {
        if (identifier === overrides.failState)
          throw new LinearError('Linear rejected the request: nope');
        states.set(identifier, 'Done');
        record.writes.push(`state ${identifier}`);
        return { issueUpdate: { success: true } } as T;
      }
      throw new LinearError(`unexpected request ${document}`);
    },
  };
  return {
    record,
    partial: {
      merge: async (mergeOptions: MergeGateOptions) => {
        record.merges.push(mergeOptions);
        const report = overrides.merge ?? mergedReport();
        if (report.merged && report.mergeCommit !== null) {
          const loaded = loadDeliveryVerification(mergeOptions.verification, verification);
          await recordDeliveryMergeObservation(
            loaded,
            {
              route: 'pull-request',
              pullRequest: mergeOptions.pr,
              reviewedHead: HEAD,
              base: BASE,
              integrationTree: TREE,
              mergeCommit: report.mergeCommit,
              state: 'confirmed-merge',
            },
            'observed',
            verification,
          );
        }
        return report;
      },
      remove: (removeOptions: RemoveOptions) => {
        record.removals.push(removeOptions.name);
        record.removeCalls.push(removeOptions);
        if (overrides.refusal !== undefined) throw new Refusal(overrides.refusal);
        if (overrides.usageError !== undefined) throw new UsageError(overrides.usageError);
        return { path: '/c/alpha', branch: 'b', remoteDeleted: true, ended: overrides.ended ?? [] };
      },
      record: (entry: LedgerEntry) => {
        if (overrides.ledgerFailure !== undefined) throw new Error(overrides.ledgerFailure);
        record.ledger.push(entry);
      },
      client,
      readLease: async () => ({ run: 'run', live: true }),
      verification,
    },
  };
}

const refusal = (failedStep: string, detail: string) =>
  mergedReport({ merged: false, mergeCommit: null, failedStep, detail });

scenarios.describe('deliver', () => {
  scenarios.scenario(
    'merges through the merge gate alone: no gate, no base merge, no install',
    async () => {
      const { partial, record } = seams();
      const report = await deliver(options, partial);
      expect(report).toEqual({
        pr: 12,
        branch: null,
        merged: true,
        mergeCommit: MERGE_COMMIT,
        mergeable: 'MERGEABLE',
        mainHealthWarning: null,
        guardsAlreadyFailing: [],
        failedStep: null,
        detail: null,
        leftOpen: [],
        acceptedReverts: [],
        worktree: { removed: true, detail: '/c/alpha' },
        swept: null,
        ledgerWarning: null,
        issues: [],
      });
      expect(record.merges).toHaveLength(1);
      expect(record.merges[0]).toMatchObject({ pr: 12, dryRun: false, checkMainHealth: true });
      expect(record.merges[0]).not.toHaveProperty('gateLog');
      expect(Object.keys(partial).toSorted()).toEqual([
        'client',
        'merge',
        'readLease',
        'record',
        'remove',
        'verification',
      ]);
    },
  );

  scenarios.scenario('a base that moved without a conflict is merged as it is', async () => {
    // The merge gate reads GitHub's answer; BEHIND with no conflict is not a refusal.
    const { partial, record } = seams({ merge: mergedReport({ mergeable: 'MERGEABLE' }) });
    const report = await deliver(options, partial);
    expect(report).toMatchObject({ merged: true, failedStep: null });
    expect(record.merges).toHaveLength(1);
  });

  for (const [step, detail] of [
    ['conflict', 'GitHub reports the pull request conflicts with origin/main'],
    ['head', 'the pull request head is not the head pinned at acceptance'],
    ['threads', '1 review thread(s) are unresolved.'],
    ['mergeable', 'GitHub still reports the mergeability as UNKNOWN'],
  ] as const)
    scenarios.scenario(
      `a ${step} refusal is reported under its step, with nothing merged`,
      async () => {
        const { partial, record } = seams({ merge: refusal(step, detail) });
        const report = await deliver(
          await approvedMembers({ ...options }, ['COR-9'], [], 'pull-request'),
          partial,
        );
        expect(report).toMatchObject({ merged: false, failedStep: step, detail });
        expect(record.merges).toHaveLength(1);
        expect(record.requests).toEqual([]);
        expect(renderDeliver(report)).toContain(`FAILED at ${step}`);
      },
    );

  scenarios.scenario(
    'forwards the pinned head and the fix declaration to the merge gate',
    async () => {
      const { partial, record } = seams();
      await deliver({ ...options, expectedHead: HEAD, fixesMain: true }, partial);
      expect(record.merges[0]).toMatchObject({ expectedHead: HEAD, fixesMain: true });
    },
  );

  scenarios.scenario(
    'a red main is a warning in the report and the text, and the merge still happens',
    async () => {
      const { partial } = seams({
        merge: mergedReport({ mainHealthWarning: 'main main.yml at aaaa: failure (RED).' }),
      });
      const report = await deliver(options, partial);
      expect(report).toMatchObject({ merged: true, failedStep: null });
      expect(report.mainHealthWarning).toContain('RED');
      expect(renderDeliver(report)).toContain('WARNING main health:');
    },
  );

  scenarios.scenario('no merge runner is a named failure, never a silent skip', async () => {
    const report = await deliver(options, {
      verification,
      readLease: async () => ({ run: 'run', live: true }),
    });
    expect(report).toMatchObject({ merged: false, failedStep: 'merge' });
  });

  scenarios.scenario(
    '--usage-log and --transcript reach the merge gate; without them there is no record',
    async () => {
      const withRecord = seams();
      await deliver(
        { ...options, usageLog: '/tmp/usage.tsv', transcripts: ['/a.jsonl', '/b'] },
        withRecord.partial,
      );
      expect(withRecord.record.merges[0]?.usageLog).toBe('/tmp/usage.tsv');
      expect(withRecord.record.merges[0]?.transcripts).toEqual(['/a.jsonl', '/b']);
      const without = seams();
      options = await approvedMembers(options, []);
      await deliver(options, without.partial);
      expect(without.record.merges).toHaveLength(1);
      expect(without.record.merges[0]).not.toHaveProperty('usageLog');
    },
  );

  scenarios.scenario(
    'closes the issue with the completion comment and the Done state, read back',
    async () => {
      const { partial, record } = seams();
      const report = await deliver(
        await approvedMembers({ ...options }, ['COR-9'], ['COR-9'], 'pull-request'),
        partial,
      );
      expect(report).toMatchObject({
        merged: true,
        failedStep: null,
        issues: [{ identifier: 'COR-9', state: 'Done' }],
      });
      expect(record.requests).toContain('CommentPost');
      expect(record.requests).toContain('IssueSetState');
      expect(renderDeliver(report)).toContain('issues: COR-9 Done');
    },
  );

  scenarios.scenario(
    'a --pr delivery of an issue it names with --issue leaves its state alone without --closes',
    async () => {
      const { partial, record } = seams();
      const report = await deliver(
        await approvedMembers({ ...options }, ['COR-9'], [], 'pull-request'),
        partial,
      );
      expect(report).toMatchObject({
        merged: true,
        failedStep: null,
        leftOpen: ['COR-9'],
        issues: [],
      });
      expect(record.writes).toEqual(['comment COR-9']);
      expect(record.requests).not.toContain('IssueSetState');
      const lines = renderDeliver(report).split('\n');
      expect(lines.at(-1)).toContain('left open, state untouched: COR-9');
    },
  );

  scenarios.scenario(
    'with no issue named it says that nothing was closed and writes nothing to Linear',
    async () => {
      const { partial, record } = seams();
      const report = await deliver(options, partial);
      expect(record.requests).toEqual([]);
      expect(renderDeliver(report).split('\n').at(-1)).toContain('no tracked member');
    },
  );

  scenarios.scenario(
    '--closes closes only the issue it names and leaves the others open',
    async () => {
      const { partial, record } = seams();
      const report = await deliver(
        await approvedMembers({ ...options }, ['COR-9', 'COR-10'], ['COR-10'], 'pull-request'),
        partial,
      );
      expect(report).toMatchObject({
        leftOpen: ['COR-9'],
        issues: [{ identifier: 'COR-10', state: 'Done' }],
      });
      expect(record.writes).toEqual(['comment COR-9', 'comment COR-10', 'state COR-10']);
    },
  );

  scenarios.scenario('refuses unapproved requested close before any merge', async () => {
    const { partial, record } = seams();
    const request = readDeliveryRequest(options.verification.file, options.verification.digest);
    request.members[0]!.track = true;
    request.members[0]!.requestedClose = true;
    const text = JSON.stringify(request);
    const file = join(control, 'changed-close.json');
    writeFileSync(file, text);
    const error = await rejectionOf(
      deliver(
        { ...options, verification: { ...options.verification, file, digest: digest(text) } },
        partial,
      ),
    );
    expect(error).toBeInstanceOf(UsageError);
    expect(String(error)).toContain('approval binding');
    expect(record.merges).toEqual([]);
  });

  scenarios.scenario(
    'closes several issues in order, each with its own comment and then Done',
    async () => {
      const { partial, record } = seams();
      const report = await deliver(
        await approvedMembers(
          { ...options },
          ['COR-9', 'COR-10'],
          ['COR-9', 'COR-10'],
          'pull-request',
        ),
        partial,
      );
      expect(report).toMatchObject({
        merged: true,
        failedStep: null,
        issues: [
          { identifier: 'COR-9', state: 'Done' },
          { identifier: 'COR-10', state: 'Done' },
        ],
      });
      expect(record.writes).toEqual([
        'comment COR-9',
        'state COR-9',
        'comment COR-10',
        'state COR-10',
      ]);
      expect(renderDeliver(report)).toContain('issues: COR-9 Done, COR-10 Done');
    },
  );

  scenarios.scenario('a failed comment names its issue exactly once', async () => {
    const { partial } = seams();
    const unread: LinearClient = {
      async request<T>(document: string, variables: Record<string, unknown> = {}): Promise<T> {
        if (document.includes('CommentPost'))
          return { commentCreate: { success: false, comment: null } } as T;
        return partial.client.request<T>(document, variables);
      },
    };
    const report = await deliver(
      await approvedMembers({ ...options }, ['COR-9'], [], 'pull-request'),
      { ...partial, client: unread },
    );
    expect(report).toMatchObject({ merged: true, failedStep: 'issue', issues: [] });
    expect(report.detail).toBe('COR-9: the comment was not created.');
  });

  scenarios.scenario(
    'a failure on the second issue keeps the first closed and names the second',
    async () => {
      const { partial, record } = seams({ failState: 'COR-10' });
      const report = await deliver(
        await approvedMembers(
          { ...options },
          ['COR-9', 'COR-10', 'COR-11'],
          ['COR-9', 'COR-10', 'COR-11'],
          'pull-request',
        ),
        partial,
      );
      expect(report).toMatchObject({
        merged: true,
        mergeCommit: MERGE_COMMIT,
        failedStep: 'issue',
        issues: [{ identifier: 'COR-9', state: 'Done' }],
      });
      expect(report.detail).toStartWith('COR-10:');
      expect(report.detail).toContain('nope');
      expect(record.writes).toEqual(['comment COR-9', 'state COR-9', 'comment COR-10']);
      expect(record.removals).toEqual([]);
      expect(renderDeliver(report)).toContain('issues: COR-9 Done');
      expect(renderDeliver(report)).toContain('FAILED at issue: COR-10:');
    },
  );

  scenarios.scenario(
    'a Linear failure after the merge is step issue with merged true, and removal is skipped',
    async () => {
      const { partial, record } = seams();
      const broken: LinearClient = {
        async request() {
          throw new LinearError('Linear rejected the request: nope');
        },
      };
      const report = await deliver(
        await approvedMembers({ ...options }, ['COR-9'], [], 'pull-request'),
        { ...partial, client: broken },
      );
      expect(report).toMatchObject({
        merged: true,
        failedStep: 'issue',
        mergeCommit: MERGE_COMMIT,
      });
      expect(report.detail).toContain('nope');
      expect(report.issues).toEqual([]);
      expect(record.removals).toEqual([]);
    },
  );

  scenarios.scenario(
    'removes the delivered worktree by default, naming its path and the delivered tip',
    async () => {
      const { partial, record } = seams();
      const report = await deliver({ ...options, expectedHead: HEAD }, partial);
      expect(report).toMatchObject({ merged: true, failedStep: null });
      expect(report.worktree).toEqual({ removed: true, detail: '/c/alpha' });
      expect(record.removeCalls).toEqual([
        {
          configPath: options.configPath,
          name: sandbox,
          keepRemote: false,
          deliveredTip: HEAD,
          endProcesses: true,
        },
      ]);
      expect(renderDeliver(report).split('\n')[1]).toBe('worktree removed: /c/alpha');
    },
  );

  scenarios.scenario(
    'names the processes the removal ended inside the delivered worktree',
    async () => {
      const { partial } = seams({ ended: [{ pid: 10, command: 'bun', cwd: '/c/alpha' }] });
      const report = await deliver({ ...options, expectedHead: HEAD }, partial);
      expect(report.worktree).toEqual({
        removed: true,
        detail: '/c/alpha (ended 1 process(es) left running inside it)',
      });
    },
  );

  scenarios.scenario(
    'a pull request delivery with no --head names the pull request head as the delivered tip',
    async () => {
      const { partial, record } = seams();
      await deliver(options, partial);
      expect(record.removeCalls[0]?.deliveredTip).toBe(HEAD);
    },
  );

  scenarios.scenario('--keep-worktree removes nothing and says so', async () => {
    const { partial, record } = seams();
    const report = await deliver({ ...options, keepWorktree: true }, partial);
    expect(record.removals).toEqual([]);
    expect(report.worktree).toEqual({ removed: false, detail: 'kept by --keep-worktree' });
    expect(renderDeliver(report).split('\n')[1]).toBe('worktree kept: kept by --keep-worktree');
  });

  scenarios.scenario(
    'a cleanup refusal keeps the worktree and records a recoverable failure',
    async () => {
      const { partial, record } = seams({
        refusal: 'Refusing to remove /c/alpha: Git reports it locked',
      });
      const report = await deliver(options, partial);
      expect(report).toMatchObject({ merged: true, failedStep: 'worktree' });
      expect(report.failedStep).toBe('worktree');
      expect(report.worktree?.removed).toBe(false);
      expect(report.worktree?.detail).toContain('locked');
      expect(record.removals).toEqual([sandbox]);
      expect(renderDeliver(report)).toContain('worktree kept: Refusing to remove /c/alpha');
      expect(renderDeliver(report)).toContain('FAILED at worktree');
    },
  );

  scenarios.scenario('invalid cleanup input remains a recoverable worktree failure', async () => {
    const { partial } = seams({ usageError: 'not a safe name.' });
    const report = await deliver(options, partial);
    expect(report).toMatchObject({ merged: true, failedStep: 'worktree' });
    expect(report.failedStep).toBe('worktree');
    expect(report.worktree).toEqual({ removed: false, detail: 'not a safe name.' });
  });

  scenarios.scenario('a delivery that did not merge touches no worktree', async () => {
    const { partial, record } = seams({ merge: refusal('conflict', 'x') });
    const report = await deliver(options, partial);
    expect(report.worktree).toBeNull();
    expect(record.removals).toEqual([]);
    expect(record.ledger).toEqual([]);
  });
});

scenarios.describe('the delivery ledger and owned cleanup', () => {
  scenarios.scenario(
    'a pull request delivery records its number, head and merge commit',
    async () => {
      const { partial, record } = seams();
      await deliver(options, partial);
      expect(record.ledger).toEqual([
        {
          pr: 12,
          branch: undefined,
          head: HEAD,
          mergeCommit: MERGE_COMMIT,
          operationId: 'operation',
        },
      ]);
    },
  );

  scenarios.scenario('a branch delivery records its branch, head and merge commit', async () => {
    const world = branchWorld();
    const { report, record, operationId } = await deliverBranch(world);
    expect(report.failedStep).toBeNull();
    expect(record.ledger[0]?.operationId).toStartWith('scenario-');
    expect(record.ledger).toEqual([
      {
        pr: undefined,
        branch: BRANCH,
        head: HEAD,
        mergeCommit: SQUASH,
        operationId,
      },
    ]);
  });

  scenarios.scenario(
    'a ledger line is the time, subject, head, merge commit and operation identity',
    () => {
      const time = new Date('2026-11-13T21:00:00.000Z');
      expect(
        ledgerLine({
          pr: 12,
          head: HEAD,
          mergeCommit: MERGE_COMMIT,
          operationId: 'operation',
          time,
        }),
      ).toBe(`2026-11-13T21:00:00.000Z\tpr:12\t${HEAD}\t${MERGE_COMMIT}\toperation`);
      expect(
        ledgerLine({
          branch: BRANCH,
          head: HEAD,
          mergeCommit: null,
          operationId: 'operation',
          time,
        }),
      ).toBe(`2026-11-13T21:00:00.000Z\tbranch:${BRANCH}\t${HEAD}\t-\toperation`);
      expect(() =>
        ledgerLine({ branch: BRANCH, head: 'abc', mergeCommit: null, operationId: 'operation' }),
      ).toThrow('SHA');
    },
  );

  scenarios.scenario('a ledger write failure remains a recoverable closeout failure', async () => {
    const { partial } = seams({ ledgerFailure: 'disk full' });
    const report = await deliver(options, partial);
    expect(report).toMatchObject({ merged: true, failedStep: 'ledger' });
    expect(renderDeliver(report)).toContain('FAILED at ledger: disk full');
  });

  scenarios.scenario('does not sweep other workers after a successful delivery', async () => {
    const { partial, record } = seams();
    const report = await deliver(options, partial);
    expect(report.swept).toBeNull();
    expect(Object.keys(partial)).not.toContain('sweep');
    expect(record.removals).toEqual([sandbox]);
  });

  scenarios.scenario('--keep-worktree does not turn delivery into broad cleanup', async () => {
    const { partial, record } = seams();
    const report = await deliver({ ...options, keepWorktree: true }, partial);
    expect(report).toMatchObject({ merged: true, failedStep: null });
    expect(report.swept).toBeNull();
    expect(record.removals).toEqual([]);
  });

  scenarios.scenario('a failed step runs no cleanup', async () => {
    const { partial, record } = seams({ failState: 'COR-9' });
    const report = await deliver(
      await approvedMembers({ ...options }, ['COR-9'], ['COR-9'], 'pull-request'),
      partial,
    );
    expect(report.failedStep).toBe('issue');
    expect(record.ledger).toHaveLength(1);
  });
});

scenarios.describe('structured completion contract', () => {
  for (const kind of [
    'missing member',
    'duplicate member',
    'unbound criterion',
    'missing phase',
    'untracked close',
  ] as const)
    scenarios.scenario(`refuses ${kind} before any merge or tracker write`, async () => {
      const { partial, record } = seams();
      const request = readDeliveryRequest(options.verification.file, options.verification.digest);
      if (kind === 'missing member') request.members = [];
      if (kind === 'duplicate member') request.members.push(structuredClone(request.members[0]!));
      if (kind === 'unbound criterion')
        request.members[0]!.plan.obligations[0]!.criterionId = 'UNKNOWN';
      if (kind === 'missing phase')
        Reflect.deleteProperty(request.members[0]!.plan.obligations[0]!, 'phase');
      if (kind === 'untracked close') request.members[0]!.requestedClose = true;
      const text = JSON.stringify(request);
      const file = join(control, 'malformed.json');
      writeFileSync(file, text);
      const error = await rejectionOf(
        deliver(
          { ...options, verification: { ...options.verification, file, digest: digest(text) } },
          partial,
        ),
      );
      expect(error).toBeInstanceOf(Error);
      expect(record.merges).toEqual([]);
      expect(record.requests).toEqual([]);
    });
});

scenarios.describe('run', () => {
  scenarios.scenario(
    '--help prints the usage, with every option, and exits 0 without touching anything',
    async () => {
      const { partial, record } = seams();
      const result = await run(['--help'], partial);
      expect(result.code).toBe(0);
      expect(result.output).toStartWith('Usage:');
      for (const option of ['--pr', '--branch', '--verification-file', '--intended'])
        expect(result.output).toContain(option);
      expect(record.merges).toEqual([]);
    },
  );

  const argv = (extra: string[] = []) => [
    '--config',
    options.configPath,
    '--pr',
    '12',
    '--worktree',
    sandbox,
    '--comment-file',
    join(sandbox, 'comment.md'),
    '--verification-file',
    options.verification.file,
    '--verification-digest',
    options.verification.digest,
    '--run',
    'run',
    '--project',
    'Widgets',
    ...extra,
  ];

  scenarios.scenario('rejects bad usage before touching anything', async () => {
    const base = ['--worktree', sandbox, '--comment-file', join(sandbox, 'comment.md')];
    const usage = async (...args: string[]) => {
      try {
        await run(args);
      } catch (error) {
        return error;
      }
      return undefined;
    };
    expect(await usage('--pr', 'x', ...base)).toBeInstanceOf(UsageError);
    expect(await usage('--pr', '1', '--worktree', sandbox)).toBeInstanceOf(UsageError);
    expect(await usage('--pr', '1', ...base, '--issue', 'COR-1')).toBeInstanceOf(UsageError);
    expect(
      await usage(
        '--pr',
        '1',
        ...base,
        '--issue',
        'COR-1',
        '--issue',
        'COR-2',
        '--completion-file',
        'a.md',
      ),
    ).toBeInstanceOf(UsageError);
    // The old spelling is gone: removal is the default, and `--keep-worktree` opts out.
    expect(await usage('--pr', '1', ...base, '--remove-worktree')).toBeInstanceOf(UsageError);
    expect(await usage('--pr', '1', ...base, '--name', 'x')).toBeInstanceOf(UsageError);
    expect(await usage('--pr', '1', ...base, '--provider', 'claude')).toBeInstanceOf(UsageError);
    expect(await usage('--pr', '1', ...base, '--bogus')).toBeInstanceOf(UsageError);
    // A pull request and a branch are exclusive, and one of them is required.
    expect(await usage('--worktree', sandbox)).toBeInstanceOf(UsageError);
    expect(
      await usage('--pr', '1', '--branch', 'work', '--head', HEAD, ...base, '--message-file', 'm'),
    ).toBeInstanceOf(UsageError);
    expect(await usage('--pr', '1', ...base, '--usage-log', 'u.tsv')).toBeInstanceOf(UsageError);
    expect(await usage('--pr', '1', ...base, '--transcript', 't.jsonl')).toBeInstanceOf(UsageError);
    expect(await usage('--pr', '1', ...base, '--head', 'abc')).toBeInstanceOf(UsageError);
    // The gate, its retry and the waivers are gone: their flags are unknown options now.
    for (const removed of ['--gate-log', '--max-attempts', '--removed-names', '--log-dir'])
      expect(await usage('--pr', '1', ...base, removed, 'x')).toBeInstanceOf(UsageError);
    expect(await usage('--pr', '1', ...base, '--health-file')).toBeInstanceOf(UsageError);
  });

  scenarios.scenario('--head, --fixes-main and the spend flags reach the merge gate', async () => {
    const { partial, record } = seams();
    const result = await run(
      argv(['--head', HEAD, '--fixes-main', '--usage-log', '/tmp/u.tsv', '--transcript', '/a']),
      partial,
    );
    expect(result.code).toBe(0);
    expect(record.merges[0]).toMatchObject({
      expectedHead: HEAD,
      fixesMain: true,
      usageLog: '/tmp/u.tsv',
      transcripts: ['/a'],
    });
  });

  scenarios.scenario('CLI closes only the tracked members in its approved request', async () => {
    const { partial, record } = seams();
    options = await approvedMembers(options, ['COR-9', 'COR-10'], ['COR-9', 'COR-10']);
    const result = await run(argv(['--json']), partial);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.output).issues).toEqual([
      { identifier: 'COR-9', state: 'Done' },
      { identifier: 'COR-10', state: 'Done' },
    ]);
    expect(record.writes).toEqual([
      'comment COR-9',
      'state COR-9',
      'comment COR-10',
      'state COR-10',
    ]);
  });

  scenarios.scenario(
    'exits 0 with one JSON object for a merge and 1 naming the failed step otherwise',
    async () => {
      const ok = await run(argv(['--json']), seams().partial);
      expect(ok.code).toBe(0);
      expect(JSON.parse(ok.output)).toMatchObject({ pr: 12, merged: true, failedStep: null });
      options = await approvedMembers(options, []);
      const bad = await run(
        argv(['--json']),
        seams({ merge: refusal('conflict', 'conflicts') }).partial,
      );
      expect(bad.code).toBe(1);
      expect(JSON.parse(bad.output).failedStep).toBe('conflict');
    },
  );
});

const BRANCH = 'cor-9-widgets';
const BASE_TREE = '2'.repeat(40);
const SQUASH = 'e'.repeat(40);
const NEW_BLOB = '5'.repeat(40);
const OLD_BLOB = '6'.repeat(40);
const OLDER_BLOB = '7'.repeat(40);
const EARLIER = '8'.repeat(40);

const reply = (stdout = '', code = 0, stderr = ''): RunnerResult => ({ code, stdout, stderr });

/** A fake `git` that answers a clean branch merge, with `answers` overriding single commands. */
function branchWorld(answers: Record<string, RunnerResult> = {}) {
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
    return answers[key] ?? defaults[key] ?? reply('', 1, `unexpected command: ${key}`);
  };
  return { runner, calls, messageFile };
}

const guardsPass = (): GuardsResult => ({ ok: true, failures: [] });
const guardsFail = (
  guard: string,
  findings: string[] = [`${guard} - found a problem`],
): GuardsResult => ({
  ok: false,
  failures: [{ guard, findings, output: findings.join(' | ') }],
});

/** `deliver --branch` with the real direct merge over a fake `git`, and the guards injected. */
async function deliverBranch(
  world: ReturnType<typeof branchWorld>,
  guards: (revision: string, only?: readonly string[]) => GuardsResult = guardsPass,
  extra: Partial<DeliverOptions> = {},
  usage: { usage?: () => UsageTotals; now?: () => Date } = {},
) {
  writeFileSync(world.messageFile, 'COR-9: Add widgets\n');
  const { partial, record } = seams();
  const branchApproval =
    extra.verification === undefined
      ? await approvedMembers({}, [], [], 'branch')
      : { verification: extra.verification };
  const report = await deliver(
    {
      configPath: options.configPath,
      branch: BRANCH,
      expectedHead: HEAD,
      run: 'run',
      project: 'Widgets',
      messageFile: world.messageFile,
      worktree: sandbox,
      verification: branchApproval.verification,
      ...extra,
    },
    {
      ...partial,
      directMerge: async (directOptions) =>
        directMerge(directOptions, { runner: world.runner, guards, verification, ...usage }),
    },
  );
  return {
    report,
    record,
    operationId: readDeliveryRequest(
      branchApproval.verification.file,
      branchApproval.verification.digest,
    ).operationId,
  };
}

scenarios.describe('deliver --branch', () => {
  scenarios.scenario(
    'squashes the branch into main with one commit, pushes it, then deletes the branch',
    async () => {
      const world = branchWorld();
      const revisions: string[] = [];
      const { report, record } = await deliverBranch(world, (revision) => {
        revisions.push(revision);
        return guardsPass();
      });
      expect(report).toMatchObject({
        pr: null,
        branch: BRANCH,
        merged: true,
        mergeCommit: SQUASH,
        failedStep: null,
        leftOpen: [],
        acceptedReverts: [],
        issues: [],
      });
      expect(record.merges).toEqual([]);
      // The guards ran on the commit that was pushed, and nothing touched a working tree.
      expect(revisions).toEqual([SQUASH]);
      const writes = world.calls.filter((call) => /^(push|commit-tree)/.test(call));
      expect(writes).toEqual([
        `commit-tree ${TREE} -p ${BASE} -F ${world.messageFile}`,
        `push origin ${SQUASH}:refs/heads/main`,
        `push origin --delete ${BRANCH} --force-with-lease=refs/heads/${BRANCH}:${HEAD}`,
      ]);
      expect(world.calls.some((call) => /^(checkout|merge |reset|worktree|stash)/.test(call))).toBe(
        false,
      );
      expect(renderDeliver(report)).toStartWith(
        `branch ${BRANCH} merged=true mergeCommit=eeeeeeeeeeee`,
      );
    },
  );

  scenarios.scenario(
    'a branch that is not the pinned head is refused at head, with nothing written',
    async () => {
      const world = branchWorld({
        [`rev-parse --verify refs/remotes/origin/${BRANCH}^{commit}`]: reply(`${'9'.repeat(40)}\n`),
      });
      const { report } = await deliverBranch(world);
      expect(report).toMatchObject({ merged: false, failedStep: 'head' });
      expect(report.detail).toContain('not the head pinned at acceptance');
      expect(world.calls.some((call) => call.startsWith('push'))).toBe(false);
    },
  );

  scenarios.scenario('a failed fetch is named at head', async () => {
    const world = branchWorld({ [`fetch origin main ${BRANCH}`]: reply('', 128, 'no such ref') });
    const { report } = await deliverBranch(world);
    expect(report).toMatchObject({ merged: false, failedStep: 'head' });
  });

  scenarios.scenario(
    'a file set back to the state before a recent commit is refused at revert',
    async () => {
      const world = branchWorld({
        [`rev-parse -q --verify ${EARLIER}^:a.ts`]: reply(`${NEW_BLOB}\n`),
        [`log -1 --format=%h %s ${EARLIER}`]: reply('abc1234 Add the widget\n'),
      });
      const { report } = await deliverBranch(world);
      expect(report).toMatchObject({ merged: false, failedStep: 'revert' });
      expect(report.detail).toContain('a.ts undoes abc1234 Add the widget');
      expect(world.calls.some((call) => call.startsWith('merge-tree'))).toBe(false);
    },
  );

  const undoneFile = () =>
    branchWorld({
      [`rev-parse -q --verify ${EARLIER}^:a.ts`]: reply(`${NEW_BLOB}\n`),
      [`log -1 --format=%h %s ${EARLIER}`]: reply('abc1234 Add the widget\n'),
    });

  scenarios.scenario(
    '--intended accepts the revert finding for the path it names and the merge goes on',
    async () => {
      const { report } = await deliverBranch(undoneFile(), guardsPass, { intended: ['a.ts'] });
      expect(report).toMatchObject({
        merged: true,
        failedStep: null,
        acceptedReverts: ['a.ts undoes abc1234 Add the widget'],
      });
      expect(renderDeliver(report)).toContain('revert accepted as intended: a.ts undoes abc1234');
    },
  );

  scenarios.scenario(
    '--intended for another path still fails on the finding, and a path with no finding is an error',
    async () => {
      const other = await deliverBranch(undoneFile(), guardsPass, { intended: ['b.ts'] });
      expect(other.report).toMatchObject({ merged: false, failedStep: 'revert' });
      expect(other.report.detail).toContain('a.ts undoes');
      const stale = await deliverBranch(branchWorld(), guardsPass, { intended: ['a.ts'] });
      expect(stale.report).toMatchObject({ merged: false, failedStep: 'revert' });
      expect(stale.report.detail).toContain('--intended a.ts names no revert finding');
    },
  );

  scenarios.scenario('--intended is refused with --pr, before anything runs', async () => {
    const { partial, record } = seams();
    const error = await rejectionOf(deliver({ ...options, intended: ['a.ts'] }, partial));
    expect(error).toBeInstanceOf(UsageError);
    expect(record.merges).toEqual([]);
  });

  scenarios.scenario(
    'a conflict with main is refused at conflict, with no commit made',
    async () => {
      const world = branchWorld({
        [`merge-tree --write-tree ${BASE} ${HEAD}`]: reply(`${TREE}\nCONFLICT\n`, 1),
      });
      const { report } = await deliverBranch(world);
      expect(report).toMatchObject({ merged: false, failedStep: 'conflict' });
      expect(world.calls.some((call) => /^(commit-tree|push)/.test(call))).toBe(false);
    },
  );

  scenarios.scenario(
    'a branch that changes nothing is refused rather than pushed as an empty commit',
    async () => {
      const world = branchWorld({
        [`merge-tree --write-tree ${BASE} ${HEAD}`]: reply(`${BASE_TREE}\n`),
      });
      const { report } = await deliverBranch(world);
      expect(report).toMatchObject({ merged: false, failedStep: 'merge' });
      expect(report.detail).toContain('changes nothing');
    },
  );

  scenarios.scenario(
    'a guard that fails on the merged tree and passes on main is refused at guards, with nothing pushed',
    async () => {
      const world = branchWorld();
      const { report, record } = await deliverBranch(
        world,
        (revision) =>
          revision === BASE ? guardsPass() : guardsFail('check-middle-dot-separators'),
        await approvedMembers({}, ['COR-9'], [], 'branch'),
      );
      expect(report).toMatchObject({
        merged: false,
        failedStep: 'guards',
        guardsAlreadyFailing: [],
      });
      expect(report.detail).toContain('check-middle-dot-separators');
      expect(world.calls.some((call) => call.startsWith('push'))).toBe(false);
      expect(record.requests).toEqual([]);
    },
  );

  scenarios.scenario(
    'a guard failure refuses the merge only for a finding main does not have, with no declaration',
    async () => {
      const WAIT = 'check-wait-for-element-assertions';
      const onBranch = guardsFail(WAIT, ['a.test.ts:1 - absence']);
      const failing = (branch: GuardsResult, onBase: GuardsResult) => (revision: string) =>
        revision === BASE ? onBase : branch;
      const deliverFailing = (branch: GuardsResult, onBase: GuardsResult) =>
        deliverBranch(branchWorld(), failing(branch, onBase));

      // Every finding is main's own: merged, and reported as already failing on main, never silently.
      const inherited = await deliverFailing(
        onBranch,
        guardsFail(WAIT, ['a.test.ts:1 - absence', 'b.test.ts:2 - identity']),
      );
      expect(inherited.report).toMatchObject({
        merged: true,
        failedStep: null,
        guardsAlreadyFailing: [{ guard: WAIT, findings: 1 }],
      });
      expect(renderDeliver(inherited.report)).toContain(
        `WARNING guards: already failing on main, with no finding of this change's own: ${WAIT} (1 output lines)`,
      );

      // Same guard, but a finding main does not have: the change's own, refused.
      const newFinding = await deliverFailing(
        onBranch,
        guardsFail(WAIT, ['c.test.ts:3 - absence']),
      );
      expect(newFinding.report).toMatchObject({ merged: false, failedStep: 'guards' });
      // A different guard failing on main, by name alone, is no baseline.
      const otherGuard = await deliverFailing(onBranch, guardsFail('check-runtime-detection'));
      expect(otherGuard.report).toMatchObject({ merged: false, failedStep: 'guards' });
      expect(otherGuard.report.detail).toContain(WAIT);
      // Main passing the guard is no baseline.
      const clean = await deliverFailing(onBranch, guardsPass());
      expect(clean.report).toMatchObject({ merged: false, failedStep: 'guards' });
      // A failure with no findings cannot be matched against anything.
      const silent = await deliverFailing(guardsFail(WAIT, []), guardsFail(WAIT, []));
      expect(silent.report).toMatchObject({ merged: false, failedStep: 'guards' });
      // A second failing guard that main does not fail is the change's own, beside an inherited one.
      const both: GuardsResult = {
        ok: false,
        failures: [
          ...onBranch.failures,
          { guard: 'check-middle-dot-separators', findings: ['x:1 - dot'], output: 'x:1 - dot' },
        ],
      };
      const mixed = await deliverFailing(both, guardsFail(WAIT, ['a.test.ts:1 - absence']));
      expect(mixed.report).toMatchObject({ merged: false, failedStep: 'guards' });
      expect(mixed.report.detail).toContain(WAIT);
      expect(mixed.report.detail).toContain('check-middle-dot-separators');
      // Two inherited guards are both reported.
      const two: GuardsResult = {
        ok: false,
        failures: [
          ...onBranch.failures,
          ...guardsFail('check-runtime-detection', ['r:1 - x']).failures,
        ],
      };
      const bothInherited = await deliverFailing(two, two);
      expect(bothInherited.report.guardsAlreadyFailing).toEqual([
        { guard: WAIT, findings: 1 },
        { guard: 'check-runtime-detection', findings: 1 },
      ]);

      // The base run is limited to the guards that failed on the merged tree.
      const asked: (readonly string[] | undefined)[] = [];
      await deliverBranch(branchWorld(), (revision, only) => {
        if (revision === BASE) asked.push(only);
        return onBranch;
      });
      expect(asked).toEqual([[WAIT]]);
      // A tree whose guards all pass never runs them on main.
      const revisions: string[] = [];
      await deliverBranch(branchWorld(), (revision) => {
        revisions.push(revision);
        return guardsPass();
      });
      expect(revisions).toEqual([SQUASH]);
    },
  );

  scenarios.scenario(
    '--fixes-main is for a pull request: a branch merge refuses it before anything runs',
    async () => {
      const world = branchWorld();
      const error = await rejectionOf(deliverBranch(world, guardsPass, { fixesMain: true }));
      expect(error).toBeInstanceOf(UsageError);
      expect(String(error)).toContain('--fixes-main applies only with --pr');
      expect(world.calls).toEqual([]);
    },
  );

  scenarios.scenario(
    'a rejected push changes nothing: the branch is kept and no issue is closed',
    async () => {
      const world = branchWorld({
        [`push origin ${SQUASH}:refs/heads/main`]: reply('', 1, '! [rejected] (fetch first)'),
      });
      const { report, record } = await deliverBranch(
        world,
        guardsPass,
        await approvedMembers({}, ['COR-9'], [], 'branch'),
      );
      expect(report).toMatchObject({ merged: false, mergeCommit: null, failedStep: 'merge' });
      expect(report.detail).toContain('rejected');
      expect(world.calls).not.toContain(
        `push origin --delete ${BRANCH} --force-with-lease=refs/heads/${BRANCH}:${HEAD}`,
      );
      expect(record.requests).toEqual([]);
    },
  );

  scenarios.scenario(
    'a branch that cannot be deleted is step delete with merged true, and no issue is closed',
    async () => {
      const world = branchWorld({
        [`push origin --delete ${BRANCH} --force-with-lease=refs/heads/${BRANCH}:${HEAD}`]: reply(
          '',
          1,
          'denied',
        ),
      });
      const approved = await approvedMembers({}, ['COR-9'], [], 'branch');
      const { report, record } = await deliverBranch(world, guardsPass, approved);
      expect(report).toMatchObject({ merged: true, mergeCommit: SQUASH, failedStep: 'delete' });
      expect(record.requests).toEqual([]);
      // The merge happened, so its head is in the ledger although a later step failed.
      expect(record.ledger).toEqual([
        {
          pr: undefined,
          branch: BRANCH,
          head: HEAD,
          mergeCommit: SQUASH,
          operationId: readDeliveryRequest(approved.verification.file, approved.verification.digest)
            .operationId,
        },
      ]);
    },
  );

  scenarios.scenario(
    'a branch merge without --closes comments on the issue and leaves its state alone',
    async () => {
      const { report, record } = await deliverBranch(
        branchWorld(),
        guardsPass,
        await approvedMembers({}, ['COR-9'], [], 'branch'),
      );
      expect(report).toMatchObject({
        merged: true,
        failedStep: null,
        leftOpen: ['COR-9'],
        issues: [],
      });
      expect(record.writes).toEqual(['comment COR-9']);
      expect(renderDeliver(report).split('\n').at(-1)).toContain(
        'left open, state untouched: COR-9',
      );
    },
  );

  scenarios.scenario(
    'closes the issues after the merge, pairing each with its completion file in order',
    async () => {
      const { report, record } = await deliverBranch(
        branchWorld(),
        guardsPass,
        await approvedMembers({}, ['COR-9', 'COR-10'], ['COR-9', 'COR-10'], 'branch'),
      );
      expect(report).toMatchObject({
        merged: true,
        failedStep: null,
        issues: [
          { identifier: 'COR-9', state: 'Done' },
          { identifier: 'COR-10', state: 'Done' },
        ],
      });
      expect(record.writes).toEqual([
        'comment COR-9',
        'state COR-9',
        'comment COR-10',
        'state COR-10',
      ]);
      expect(record.removals).toEqual([sandbox]);
    },
  );

  scenarios.scenario('an unsafe branch or a bad head is refused before anything runs', async () => {
    const world = branchWorld();
    const refused = async (extra: Partial<DeliverOptions>) => {
      const error = await rejectionOf(deliverBranch(world, guardsPass, extra));
      expect(error).toBeInstanceOf(UsageError);
      return String(error);
    };
    expect(await refused({ branch: 'main' })).toContain('default branch');
    expect(await refused({ branch: '--delete' })).toContain('not a safe branch name');
    expect(await refused({ branch: 'a..b' })).toContain('not a safe branch name');
    expect(await refused({ expectedHead: 'abc' })).toContain('not a full commit SHA');
    expect(world.calls).toEqual([]);
  });

  scenarios.scenario(
    'exactly one of a pull request and a branch, each with its own file, is required',
    async () => {
      const { partial } = seams();
      const refused = async (extra: Partial<DeliverOptions>) => {
        const error = await rejectionOf(
          deliver(
            {
              configPath: options.configPath,
              worktree: sandbox,
              run: 'run',
              project: 'Widgets',
              verification: options.verification,
              ...extra,
            },
            partial,
          ),
        );
        expect(error).toBeInstanceOf(UsageError);
        return String(error);
      };
      const message = join(sandbox, 'comment.md');
      expect(await refused({})).toContain('exactly one of --pr and --branch');
      expect(
        await refused({ pr: 1, branch: BRANCH, expectedHead: HEAD, messageFile: message }),
      ).toContain('exactly one of --pr and --branch');
      expect(await refused({ pr: 1 })).toContain('--pr needs --comment-file');
      expect(await refused({ pr: 1, commentFile: message, messageFile: message })).toContain(
        '--message-file applies only with --branch',
      );
      expect(await refused({ branch: BRANCH, expectedHead: HEAD })).toContain(
        'needs --message-file',
      );
      expect(await refused({ branch: BRANCH, messageFile: message })).toContain('needs --head');
      expect(
        await refused({
          branch: BRANCH,
          expectedHead: HEAD,
          messageFile: message,
          commentFile: message,
        }),
      ).toContain('--comment-file applies only with --pr');
    },
  );

  scenarios.scenario('no direct merge runner is a named failure, never a silent skip', async () => {
    const approved = await approvedMembers({}, [], [], 'branch');
    const report = await deliver(
      {
        configPath: options.configPath,
        branch: BRANCH,
        expectedHead: HEAD,
        messageFile: join(sandbox, 'comment.md'),
        run: 'run',
        project: 'Widgets',
        worktree: sandbox,
        verification: approved.verification,
      },
      { verification, readLease: async () => ({ run: 'run', live: true }) },
    );
    expect(report).toMatchObject({ merged: false, failedStep: 'merge' });
  });

  scenarios.scenario(
    'records the spend with branch:<name> where a pull request number would go',
    async () => {
      const usageLog = join(sandbox, 'out', 'usage.tsv');
      const { report } = await deliverBranch(
        branchWorld(),
        guardsPass,
        { usageLog, transcripts: [join(sandbox, 'comment.md')] },
        {
          usage: () => ({ input: 1, cachedInput: 2, output: 3 }),
          now: () => new Date('2026-11-11T12:00:00.000Z'),
        },
      );
      expect(report).toMatchObject({ merged: true, failedStep: null });
      expect(readFileSync(usageLog, 'utf8')).toBe(
        `2026-11-11T12:00:00.000Z\tbranch:${BRANCH}\t${SQUASH}\t1\t2\t3\n`,
      );
    },
  );

  scenarios.scenario(
    'run reads --branch, --head and --message-file and reports the branch as JSON',
    async () => {
      const seen: DirectMergeOptions[] = [];
      options = await approvedMembers(options, [], [], 'branch');
      const collaborators = seams().partial;
      const result = await run(
        [
          '--config',
          options.configPath,
          '--branch',
          BRANCH,
          '--head',
          HEAD,
          '--worktree',
          sandbox,
          '--message-file',
          join(sandbox, 'comment.md'),
          '--verification-file',
          options.verification.file,
          '--verification-digest',
          options.verification.digest,
          '--run',
          'run',
          '--project',
          'Widgets',
          '--json',
        ],
        {
          ...collaborators,
          directMerge: async (directOptions) => {
            seen.push(directOptions);
            await recordDeliveryMergeObservation(
              loadDeliveryVerification(directOptions.verification, verification),
              {
                route: 'branch',
                branch: BRANCH,
                reviewedHead: HEAD,
                base: BASE,
                integrationTree: TREE,
                mergeCommit: SQUASH,
                state: 'confirmed-merge',
              },
              'observed',
              verification,
            );
            return {
              branch: BRANCH,
              head: HEAD,
              base: BASE,
              merged: true,
              mergeCommit: SQUASH,
              failedStep: null,
              detail: null,
            };
          },
        },
      );
      expect(result.code).toBe(0);
      expect(JSON.parse(result.output)).toMatchObject({ pr: null, branch: BRANCH, merged: true });
      expect(seen[0]).toMatchObject({ branch: BRANCH, head: HEAD });
    },
  );

  scenarios.scenario(
    'run resolves a relative --message-file against its own directory, not the worktree',
    async () => {
      const seen: DirectMergeOptions[] = [];
      options = await approvedMembers(options, [], [], 'branch');
      const collaborators = seams().partial;
      const result = await run(
        [
          '--config',
          options.configPath,
          '--branch',
          BRANCH,
          '--head',
          HEAD,
          '--worktree',
          sandbox,
          '--message-file',
          relative(process.cwd(), join(sandbox, 'comment.md')),
          '--verification-file',
          options.verification.file,
          '--verification-digest',
          options.verification.digest,
          '--run',
          'run',
          '--project',
          'Widgets',
          '--json',
        ],
        {
          ...collaborators,
          directMerge: async (directOptions) => {
            seen.push(directOptions);
            await recordDeliveryMergeObservation(
              loadDeliveryVerification(directOptions.verification, verification),
              {
                route: 'branch',
                branch: BRANCH,
                reviewedHead: HEAD,
                base: BASE,
                integrationTree: TREE,
                mergeCommit: SQUASH,
                state: 'confirmed-merge',
              },
              'observed',
              verification,
            );
            return {
              branch: BRANCH,
              head: HEAD,
              base: BASE,
              merged: true,
              mergeCommit: SQUASH,
              failedStep: null,
              detail: null,
            };
          },
        },
      );
      expect(result.code).toBe(0);
      expect(seen[0]?.messageFile).toBe(join(sandbox, 'comment.md'));
    },
  );
});

// Landing refuses without evidence (`landing-evidence.ts`, the lease in `deliver.ts`). Each case
// starts from the green landing and varies the one input its check reads.
interface Landing {
  /** Answers over the green defaults, keyed by a command's arguments without its program. */
  answers?: Record<string, RunnerResult>;
  /** Overrides the run the CI evidence provider finds. */
  providerRun?: Record<string, unknown>;
  handler?: (command: string[]) => RunnerResult | undefined;
  lease?: LeaseReading | null;
  /** Verdict file text, written beside the execution state for the head. */
  verdicts?: string;
  /** How the request pins its CI evidence (a manual dispatch, whose pin may be stale). */
  identity?: { dispatch?: boolean; stale?: boolean; none?: boolean };
}

/** `deliver --branch` over a fake git, gh and Linear, with the green landing varied by `landing`. */
async function landBranch(landing: Landing = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'deliver-landing-'));
  const controlDirectory = mkdtempSync(join(tmpdir(), 'deliver-landing-control-'));
  try {
    const configPath = join(controlDirectory, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        repository: 'acme/widgets',
        defaultBranch: 'main',
        worktreeRoots: { claude: '/c', codex: '/x' },
        manifestName: 'widgets',
        installCommand: 'install-command',
        gateCommand: 'true',
        affectedCheckCommand: 'true',
        mergeMethod: 'squash',
      }),
    );
    const world = landingRunner(directory, landing.answers, landing.handler);
    writeFileSync(world.messageFile, 'COR-9: Add widgets\n');
    const fixture = await createDeliveryFixture(
      controlDirectory,
      directory,
      'branch',
      landing.identity,
    );
    if (landing.verdicts !== undefined) {
      const path = designVerdictPath(fixture.binding.stateDirectory ?? '', HEAD);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, landing.verdicts);
    }
    const landed = {
      ...fixture.dependencies,
      ...(landing.providerRun === undefined
        ? {}
        : {
            ciProvider: landingProvider(
              { repository: 'acme/widgets', base: BASE, revision: HEAD, integrationTree: TREE },
              landing.providerRun,
            ),
          }),
    };
    const report = await deliver(
      {
        configPath,
        branch: BRANCH,
        expectedHead: HEAD,
        messageFile: world.messageFile,
        worktree: directory,
        run: 'run',
        project: 'Widgets',
        verification: fixture.binding,
      },
      {
        directMerge: async (directOptions) =>
          directMerge(directOptions, {
            runner: world.runner,
            guards: guardsPass,
            verification: landed,
          }),
        verification: landed,
        readLease: async () =>
          landing.lease === undefined ? { run: 'run', live: true } : landing.lease,
        remove: () => ({ path: '/c/alpha', branch: 'b', remoteDeleted: true, ended: [] }),
        record: () => {},
        client: {
          request: async () => {
            throw new Error('no Linear request is expected');
          },
        },
      },
    );
    // The command line's own mapping: 0 when nothing failed, 1 when a step did.
    return { report, code: report.failedStep === null ? 0 : 1, calls: world.calls };
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(controlDirectory, { recursive: true, force: true });
  }
}

const UI_PATH = 'applications/interborough/src/routes/agents/agents-page.svelte';
const DOOR = {
  rule: 'wire golden: a wire protocol or published-spec snapshot',
  path: 'packages/bureau/src/http/__fixtures__/wire-golden/local.openrpc.json',
};
const noPush = (calls: string[]) => !calls.some((call) => call.startsWith('push'));

scenarios.describe('deliver --branch refuses to land without evidence', () => {
  scenarios.scenario(
    'a head with green runs, its pinned digest, a covered plan and the lease lands',
    async () => {
      const { report, code } = await landBranch();
      expect(report).toMatchObject({ failedStep: null, merged: true });
      expect(code).toBe(0);
    },
  );

  scenarios.scenario('no runs on the head', async () => {
    const { report, code, calls } = await landBranch({
      answers: runsAnswer('acme/widgets', HEAD, []),
    });
    expect(report).toMatchObject({ merged: false, failedStep: 'verification' });
    expect(report.detail).toContain('no workflow runs exist on the head');
    expect(code).toBe(1);
    expect(noPush(calls)).toBe(true);
  });

  scenarios.scenario('runs on a different SHA', async () => {
    const other = '9'.repeat(40);
    const { report, code } = await landBranch({
      answers: runsAnswer('acme/widgets', HEAD, [{ head_sha: other }]),
    });
    expect(report).toMatchObject({ merged: false, failedStep: 'verification' });
    expect(report.detail).toContain(`is on ${other}, not the head`);
    expect(code).toBe(1);
  });

  scenarios.scenario('a digest that is not the pinned one', async () => {
    const { report, code } = await landBranch({
      providerRun: { verificationPlanDigest: '0'.repeat(64) },
    });
    expect(report).toMatchObject({ merged: false, failedStep: 'verification' });
    expect(report.detail).toContain('carries evidence digest');
    expect(code).toBe(1);
  });

  scenarios.scenario('a red run with a failure main does not have', async () => {
    const { report, code } = await landBranch({
      answers: runsAnswer('acme/widgets', HEAD, [{ head_sha: HEAD, conclusion: 'failure' }]),
      handler: (command) => {
        if (command[1] !== 'run') return undefined;
        if (command[2] === 'list') return reply('[]');
        if (command.includes('--log-failed')) return reply('');
        return reply(
          JSON.stringify({
            status: 'completed',
            conclusion: 'failure',
            jobs: [{ name: 'Root checks', conclusion: 'failure' }],
          }),
        );
      },
    });
    expect(report).toMatchObject({ merged: false, failedStep: 'verification' });
    expect(report.detail).toContain('is red with failures main does not have: Root checks');
    expect(code).toBe(1);
  });

  scenarios.scenario('an interface path with no design verdict', async () => {
    const { report, code } = await landBranch({
      answers: changedAnswer(BASE, HEAD, [UI_PATH]),
    });
    expect(report).toMatchObject({ merged: false, failedStep: 'verification' });
    expect(report.detail).toContain('records no design verdict for the head');
    expect(code).toBe(1);
  });

  scenarios.scenario(
    'an interface path lands with a verdict whose rows all pass, and not with a failing row',
    async () => {
      const answers = changedAnswer(BASE, HEAD, [UI_PATH]);
      const passing = await landBranch({
        answers,
        verdicts: '11a | matches |\n11b | deferred | the issue defers it to COR-9\n',
      });
      expect(passing.report).toMatchObject({ failedStep: null, merged: true });
      const failing = await landBranch({
        answers,
        verdicts: '11a | matches |\n11b | drifted | the card is 1950px wide\n',
      });
      expect(failing.report).toMatchObject({ merged: false, failedStep: 'verification' });
      expect(failing.report.detail).toContain('failing rows: 11b: drifted');
      expect(failing.code).toBe(1);
    },
  );

  scenarios.scenario(
    'a one-way door through a branch merge, which has no pull request',
    async () => {
      const { report, code } = await landBranch({
        answers: changedAnswer(BASE, HEAD, [DOOR.path]),
      });
      expect(report).toMatchObject({ merged: false, failedStep: 'verification' });
      expect(report.detail).toContain('one-way door');
      expect(report.detail).toContain('must go through a pull request');
      expect(code).toBe(1);
    },
  );

  scenarios.scenario(
    'deleting a wire golden is a one-way door: the door check reads every status',
    async () => {
      const { report, code } = await landBranch({
        // The deleted path appears only in the unfiltered diff; a `--diff-filter=d` read sees nothing.
        handler: (command) =>
          command.includes('--diff-filter=d') ||
          command.some((word) => word.startsWith('--diff-filter'))
            ? reply('')
            : undefined,
        answers: changedAnswer(BASE, HEAD, [DOOR.path]),
      });
      expect(report).toMatchObject({ merged: false, failedStep: 'verification' });
      expect(report.detail).toContain('must go through a pull request');
      expect(code).toBe(1);
    },
  );

  scenarios.scenario(
    'a head whose evidence-plan.ts prints an empty plan still refuses: nothing of the checkout runs',
    async () => {
      const { report, calls } = await landBranch({
        answers: changedAnswer(BASE, HEAD, [DOOR.path]),
        handler: (command) =>
          command[0] === 'bun'
            ? reply(JSON.stringify({ changed: [], requires_full_run: false, full_run_rules: [] }))
            : undefined,
      });
      expect(report).toMatchObject({ merged: false, failedStep: 'verification' });
      expect(report.detail).toContain('one-way door');
      expect(
        calls.some((call) => call.includes('evidence-plan') || call.startsWith('scripts/')),
      ).toBe(false);
    },
  );

  const TOKEN_PATH = 'components/cinder/src/tokens/sets/colors.tokens.json';
  const passingVerdicts = '11a | matches |\n';

  scenarios.scenario('a whole-suite change widens the run and is no one-way door', async () => {
    const { report } = await landBranch({
      answers: changedAnswer(BASE, HEAD, [TOKEN_PATH]),
      verdicts: passingVerdicts,
    });
    expect(report).toMatchObject({ failedStep: null, merged: true });
  });

  scenarios.scenario(
    'a plan that needs the full run is not covered by a pull request run alone',
    async () => {
      const { report } = await landBranch({
        answers: {
          ...runsAnswer('acme/widgets', HEAD, [
            { head_sha: HEAD, path: '.github/workflows/pull-request.yml' },
          ]),
          ...changedAnswer(BASE, HEAD, [TOKEN_PATH]),
        },
        verdicts: passingVerdicts,
      });
      expect(report).toMatchObject({ merged: false, failedStep: 'verification' });
      expect(report.detail).toContain('requires a full main.yml run');
    },
  );

  /** A red `main.yml` run (4242) whose one failed job `main` also fails, per `main`'s own run 99. */
  const knownRed = (command: string[]): RunnerResult | undefined => {
    if (command[1] !== 'run') return undefined;
    if (command[2] === 'list') return reply('[{"databaseId":99,"conclusion":"failure"}]');
    if (command.includes('--log-failed')) return reply('');
    return reply(
      JSON.stringify({
        status: 'completed',
        conclusion: 'failure',
        jobs: [{ name: 'Root checks', conclusion: 'failure' }],
      }),
    );
  };

  scenarios.scenario(
    'a red main.yml run with failures main has does not satisfy a plan that needs the full run',
    async () => {
      const { report, code } = await landBranch({
        answers: {
          ...runsAnswer('acme/widgets', HEAD, [{ head_sha: HEAD, conclusion: 'failure' }]),
          ...changedAnswer(BASE, HEAD, [TOKEN_PATH]),
        },
        handler: knownRed,
        verdicts: passingVerdicts,
      });
      expect(report).toMatchObject({ merged: false, failedStep: 'verification' });
      expect(report.detail).toContain('requires a full main.yml run');
      expect(code).toBe(1);
    },
  );

  scenarios.scenario(
    'a red run covers nothing alone, and may stand beside a green covering run',
    async () => {
      const alone = await landBranch({
        answers: runsAnswer('acme/widgets', HEAD, [{ head_sha: HEAD, conclusion: 'failure' }]),
        handler: knownRed,
      });
      expect(alone.report).toMatchObject({ merged: false, failedStep: 'verification' });
      expect(alone.report.detail).toContain('no green run covers the head');
      const beside = await landBranch({
        answers: {
          ...runsAnswer('acme/widgets', HEAD, [
            { head_sha: HEAD, conclusion: 'failure' },
            { head_sha: HEAD, id: 5, path: '.github/workflows/pull-request.yml' },
          ]),
          ...jobsAnswer('acme/widgets', 5),
        },
        handler: knownRed,
      });
      expect(beside.report).toMatchObject({ failedStep: null, merged: true });
    },
  );

  scenarios.scenario('a green run with a failed job covers nothing', async () => {
    const { report } = await landBranch({
      answers: jobsAnswer('acme/widgets', 4242, 'failure'),
    });
    expect(report).toMatchObject({ merged: false, failedStep: 'verification' });
    expect(report.detail).toContain('concluded failure');
  });

  scenarios.scenario(
    'a targeted run covers a head only when its run name carries the plan digest',
    async () => {
      const digest = landingPlan(['a.ts']).digest;
      const targeted = (title: string) =>
        runsAnswer('acme/widgets', HEAD, [
          { head_sha: HEAD, path: '.github/workflows/targeted-checks.yml', display_title: title },
        ]);
      const matching = await landBranch({
        identity: { none: true },
        answers: targeted(targetedRunName(digest)),
      });
      expect(matching.report).toMatchObject({ failedStep: null, merged: true });
      const mismatched = await landBranch({
        identity: { none: true },
        answers: targeted(targetedRunName('0'.repeat(64))),
      });
      expect(mismatched.report).toMatchObject({ merged: false, failedStep: 'verification' });
      expect(mismatched.report.detail).toContain('no green run covers the head');
      // A plan that did not fit one dispatch goes to main.yml, or an explicit selection is
      // dispatched: neither passes `plan_digest`, so the run keeps its default name and covers nothing.
      const undigested = await landBranch({
        identity: { none: true },
        answers: targeted('Targeted checks'),
      });
      expect(undigested.report).toMatchObject({ merged: false, failedStep: 'verification' });
      expect(undigested.report.detail).toContain('no green run covers the head');
      const full = await landBranch({
        identity: { none: true },
        answers: {
          ...targeted(targetedRunName(landingPlan([TOKEN_PATH]).digest)),
          ...changedAnswer(BASE, HEAD, [TOKEN_PATH]),
        },
        verdicts: passingVerdicts,
      });
      expect(full.report.detail).toContain('requires a full main.yml run');
    },
  );

  scenarios.scenario(
    'a manual dispatch is pinned to the batch digest: a stale pin is refused, the batch digest lands',
    async () => {
      const stale = await landBranch({ identity: { dispatch: true, stale: true } });
      expect(stale.report).toMatchObject({ merged: false, failedStep: 'verification' });
      expect(stale.report.detail).toContain('carries evidence digest');
      const current = await landBranch({ identity: { dispatch: true } });
      expect(current.report).toMatchObject({ failedStep: null, merged: true });
    },
  );

  scenarios.scenario('a run that does not hold the lease', async () => {
    for (const lease of [{ run: 'other', live: true }, null, { run: 'run', live: false }]) {
      const { report, code, calls } = await landBranch({ lease });
      expect(report).toMatchObject({ merged: false, failedStep: 'lease' });
      expect(code).toBe(1);
      expect(noPush(calls)).toBe(true);
    }
  });

  scenarios.scenario('--run and --project are required on the command line', async () => {
    const argv = [
      '--branch',
      BRANCH,
      '--head',
      HEAD,
      '--worktree',
      tmpdir(),
      '--message-file',
      'm',
      '--verification-file',
      'v',
      '--verification-digest',
      'd',
    ];
    expect(await rejectionOf(run(argv, {}))).toBeInstanceOf(UsageError);
    expect(await rejectionOf(run([...argv, '--run', 'run'], {}))).toBeInstanceOf(UsageError);
  });
});

await scenarios.settled();
