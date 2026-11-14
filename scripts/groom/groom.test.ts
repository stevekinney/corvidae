import type { Decision, DecisionBatch, DecisionBatchResult } from '@lostgradient/operative';
import { describe, expect, test } from 'bun:test';
import { throwingRejectionOf } from '../../testing/testing/src/helpers/promise-outcome.ts';
import type { FetchLike } from '../chef/linear.ts';
import { UsageError } from '../chef/process-runner.ts';
import type { RepositoryView } from '../chef/triage.ts';
import { noThreshold, readinessQuestions, yesThreshold } from './groom-questions.ts';
import {
  commentMarker,
  groomComment,
  parseRecord,
  probabilityOfYes,
  read,
  run,
  type Workspace,
} from './groom.ts';

const READY_BODY = [
  '## Brief',
  '',
  'Add the groomer.',
  '',
  '## Acceptance criteria',
  '',
  '- AC1: `bun run check` exits 0.',
  '',
  '## Verification',
  '',
  '- `bun run check`',
  '',
  '## Delivery boundary',
  '',
  'A merged pull request.',
].join('\n');

interface FakeIssue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  priority: number;
  stateId: string;
  labelIds: string[];
  blockedBy: { identifier: string; stateType: string }[];
}

/** An in-memory Linear holding just what the groomer reads and writes. */
function fakeLinear(issues: FakeIssue[]) {
  const team = { id: 'team-cor', key: 'COR', parent: { id: 'team-eng' } };
  const states = [
    { id: 's-backlog', name: 'Backlog', team: { id: 'team-eng' } },
    { id: 's-ready', name: 'Ready', team: { id: 'team-eng' } },
    { id: 's-doing', name: 'In Progress', team: { id: 'team-eng' } },
  ];
  const labels = [
    { id: 'l-group', name: 'Work Type', isGroup: true, team: null, parent: null },
    { id: 'l-feature', name: 'type:feature', isGroup: false, team: null, parent: null },
    { id: 'l-bug', name: 'type:bug', isGroup: false, team: null, parent: null },
    { id: 'l-bureau', name: 'package:bureau', isGroup: false, team: null, parent: null },
    { id: 'l-weft', name: 'package:weft', isGroup: false, team: null, parent: null },
  ];
  const comments: { id: string; issueId: string; body: string; createdAt: string }[] = [];
  const operations: string[] = [];
  let counter = 0;
  const find = (id: unknown) =>
    issues.find((issue) => issue.id === id || issue.identifier === id) ?? null;
  const state = (issue: FakeIssue) => states.find((candidate) => candidate.id === issue.stateId)!;
  const groomView = (issue: FakeIssue) => ({
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    state: { name: state(issue).name },
    team,
    labels: {
      nodes: issue.labelIds.map((id) => ({ name: labels.find((label) => label.id === id)!.name })),
    },
  });

  function handle(operation: string, variables: Record<string, any>): unknown {
    switch (operation) {
      case 'GroomIssue':
        return { issue: find(variables['id']) === null ? null : groomView(find(variables['id'])!) };
      case 'GroomBacklog':
        return {
          issues: {
            nodes: issues.filter((issue) => issue.stateId === 's-backlog').map(groomView),
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
      case 'TeamLabels':
        return {
          issueLabels: { nodes: labels, pageInfo: { hasNextPage: false, endCursor: null } },
        };
      case 'IssueRead': {
        const issue = find(variables['id']);
        return {
          issue:
            issue === null
              ? null
              : {
                  ...groomView(issue),
                  updatedAt: '2026-11-12T00:00:00Z',
                  state: { id: issue.stateId, name: state(issue).name },
                },
        };
      }
      case 'IssueRelations': {
        const issue = find(variables['id'])!;
        return {
          issue: {
            id: issue.id,
            identifier: issue.identifier,
            relations: { nodes: [], pageInfo: { hasNextPage: false } },
            inverseRelations: {
              nodes: issue.blockedBy.map((blocker) => ({
                type: 'blocks',
                issue: {
                  identifier: blocker.identifier,
                  title: 'Blocker',
                  state: { name: blocker.stateType, type: blocker.stateType },
                },
              })),
              pageInfo: { hasNextPage: false },
            },
          },
        };
      }
      case 'IssueSetPriority':
        find(variables['id'])!.priority = variables['priority'];
        return { issueUpdate: { success: true } };
      case 'IssuePriority':
        return { issue: { priority: find(variables['id'])!.priority } };
      case 'IssueAddLabels': {
        const issue = find(variables['id'])!;
        issue.labelIds = [...new Set([...issue.labelIds, ...variables['labelIds']])];
        return { issueUpdate: { success: true } };
      }
      case 'IssueLabels':
        return {
          issue: { labels: { nodes: find(variables['id'])!.labelIds.map((id) => ({ id })) } },
        };
      case 'TeamStates':
        return { workflowStates: { nodes: states } };
      case 'IssueSetState':
        find(variables['id'])!.stateId = variables['stateId'];
        return { issueUpdate: { success: true } };
      case 'IssueComments': {
        const issue = find(variables['id'])!;
        return {
          issue: {
            comments: {
              nodes: comments.filter((comment) => comment.issueId === issue.id),
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        };
      }
      case 'CommentPost': {
        counter += 1;
        const comment = {
          id: `c-${counter}`,
          issueId: variables['issueId'],
          body: variables['body'],
          createdAt: `2026-11-12T00:00:${String(counter).padStart(2, '0')}Z`,
        };
        comments.push(comment);
        return { commentCreate: { success: true, comment: { id: comment.id } } };
      }
      case 'CommentRead': {
        const comment = comments.find((candidate) => candidate.id === variables['id']);
        return {
          comment:
            comment === undefined
              ? null
              : {
                  id: comment.id,
                  body: comment.body,
                  issue: { identifier: find(comment.issueId)!.identifier },
                },
        };
      }
      case 'CommentOwner': {
        const comment = comments.find((candidate) => candidate.id === variables['id']);
        return {
          viewer: { id: 'me' },
          comment:
            comment === undefined
              ? null
              : {
                  id: comment.id,
                  user: { id: 'me' },
                  issue: { identifier: find(comment.issueId)!.identifier },
                },
        };
      }
      case 'CommentUpdate':
        comments.find((candidate) => candidate.id === variables['id'])!.body = variables['body'];
        return { commentUpdate: { success: true } };
      default:
        throw new Error(`fake Linear: unhandled ${operation}`);
    }
  }

  const fetch: FetchLike = async (_url, init) => {
    const body = JSON.parse(init.body as string) as {
      query: string;
      variables: Record<string, any>;
    };
    const operation = /(?:query|mutation)\s+(\w+)/.exec(body.query)?.[1] ?? 'anonymous';
    operations.push(operation);
    return Response.json({ data: handle(operation, body.variables) });
  };
  return { fetch, issues, comments, operations };
}

function issue(overrides: Partial<FakeIssue> = {}): FakeIssue {
  return {
    id: 'uuid-1',
    identifier: 'COR-1',
    title: 'Groom the backlog',
    description: READY_BODY,
    priority: 0,
    stateId: 's-backlog',
    labelIds: [],
    blockedBy: [],
    ...overrides,
  };
}

const yes = (probability = 0.9): Decision<unknown> => ({
  value: true,
  probability,
  provider: 'fake',
  model: 'jev',
});
const no = (probability = 0.9): Decision<unknown> => ({
  value: false,
  probability,
  provider: 'fake',
  model: 'jev',
});

/** Jev answering every question the way `answers` says, passing every readiness question by default. */
function fakeJev(answers: Record<string, Decision<unknown>> = {}) {
  const batches: DecisionBatch[] = [];
  const decide = async (batch: DecisionBatch): Promise<DecisionBatchResult> => {
    batches.push(batch);
    const decisions = new Map<string, Decision<unknown>>();
    for (const [name, question] of batch.questions) {
      const given = answers[name];
      if (given !== undefined) decisions.set(name, given);
      else if (name === 'no-open-choice') decisions.set(name, no());
      else if (question.kind === 'boolean')
        decisions.set(name, name.startsWith('package:') ? no() : yes());
      else if (question.kind === 'scale')
        decisions.set(name, { value: 1, probability: 0.8, provider: 'fake', model: 'jev' });
      else
        decisions.set(name, {
          value: 'type:feature',
          probability: 0.8,
          provider: 'fake',
          model: 'jev',
        });
    }
    return { decisions };
  };
  return { decide, batches };
}

const workspaces: Workspace[] = [
  { name: 'bureau', path: 'packages/bureau', about: 'The agent runtime.' },
  { name: 'weft', path: 'packages/weft', about: 'The workflow engine.' },
  { name: 'operative', path: 'packages/operative', about: 'Model calls.' },
];

const repository = (): RepositoryView => ({
  files: new Set(),
  scripts: new Set(['check']),
  ignored: () => false,
});

function dependencies(fake: ReturnType<typeof fakeLinear>, jev: ReturnType<typeof fakeJev>) {
  return {
    fetch: fake.fetch,
    environment: { LINEAR_API_KEY: 'lin_api_test' },
    decide: jev.decide,
    repository,
    workspaces: () => workspaces,
  };
}

describe('groom', () => {
  test('a passing Backlog issue gets a priority, its labels, a Ready comment and the Ready state', async () => {
    const fake = fakeLinear([issue()]);
    const jev = fakeJev({ 'package:bureau': yes(), 'package:weft': no(0.5) });
    const result = await run([], dependencies(fake, jev));
    expect(result.code).toBe(0);
    const [groomed] = fake.issues;
    expect(groomed!.priority).toBe(3);
    expect(groomed!.labelIds).toEqual(['l-feature', 'l-bureau']);
    expect(groomed!.stateId).toBe('s-ready');
    expect(fake.comments).toHaveLength(1);
    expect(fake.comments[0]!.body).toStartWith(
      `${commentMarker} Ready. Every Definition of Ready predicate passed (references/linear-policy.md).`,
    );
    expect(fake.comments[0]!.body).toContain('Groom record: `text=');
    expect(result.output).toContain('unsettled labels: package:weft');
  });

  test('asks about only the package labels Linear has, and never about a priority or Work Type already set', async () => {
    const fake = fakeLinear([issue({ priority: 2, labelIds: ['l-bug', 'l-weft'] })]);
    const jev = fakeJev();
    await run([], dependencies(fake, jev));
    const asked = [...jev.batches[0]!.questions.keys()];
    expect(asked).toEqual(['package:bureau', ...readinessQuestions.map((entry) => entry.name)]);
    expect(fake.issues[0]!.priority).toBe(2);
    expect(jev.batches[0]!.context).toStartWith('# Groom the backlog');
  });

  test('a judgment question is asked only when the section it judges exists', async () => {
    const fake = fakeLinear([issue({ description: '## Brief\n\nOnly a brief.' })]);
    const jev = fakeJev();
    await run([], dependencies(fake, jev));
    expect(
      [...jev.batches[0]!.questions.keys()].filter((name) => !name.startsWith('package:')),
    ).toEqual(['priority', 'work-type', 'no-open-choice']);
  });

  test('a judgment that fails keeps the issue in Backlog and says what each failure needs', async () => {
    const fake = fakeLinear([issue()]);
    const jev = fakeJev({ 'criteria-binary': no(), 'no-open-choice': yes() });
    const result = await run(['--json'], dependencies(fake, jev));
    expect(result.code).toBe(1);
    expect(fake.issues[0]!.stateId).toBe('s-backlog');
    const report = JSON.parse(result.output).issues[0];
    expect(
      report.findings.map((finding: { code: string; need: string }) => [
        finding.code,
        finding.need,
      ]),
    ).toEqual([
      ['criteria-binary', 'rewrite'],
      ['no-open-choice', 'owner'],
    ]);
    expect(fake.comments[0]!.body).toStartWith(`${commentMarker} not Ready.`);
    expect(fake.comments[0]!.body).toContain('(needs an answer from the owner)');
  });

  test('an unsettled judgment is its own failure, not a pass', async () => {
    const fake = fakeLinear([issue()]);
    const result = await run(
      ['--json'],
      dependencies(fake, fakeJev({ 'delivery-concrete': yes(0.5) })),
    );
    expect(JSON.parse(result.output).issues[0].findings[0].code).toBe(
      'delivery-concrete-unsettled',
    );
  });

  test('mechanical failures and open blockers keep the issue in Backlog', async () => {
    const fake = fakeLinear([
      issue({ description: '## Brief\n\nOnly a brief.' }),
      issue({
        id: 'uuid-2',
        identifier: 'COR-2',
        blockedBy: [
          { identifier: 'COR-9', stateType: 'started' },
          { identifier: 'COR-8', stateType: 'canceled' },
          { identifier: 'COR-7', stateType: 'completed' },
        ],
      }),
    ]);
    const result = await run(['--json'], dependencies(fake, fakeJev()));
    const [first, second] = JSON.parse(result.output).issues;
    expect(first.findings.map((finding: { code: string }) => finding.code)).toContain(
      'section-missing',
    );
    expect(second.findings.map((finding: { need: string }) => finding.need)).toEqual([
      'wait',
      'owner',
    ]);
    expect(fake.issues.every((entry) => entry.stateId === 's-backlog')).toBe(true);
  });

  test('a later run on rewritten text asks again and updates its comment in place', async () => {
    const fake = fakeLinear([issue()]);
    await run([], dependencies(fake, fakeJev({ 'criteria-binary': no() })));
    fake.issues[0]!.description = READY_BODY.replace('exits 0.', 'exits 0 on main.');
    const jev = fakeJev();
    await run([], dependencies(fake, jev));
    expect([...jev.batches[0]!.questions.keys()]).toContain('criteria-binary');
    expect(fake.comments).toHaveLength(1);
    expect(fake.comments[0]!.body).toStartWith(`${commentMarker} Ready.`);
  });

  test('unchanged text reuses the last readings, so a reading near a threshold cannot flip', async () => {
    const fake = fakeLinear([issue()]);
    await run([], dependencies(fake, fakeJev({ 'no-open-choice': no(0.72) })));
    expect(fake.issues[0]!.stateId).toBe('s-ready');
    fake.issues[0]!.stateId = 's-backlog';
    // The same words, and Jev would now answer the other way: it is not asked.
    const jev = fakeJev({ 'no-open-choice': yes(0.95), 'criteria-binary': no() });
    const result = await run(['--json'], dependencies(fake, jev));
    const asked = [...jev.batches[0]!.questions.keys()];
    expect(asked.every((name) => name.startsWith('package:'))).toBe(true);
    const report = JSON.parse(result.output).issues[0];
    expect(report.ready).toBe(true);
    expect(report.reused).toEqual(readinessQuestions.map((question) => question.name));
    expect(report.answers['no-open-choice']).toBe(0.28);
  });

  test('a groom verdict clears an unsettled open choice for this text only', async () => {
    const fake = fakeLinear([issue({ priority: 3, labelIds: ['l-feature'] })]);
    const unsettled = () => fakeJev({ 'no-open-choice': yes(0.45) });
    const first = await run(['--json'], dependencies(fake, unsettled()));
    expect(JSON.parse(first.output).issues[0].findings[0].code).toBe('no-open-choice-unsettled');

    const today = () => '2026-11-13';
    const reason = 'Both alternatives it lists are under Out of scope, owned by COR-9.';
    const cleared = await run(['--clear-open-choice', 'COR-1', '--reason', reason, '--json'], {
      ...dependencies(fake, unsettled()),
      today,
    });
    expect(cleared.code).toBe(0);
    expect(JSON.parse(cleared.output).issues[0].cleared).toEqual({ date: '2026-11-13', reason });
    expect(fake.issues[0]!.stateId).toBe('s-ready');
    expect(fake.comments[0]!.body).toContain(
      `No owner choice (groom review, 2026-11-13): ${reason}`,
    );

    // The verdict holds on a later run of the same words, without being given again.
    fake.issues[0]!.stateId = 's-backlog';
    const again = await run(['--json'], dependencies(fake, unsettled()));
    expect(JSON.parse(again.output).issues[0].ready).toBe(true);
    expect(fake.comments[0]!.body).toContain('No owner choice (groom review');

    // New words ask Jev again and drop the verdict.
    fake.issues[0]!.stateId = 's-backlog';
    fake.issues[0]!.description = `${READY_BODY}\n\nOne more line.`;
    const changed = await run(['--json'], dependencies(fake, unsettled()));
    expect(changed.output).toStartWith('{"ok":false,"dryRun"');
    expect(JSON.parse(changed.output).issues[0].findings[0].code).toBe('no-open-choice-unsettled');
    expect(fake.comments[0]!.body).not.toContain('No owner choice');
  });

  test('a groom verdict cannot clear a clear open choice, and writes nothing', async () => {
    const fake = fakeLinear([issue({ priority: 3, labelIds: ['l-feature'] })]);
    const jev = fakeJev({ 'no-open-choice': yes(0.9) });
    await run([], dependencies(fake, jev));
    const before = fake.operations.length;
    const refusal = await throwingRejectionOf(
      run(['--clear-open-choice', 'COR-1', '--reason', 'none'], dependencies(fake, jev)),
    );
    expect(refusal).toThrow(UsageError);
    expect(refusal).toThrow('a clear yes goes to the owner');
    expect(
      fake.operations.slice(before).some((operation) => /Set|Add|Post|Update/.test(operation)),
    ).toBe(false);
  });

  test('a named issue already in progress is checked but keeps its state', async () => {
    const fake = fakeLinear([issue({ stateId: 's-doing', priority: 3, labelIds: ['l-feature'] })]);
    const result = await run(['--issue', 'cor-1'], dependencies(fake, fakeJev()));
    expect(result.code).toBe(0);
    expect(fake.issues[0]!.stateId).toBe('s-doing');
  });

  test('--dry-run reports the writes and makes none', async () => {
    const fake = fakeLinear([issue()]);
    const result = await run(['--dry-run', '--json'], dependencies(fake, fakeJev()));
    expect(JSON.parse(result.output).issues[0].writes).toEqual([
      'priority medium',
      'labels type:feature',
      'comment Ready',
      'state Ready',
    ]);
    expect(fake.operations.some((operation) => /Set|Add|Post|Update/.test(operation))).toBe(false);
  });

  test('a failed Jev call is exit 3 with no write, never an answer', async () => {
    const fake = fakeLinear([issue()]);
    const failing = {
      decide: async () => {
        throw new Error('HTTP 503');
      },
      batches: [],
    };
    const result = await run([], dependencies(fake, failing));
    expect(result.code).toBe(3);
    expect(result.output).toContain('HTTP 503');
    expect(fake.operations.some((operation) => /Set|Add|Post|Update/.test(operation))).toBe(false);
  });

  test('rejects bad arguments before any request', async () => {
    const fake = fakeLinear([issue()]);
    for (const argv of [
      ['--issue', 'nope'],
      ['--limit', '0'],
      ['extra'],
      ['--clear-open-choice', 'COR-1'],
      ['--reason', 'why'],
      ['--clear-open-choice', 'COR-1', '--reason', '  '],
      ['--clear-open-choice', 'COR-1', '--reason', 'why', '--issue', 'COR-2'],
    ])
      expect(await throwingRejectionOf(run(argv, dependencies(fake, fakeJev())))).toThrow(
        UsageError,
      );
    expect(fake.operations).toHaveLength(0);
  });
});

describe('the record', () => {
  test('a comment record reads back as written, and a foreign or malformed one reads as none', () => {
    const record = {
      text: '0123456789abcdef',
      readings: new Map([
        ['criteria-binary', 0.8],
        ['no-open-choice', 0.42],
      ]),
      cleared: { date: '2026-11-13', reason: 'Settled by COR-9.' },
    };
    expect(parseRecord(groomComment({ ready: true, findings: [] }, record))).toEqual(record);
    expect(parseRecord(`${commentMarker} Ready.`)).toBeUndefined();
    expect(parseRecord('Groom record: `text=short no-open-choice=0.4`')).toBeUndefined();
    expect(
      parseRecord('Groom record: `text=0123456789abcdef toString=0.4 no-open-choice=2`')?.readings,
    ).toEqual(new Map());
  });
});

describe('reading answers', () => {
  test("a yes/no answer's probability is turned into the probability of yes", () => {
    expect(probabilityOfYes(yes(0.8))).toBeCloseTo(0.8);
    expect(probabilityOfYes(no(0.8))).toBeCloseTo(0.2);
    expect(probabilityOfYes({ value: true, provider: 'fake', model: 'jev' })).toBeUndefined();
  });

  test('the thresholds split yes, no and unsettled, and a missing probability is unsettled', () => {
    expect(read(yesThreshold + 0.01)).toBe('yes');
    expect(read(noThreshold - 0.01)).toBe('no');
    expect(read(0.5)).toBe('unsettled');
    expect(read(undefined)).toBe('unsettled');
  });
});
