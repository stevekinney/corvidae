/**
 * COR-2009 — the sample world's seed, part A, asserted against the host it leaves running: the
 * chats with their titles, times and states, the two reviews waiting on you, Tool runner's Versions
 * 1 to 4, the four memories the Memory page lists (and the correction's history), and the audit
 * entries the story leaves, each at the moment the story gives it. The story's clock runs on in real
 * time between the moments the seed sets, so a time is asserted as the moment it was set to, plus at
 * most {@link SLACK}.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Host } from '../src/host/host.ts';
import {
  SHOWCASE_ASSISTANT_REPLY,
  SHOWCASE_HUMAN_INPUT,
  toolRunnerLookupReply,
} from '../src/host/showcase-agents.ts';
import { SHOWCASE_STORAGE_WARNING_BYTES } from '../src/host/showcase.ts';
import { formatBytes } from '../src/lib/format/index.ts';
import { GITHUB_SOURCE_ID, GITHUB_STUB_TOOLS } from './github-stub-mcp.ts';
import {
  DAILY_SUMMARY_SCHEDULE,
  LOOK_UP_4468_CHAT,
  RELEASE_NOTES_FAILURE,
  SAMPLE_WORLD_DURATIONS,
  SAMPLE_WORLD_HISTORY_TIMES,
  SAMPLE_WORLD_HOOKS,
  SAMPLE_WORLD_STORAGE_BYTES,
} from './sample-world-history.ts';
import {
  REFUND_4471_ASK_DELAY_MILLISECONDS,
  SAMPLE_WORLD_CHATS,
  SAMPLE_WORLD_TIMES,
  seedSampleWorld,
  TOOL_RUNNER_CORRECTION,
  TOOL_RUNNER_HOW_TOS,
  type SampleWorld,
} from './sample-world-seed.ts';
import {
  SHOWCASE_ORDER_REFUND_FILE,
  SHOWCASE_RELEASE_NOTES_FILE,
  SHOWCASE_TRIAGE_INBOX_FILE,
} from './showcase-content.ts';

/** How far past its moment a record may land: the work between two moments, on a slow machine. */
const SLACK = 60_000;

let home = '';
let world: SampleWorld;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'interborough-sample-world-'));
  world = await seedSampleWorld(join(home, 'home'));
});

afterAll(async () => {
  await world?.host.close();
  await rm(home, { recursive: true, force: true });
});

/** One JSON-RPC call to the seeded host's Bureau plane, as the local caller the page uses. */
async function call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(new URL('/bureau/jsonrpc', world.host.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params }),
  });
  const body = (await response.json()) as { result?: T; error?: unknown };
  if (body.result === undefined) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

/** Asserts that `iso` falls at `moment`, or at most {@link SLACK} after it. */
function expectAt(iso: string | null | undefined, moment: number): void {
  const at = Date.parse(iso ?? '');
  expect(at).toBeGreaterThanOrEqual(moment);
  expect(at - moment).toBeLessThan(SLACK);
}

type ContextRow = {
  id: string;
  title: string | null;
  agentName: string;
  activity: string;
  endReason: string | null;
  createdAt: string;
  updatedAt: string;
  lastMessagePreview: string | null;
};

describe('the sample world, part A', () => {
  test('holds the five chats, each with its title, agent, time and state', async () => {
    // A person's chats only: the sessions goals and schedule fires ran in are not chats.
    const { contexts } = await call<{ contexts: ContextRow[] }>('bureau.contexts.list', {
      origin: 'chat',
    });
    const byId = new Map(contexts.map((context) => [context.id, context]));
    expect(contexts.map((context) => context.id)).toEqual([
      SAMPLE_WORLD_CHATS.refund.threadId,
      SAMPLE_WORLD_CHATS.release.threadId,
      SAMPLE_WORLD_CHATS.sayHello.threadId,
      LOOK_UP_4468_CHAT.threadId,
      SAMPLE_WORLD_CHATS.billing.threadId,
    ]);

    // Oct 30, 11:20 AM: you ask Tool runner to look up order 4468, and it answers 23 s later.
    const lookUp = byId.get(LOOK_UP_4468_CHAT.threadId);
    expect(lookUp).toMatchObject({
      title: LOOK_UP_4468_CHAT.title,
      agentName: 'tool-runner',
      activity: 'idle',
      endReason: null,
      lastMessagePreview: toolRunnerLookupReply('4468'),
    });
    expectAt(lookUp?.createdAt, SAMPLE_WORLD_HISTORY_TIMES.lookUp4468);

    const refund = byId.get(SAMPLE_WORLD_CHATS.refund.threadId);
    expect(refund).toMatchObject({
      title: 'Please refund order 4471, it arrived damaged.',
      agentName: 'tool-runner',
      activity: 'awaiting-input',
      endReason: null,
    });
    expectAt(refund?.createdAt, SAMPLE_WORLD_TIMES.refund4472Asked);
    expectAt(
      refund?.updatedAt,
      SAMPLE_WORLD_TIMES.refund4471Started + REFUND_4471_ASK_DELAY_MILLISECONDS,
    );

    const release = byId.get(SAMPLE_WORLD_CHATS.release.threadId);
    expect(release).toMatchObject({
      title: 'Ship the release notes fix.',
      agentName: 'request-human-input',
      activity: 'awaiting-input',
      endReason: null,
    });
    expectAt(release?.createdAt, SAMPLE_WORLD_TIMES.releaseAsked);

    // Each message you sent is stamped at its moment, as the run that answered it is.
    const session = await world.host.bureau.contexts.get(SAMPLE_WORLD_CHATS.refund.threadId);
    const history = session?.conversationHistory;
    const sent = (history?.ids ?? [])
      .map((id) => history?.messages[id])
      .filter((message) => message?.role === 'user');
    expect(sent.map((message) => message?.content)).toEqual([
      SAMPLE_WORLD_CHATS.refund.first,
      SAMPLE_WORLD_CHATS.refund.second,
    ]);
    expectAt(sent[0]?.createdAt, SAMPLE_WORLD_TIMES.refund4472Asked);
    expectAt(sent[1]?.createdAt, SAMPLE_WORLD_TIMES.refund4471Started);
    // COR-2014: the 4471 reply names the model it ran on (Sonnet 5.5 since Oct 27), and its
    // lookup's answer says when the call ran.
    const rows = (history?.ids ?? []).map((id) => history?.messages[id]);
    const replies = rows.filter(
      (message) => message?.role === 'assistant' && message.createdAt >= sent[1]!.createdAt,
    );
    expect(replies.length).toBeGreaterThan(0);
    for (const reply of replies) {
      expect(reply?.metadata['bureau:replyModel']).toEqual({
        provider: 'anthropic',
        model: 'claude-sonnet-5-5',
      });
    }
    const lookups = rows.filter(
      (message) =>
        message?.role === 'tool-result' &&
        message.toolResult?.outcome === 'success' &&
        message.createdAt >= sent[1]!.createdAt,
    );
    expect(lookups.length).toBeGreaterThan(0);
    for (const lookup of lookups) {
      expect(lookup?.metadata['toolTiming']).toMatchObject({
        startedAt: expect.any(String),
        endedAt: expect.any(String),
      });
    }

    const hello = byId.get(SAMPLE_WORLD_CHATS.sayHello.threadId);
    expect(hello).toMatchObject({
      title: 'Say hello',
      agentName: 'assistant',
      activity: 'idle',
      endReason: null,
      lastMessagePreview: SHOWCASE_ASSISTANT_REPLY,
    });
    expectAt(hello?.updatedAt, SAMPLE_WORLD_TIMES.sayHello);

    // Ended by the restart on Oct 29: asked at 11:04 AM, stopped at 11:05 AM, with its reason.
    const billing = byId.get(SAMPLE_WORLD_CHATS.billing.threadId);
    expect(billing).toMatchObject({
      title: 'Rename the billing tables',
      agentName: 'tool-runner',
      activity: 'idle',
      endReason: 'host-stopped',
    });
    expectAt(billing?.createdAt, SAMPLE_WORLD_TIMES.billingAsked);
    expectAt(billing?.updatedAt, SAMPLE_WORLD_TIMES.billingStopped);
  });

  test('has two reviews waiting on you: the 4471 refund and the release question', async () => {
    const { reviews } = await call<{
      reviews: Array<{
        id: string;
        kind: string;
        sessionId?: string;
        prompt?: string | null;
        requestedAt: number;
      }>;
    }>('bureau.reviews.list', {});
    expect(reviews.map((review) => review.id).toSorted()).toEqual(
      [world.reviews.refund4471, world.reviews.release].toSorted(),
    );
    expect(reviews.find((review) => review.id === world.reviews.release)).toMatchObject({
      kind: 'human-wait',
      sessionId: SAMPLE_WORLD_CHATS.release.threadId,
      prompt: SHOWCASE_HUMAN_INPUT.prompt,
    });
    expect(reviews.find((review) => review.id === world.reviews.refund4471)).toMatchObject({
      kind: 'tool-approval',
      sessionId: SAMPLE_WORLD_CHATS.refund.threadId,
    });
    expect(world.reviews.refund4471).toStartWith(`approval:${world.runs.refund4471}:`);
    // Asked at 10:42:20 AM and at 9:46 AM ("4 min ago" and "1 hr ago" at 10:46 AM).
    const requestedAt = (id: string) =>
      new Date(reviews.find((review) => review.id === id)?.requestedAt ?? 0).toISOString();
    expectAt(
      requestedAt(world.reviews.refund4471),
      SAMPLE_WORLD_TIMES.refund4471Started + REFUND_4471_ASK_DELAY_MILLISECONDS,
    );
    expectAt(requestedAt(world.reviews.release), SAMPLE_WORLD_TIMES.releaseAsked);

    // The 4472 refund was approved by you at 10:33 AM.
    const decided = await call<{ reviews: Array<{ id: string; sessionId?: string }> }>(
      'bureau.reviews.list',
      { status: 'resolved' },
    );
    expect(decided.reviews.map((review) => review.id)).toEqual([
      expect.stringMatching(new RegExp(`^approval:${world.runs.refund4472}:`)),
    ]);
  });

  test('keeps Tool runner’s Versions 1 to 4, the last saved Oct 29 at 11:38 AM', async () => {
    const { versions } = await call<{
      versions: Array<{
        revision: number;
        savedAt: string;
        savedBy: string;
        changedKeys: string[];
      }>;
    }>('bureau.agents.versions.list', { id: 'tool-runner' });
    expect(versions.map((version) => version.revision)).toEqual([4, 3, 2, 1]);
    expect(versions.map((version) => version.changedKeys)).toEqual([
      ['instructions', 'tools', 'toolApproval'],
      ['model'],
      ['instructions'],
      ['instructions', 'tools', 'toolApproval', 'model'],
    ]);
    const [version4, version3, version2, version1] = versions;
    expectAt(version4?.savedAt, SAMPLE_WORLD_TIMES.toolRunnerVersion4);
    expectAt(version3?.savedAt, SAMPLE_WORLD_TIMES.toolRunnerVersion3);
    expectAt(version2?.savedAt, SAMPLE_WORLD_TIMES.toolRunnerVersion2);
    expectAt(version1?.savedAt, SAMPLE_WORLD_TIMES.toolRunnerVersion1);
    expect(new Set(versions.map((version) => version.savedBy))).toEqual(
      new Set(['anonymous:local']),
    );
  });

  test('lists the four memories the Memory page shows, the correction with its history', async () => {
    const { memories } = await call<{
      memories: Array<{
        id: string;
        content: string;
        kind: string;
        writer: string;
        createdAt: string;
        sessionId: string | null;
      }>;
    }>('bureau.memory.list', { agentId: 'tool-runner' });
    expect(memories.map(({ content, kind, writer }) => ({ content, kind, writer }))).toEqual([
      {
        content: 'Order 4471 arrived with a cracked mug; the customer asked for a refund.',
        kind: 'fact',
        writer: 'agent',
      },
      { content: TOOL_RUNNER_CORRECTION.corrected, kind: 'fact', writer: 'agent' },
      { content: TOOL_RUNNER_HOW_TOS.lookUpBeforeAnswering, kind: 'how-to', writer: 'person' },
      { content: TOOL_RUNNER_HOW_TOS.neverShareEmails, kind: 'how-to', writer: 'person' },
    ]);
    const [cracked, corrected, lookUp, emails] = memories;
    expectAt(
      cracked?.createdAt,
      SAMPLE_WORLD_TIMES.refund4471Started + REFUND_4471_ASK_DELAY_MILLISECONDS,
    );
    expect(cracked?.sessionId).toBe(SAMPLE_WORLD_CHATS.refund.threadId);
    expectAt(corrected?.createdAt, SAMPLE_WORLD_TIMES.memoryCorrected);
    expect(corrected?.sessionId).toBe(SAMPLE_WORLD_CHATS.refund.threadId);
    expectAt(lookUp?.createdAt, SAMPLE_WORLD_TIMES.lookUpBeforeAnswering);
    expectAt(emails?.createdAt, SAMPLE_WORLD_TIMES.neverShareEmails);

    const detail = await call<{
      lineage: { runId: string | null; corrects: string | null; correctedBy: string | null };
      history: Array<{ content: string; writer: string; writtenAt: string; correctedAt: string }>;
    }>('bureau.memory.get', { agentId: 'tool-runner', id: world.memories.corrected });
    // Corrected from the 4472 refund chat, by the run that asked to refund it.
    expect(detail.lineage).toEqual({
      runId: world.runs.refund4472,
      corrects: world.memories.original,
      correctedBy: null,
    });
    expect(detail.history).toEqual([
      expect.objectContaining({ content: TOOL_RUNNER_CORRECTION.original, writer: 'agent' }),
    ]);
    expectAt(detail.history[0]?.correctedAt, SAMPLE_WORLD_TIMES.memoryCorrected);
  });

  test('leaves the audit entries of the Nov 2 story, each at its moment', async () => {
    const records = await auditSince(SAMPLE_WORLD_TIMES.serverStarted);
    const entry = (
      type: string,
      matches: (detail: Record<string, unknown>) => boolean = () => true,
    ) => records.filter((record) => record.type === type && matches(record.detail ?? {}));
    const toolCall =
      (toolCallId: string, status: string) =>
      (detail: Record<string, unknown>): boolean =>
        detail['toolCallId'] === toolCallId && detail['status'] === status;

    const [started] = entry('host.started');
    expect(started?.principal).toBe('system:host');
    expectAt(started?.timestamp, SAMPLE_WORLD_TIMES.serverStarted);

    // 10:30 AM: Tool runner asks to refund order 4472.
    const [asked4472] = entry('tool.settled', toolCall('showcase-issue-refund-1', 'paused'));
    expect(asked4472?.detail).toMatchObject({ agentName: 'tool-runner', toolName: 'issue-refund' });
    expectAt(asked4472?.timestamp, SAMPLE_WORLD_TIMES.refund4472Asked);

    // 10:31 AM: Tool runner corrects its memory, in the refund chat.
    const [correction] = entry('memory.corrected');
    expect(correction?.detail).toEqual({
      agentName: 'tool-runner',
      memoryId: world.memories.corrected,
      correctsId: world.memories.original,
      writer: 'agent',
      sessionId: SAMPLE_WORLD_CHATS.refund.threadId,
    });
    expectAt(correction?.timestamp, SAMPLE_WORLD_TIMES.memoryCorrected);

    // 10:33 AM: you approve, and the refund goes through.
    const [approved] = entry('review.tool-approval.approved');
    expect(approved?.principal).toBe('anonymous:local');
    expect(approved?.detail).toMatchObject({ toolName: 'issue-refund' });
    expectAt(approved?.timestamp, SAMPLE_WORLD_TIMES.refund4472Approved);
    const [refunded] = entry('tool.settled', toolCall('showcase-issue-refund-1', 'success'));
    expectAt(refunded?.timestamp, SAMPLE_WORLD_TIMES.refund4472Approved);

    // 10:42 AM: the order 4471 run starts; Issue refund asks at 10:42:20 AM and still waits.
    const runs = entry(
      'run.started',
      (detail) => detail['sessionId'] === SAMPLE_WORLD_CHATS.refund.threadId,
    );
    expectAt(runs.at(-1)?.timestamp, SAMPLE_WORLD_TIMES.refund4471Started);
    const [asked4471] = entry('tool.settled', toolCall('showcase-issue-refund-2', 'paused'));
    expectAt(
      asked4471?.timestamp,
      SAMPLE_WORLD_TIMES.refund4471Started + REFUND_4471_ASK_DELAY_MILLISECONDS,
    );
    expect(entry('tool.settled', toolCall('showcase-issue-refund-2', 'success'))).toEqual([]);

    // 10:45 AM: you remove the Anthropic key.
    const [removed] = entry('provider.disconnected');
    expect(removed).toMatchObject({
      principal: 'anonymous:local',
      detail: { provider: 'anthropic' },
    });
    expectAt(removed?.timestamp, SAMPLE_WORLD_TIMES.anthropicKeyRemoved);
  });
});

/** Every audit record from `moment` on, oldest first. */
async function auditSince(moment: number) {
  const host: Host = world.host;
  const page = await host.bureau.audit.query({ since: moment, limit: 100 });
  return page.records.toSorted(
    (left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp),
  );
}

/** A run of the Bureau's engine, as `weft.workflows.list` lists it. */
type EngineRunRow = {
  id: string;
  type: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  tags?: string[];
};

/** A run as the Bureau's task list keeps it. */
type TaskRow = { id: string; status: string; createdAt: string; updatedAt: string };

/** One row of the sample world's run list, as PageRuns' captioned table defines it. */
type RunListRow = {
  /** When it started, to the minute. */
  readonly at: number;
  readonly workflow: string;
  readonly startedBy: string;
  readonly status: string;
  /** How long it took, in seconds; `null` for a run still waiting on you. */
  readonly seconds: number | null;
};

/** One JSON-RPC call to the seeded host's Weft plane. */
async function engineCall<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const response = await fetch(new URL('/jsonrpc', world.host.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params }),
  });
  const body = (await response.json()) as { result?: T; error?: unknown };
  if (body.result === undefined) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

/** The words a run's status reads as on Runs, from its task's status or the engine's. */
const STATUS_WORDS: Readonly<Record<string, string>> = {
  'input-required': 'Waiting on you',
  completed: 'Done',
  canceled: 'Canceled',
  cancelled: 'Canceled',
  failed: 'Failed',
};

/** What started a run, as Runs' Started by names it, from its `origin:` tag. */
const STARTED_BY_WORDS: Readonly<Record<string, string>> = {
  chat: 'Chats',
  schedule: 'Schedules',
  goal: 'Goals',
  system: 'Interborough',
};

/**
 * The sample world's run list: every run of the engine that Runs lists, which leaves out a goal's
 * own controller (its attempts are the runs) and a workflow's steps (the workflow's run is).
 */
async function runList(): Promise<RunListRow[]> {
  const { items } = await engineCall<{ items: EngineRunRow[] }>('weft.workflows.list', {
    limit: 500,
  });
  const { tasks } = await call<{ tasks: TaskRow[] }>('bureau.tasks.list', { limit: 100 });
  const taskOf = new Map(tasks.map((task) => [task.id, task]));
  return items
    .filter((run) => run.type !== 'goalRun' && !(run.tags ?? []).includes('origin:parent'))
    .map((run) => {
      const tags = run.tags ?? [];
      const origin = tags.find((tag) => tag.startsWith('origin:'))?.slice('origin:'.length) ?? '';
      const task = taskOf.get(run.id);
      const status = STATUS_WORDS[task?.status ?? run.status] ?? run.status;
      const started = task === undefined ? run.createdAt : Date.parse(task.createdAt);
      const ended = task === undefined ? run.updatedAt : Date.parse(task.updatedAt);
      const workflow =
        run.type === 'agentRun'
          ? origin === 'goal'
            ? 'Goal attempts'
            : 'Chat with an agent'
          : run.type === 'scheduleTick'
            ? 'Schedule tick'
            : run.type;
      return {
        at: Math.floor(started / 60_000) * 60_000,
        workflow,
        startedBy: STARTED_BY_WORDS[origin] ?? origin,
        status,
        seconds: status === 'Waiting on you' ? null : (ended - started) / 1000,
      };
    });
}

/** Counts `rows` by the value `key` reads. */
function countBy(rows: readonly RunListRow[], key: (row: RunListRow) => string) {
  const counts: Record<string, number> = {};
  for (const row of rows) counts[key(row)] = (counts[key(row)] ?? 0) + 1;
  return counts;
}

/** How far past its scripted duration a run may end: the real work between two moments. */
const DURATION_SLACK_SECONDS = 5;

describe('the sample world, part B', () => {
  test('holds the run list PageRuns defines, with the billing chat its restart ended', async () => {
    const times = { ...SAMPLE_WORLD_TIMES, ...SAMPLE_WORLD_HISTORY_TIMES };
    const durations = SAMPLE_WORLD_DURATIONS;
    const attempts = durations.draftReleaseNotesAttempts;
    const chat = 'Chat with an agent';
    const goal = 'Goal attempts';
    const expected: Array<Omit<RunListRow, 'seconds'> & { seconds: number | null | 'any' }> = [
      {
        at: times.refund4471Started,
        workflow: chat,
        startedBy: 'Chats',
        status: 'Waiting on you',
        seconds: null,
      },
      {
        at: times.refund4472Asked,
        workflow: chat,
        startedBy: 'Chats',
        status: 'Done',
        seconds: 'any',
      },
      {
        at: times.releaseAsked,
        workflow: chat,
        startedBy: 'Chats',
        status: 'Waiting on you',
        seconds: null,
      },
      {
        at: times.serverStarted,
        workflow: 'Schedule tick',
        startedBy: 'Interborough',
        status: 'Done',
        seconds: 0,
      },
      { at: times.sayHello, workflow: chat, startedBy: 'Chats', status: 'Done', seconds: 8 },
      {
        at: times.lookUp4468,
        workflow: chat,
        startedBy: 'Chats',
        status: 'Done',
        seconds: durations.lookUp4468,
      },
      {
        at: times.releaseNotesFailed,
        workflow: 'release-notes',
        startedBy: 'Schedules',
        status: 'Failed',
        seconds: durations.releaseNotesFailed,
      },
      {
        at: times.summarizeRefundsSecondAttempt,
        workflow: goal,
        startedBy: 'Goals',
        status: 'Canceled',
        seconds: durations.summarizeRefundsSecondAttempt,
      },
      {
        at: times.summarizeRefundsGoal,
        workflow: goal,
        startedBy: 'Goals',
        status: 'Done',
        seconds: durations.summarizeRefundsFirstAttempt,
      },
      ...attempts
        .map((seconds, index) => ({
          at: times.draftReleaseNotesGoal + index * 120_000,
          workflow: goal,
          startedBy: 'Goals',
          status: 'Done',
          seconds,
        }))
        .toReversed(),
      {
        at: times.sayHelloGoal,
        workflow: goal,
        startedBy: 'Goals',
        status: 'Done',
        seconds: durations.sayHelloGoal,
      },
      // Not on PageRuns' list: the run the Oct 29 restart stopped, which the chat list reads as Ended.
      {
        at: times.billingAsked,
        workflow: chat,
        startedBy: 'Chats',
        status: 'Canceled',
        seconds: 60,
      },
      {
        at: times.dailySummaryRan,
        workflow: chat,
        startedBy: 'Schedules',
        status: 'Done',
        seconds: durations.dailySummary,
      },
      {
        at: times.dailySummaryRan,
        workflow: 'Schedule tick',
        startedBy: 'Interborough',
        status: 'Done',
        seconds: 0,
      },
      {
        at: times.triageSecondRun,
        workflow: 'triage-inbox',
        startedBy: 'Schedules',
        status: 'Done',
        seconds: durations.triageSecondRun,
      },
      {
        at: times.triageFirstRun,
        workflow: 'triage-inbox',
        startedBy: 'Schedules',
        status: 'Done',
        seconds: durations.triageFirstRun,
      },
    ];
    const order = (
      left: { at: number; workflow: string },
      right: { at: number; workflow: string },
    ) => right.at - left.at || left.workflow.localeCompare(right.workflow);
    const listed = await runList();
    const rows = listed.toSorted(order);
    expect(rows.map(({ seconds: _seconds, ...row }) => row)).toEqual(
      expected.toSorted(order).map(({ seconds: _seconds, ...row }) => row),
    );
    for (const [index, row] of expected.toSorted(order).entries()) {
      const seconds = rows[index]?.seconds;
      if (row.seconds === 'any') continue;
      if (row.seconds === null) {
        expect(seconds).toBeNull();
        continue;
      }
      // A moment the story sets lands to the millisecond; the work between moments only adds.
      expect(Math.round(seconds ?? -1)).toBeGreaterThanOrEqual(row.seconds);
      expect(seconds).toBeLessThan(row.seconds + DURATION_SLACK_SECONDS);
    }

    // All 20 = Waiting on you 2 + Done 15 + Failed 1 + Canceled 2 (the board's 19 and the billing chat).
    expect(countBy(rows, (row) => row.status)).toEqual({
      'Waiting on you': 2,
      Done: 15,
      Failed: 1,
      Canceled: 2,
    });
    expect(countBy(rows, (row) => row.startedBy)).toEqual({
      Chats: 6,
      Schedules: 4,
      Goals: 8,
      Interborough: 2,
    });
    expect(countBy(rows, (row) => row.workflow)).toEqual({
      'Chat with an agent': 7,
      'Goal attempts': 8,
      'Schedule tick': 2,
      'triage-inbox': 2,
      'release-notes': 1,
    });
  });

  test('fails Release notes at step 2 of 4 on Oct 30, because GitHub didn’t answer', async () => {
    const { runs } = await call<{
      runs: Array<{ id: string; status: string; error?: unknown }>;
    }>('bureau.workflows.runs.list', { workflow: 'release-notes', limit: 10 });
    expect(runs.map((run) => run.status)).toEqual(['failed']);
    const { items: steps } = await engineCall<{ items: EngineRunRow[] }>('weft.workflows.list', {
      limit: 500,
      tags: [`origin-parent:${runs[0]?.id ?? ''}`],
    });
    const { tasks } = await call<{ tasks: Array<TaskRow & { statusMessage: string | null }> }>(
      'bureau.tasks.list',
      { limit: 100 },
    );
    const stepTasks = tasks.filter((task) => steps.some((step) => step.id === task.id));
    expect(stepTasks.map((task) => task.status).toSorted()).toEqual(['completed', 'failed']);
    expect(stepTasks.find((task) => task.status === 'failed')?.statusMessage).toContain(
      RELEASE_NOTES_FAILURE,
    );
  });

  test('keeps the four schedules with their cadences: Active 3, Paused 1', async () => {
    type ScheduleRow = {
      description: string;
      agentName: string | null;
      workflowType: string;
      inputPreview: string | null;
      cronExpression: string;
      timeZone: string;
      status: string;
      nextFireAt: string | null;
      lastFireAt: string | null;
      blocker: { kind: string; workflow: string } | null;
    };
    const { schedules } = await call<{ schedules: ScheduleRow[] }>('bureau.schedules.list', {
      limit: 100,
    });
    const named = (description: string) =>
      schedules.find((schedule) => schedule.description === description);
    expect(schedules.map((schedule) => schedule.description).toSorted()).toEqual([
      'Daily summary',
      'Inbox triage',
      'Release notes digest',
      'Weekly refund audit',
    ]);
    expect(
      countBy(
        schedules.map((schedule) => ({ status: schedule.status }) as unknown as RunListRow),
        (row) => row.status,
      ),
    ).toEqual({ active: 3, paused: 1 });

    // Daily summary: Assistant every day at 9:00 AM UTC, which is 3:00 AM CST; last ran Oct 29.
    expect(named('Daily summary')).toMatchObject({
      agentName: 'assistant',
      workflowType: 'agentRun',
      inputPreview: DAILY_SUMMARY_SCHEDULE.input,
      cronExpression: '0 9 * * *',
      timeZone: 'UTC',
      status: 'active',
      lastFireAt: new Date(SAMPLE_WORLD_HISTORY_TIMES.dailySummaryRan).toISOString(),
      blocker: null,
    });
    const centralClock = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    });
    expect(centralClock.format(Date.parse('2026-11-02T09:00:00Z'))).toBe('3:00 AM CST');

    // Inbox triage: Triage inbox's trigger, every day at 8:00 AM, paused since its Oct 24 run.
    expect(named('Inbox triage')).toMatchObject({
      workflowType: 'triage-inbox',
      cronExpression: '0 8 * * *',
      timeZone: 'America/Chicago',
      status: 'paused',
      lastFireAt: new Date(SAMPLE_WORLD_HISTORY_TIMES.triageSecondRun).toISOString(),
    });

    // Release notes digest: release-notes.json's trigger, Fridays at 11:00 AM; next Fri Nov 6.
    expect(named('Release notes digest')).toMatchObject({
      workflowType: 'release-notes',
      cronExpression: '0 11 * * 5',
      timeZone: 'America/Chicago',
      status: 'active',
      lastFireAt: new Date(SAMPLE_WORLD_HISTORY_TIMES.releaseNotesFailed).toISOString(),
      nextFireAt: '2026-11-06T17:00:00.000Z',
      blocker: null,
    });

    // Weekly refund audit: Order refund's trigger from its last good version, never run, first
    // due today at 11:00 AM, held because the file can't load.
    expect(named('Weekly refund audit')).toMatchObject({
      workflowType: 'order-refund',
      cronExpression: '0 11 * * 1',
      timeZone: 'America/Chicago',
      status: 'active',
      lastFireAt: null,
      nextFireAt: '2026-11-02T17:00:00.000Z',
      blocker: { kind: 'workflow-cannot-load', workflow: 'order-refund' },
    });
  });

  test('lists Needs attention most recent first: the provider, the storage alert, the missed runs', async () => {
    const attention = await world.host.bureau.attention();
    expect(attention.items).toEqual([
      expect.objectContaining({ kind: 'no-provider', provider: 'anthropic' }),
      expect.objectContaining({
        kind: 'alert',
        metric: 'storage.size',
        currentValue: SAMPLE_WORLD_STORAGE_BYTES,
        threshold: SHOWCASE_STORAGE_WARNING_BYTES,
      }),
      expect.objectContaining({ kind: 'missed-runs', scheduleName: 'Daily summary', count: 4 }),
    ]);
    const [provider, alert, missed] = attention.items;
    expectAt(new Date(provider?.at ?? 0).toISOString(), SAMPLE_WORLD_TIMES.anthropicKeyRemoved);
    // The offset clock runs on between the seed setting it and the alert firing, as every moment does.
    expectAt(new Date(alert?.at ?? 0).toISOString(), SAMPLE_WORLD_HISTORY_TIMES.storageAlertFired);
    expect(formatBytes(SAMPLE_WORLD_STORAGE_BYTES)).toBe('1.6 GB');
    expectAt(new Date(missed?.at ?? 0).toISOString(), SAMPLE_WORLD_TIMES.serverStarted);
    expect(missed).toMatchObject({ since: Date.parse('2026-10-30T09:00:00Z') });

    // The server's start logged the four missed runs, in the audit log too.
    const records = await auditSince(SAMPLE_WORLD_TIMES.serverStarted);
    const misses = records.filter((record) => record.type === 'schedule.missed');
    expect(misses.length).toBeGreaterThan(0);
    for (const record of misses) expectAt(record.timestamp, SAMPLE_WORLD_TIMES.serverStarted);
  });

  test('ends the three goals as PageGoals draws them: done, gave up and stopped', async () => {
    type GoalRow = {
      goalRunId: string;
      agentName: string;
      status: string;
      attempts: Array<{ status: string; startedAt: string }>;
    };
    const { goals } = await call<{ goals: GoalRow[] }>('bureau.goals.list', {});
    const outcome = (goal: GoalRow) =>
      `${goal.agentName} ${goal.status}: ${goal.attempts.map((attempt) => attempt.status).join(', ')}`;
    expect(goals.map(outcome).toSorted((left, right) => left.localeCompare(right))).toEqual([
      'assistant exhausted: failed, failed, failed, failed, failed',
      'assistant succeeded: passed',
      'tool-runner canceled: failed, aborted',
    ]);
    const gaveUp = goals.find((goal) => goal.status === 'exhausted');
    for (const [index, attempt] of (gaveUp?.attempts ?? []).entries()) {
      expectAt(
        attempt.startedAt,
        SAMPLE_WORLD_HISTORY_TIMES.draftReleaseNotesGoal + index * 120_000,
      );
    }
  });

  test('keeps the five hooks, delivered through the showcase and never to their addresses', async () => {
    type HookRow = {
      name: string;
      events: string[];
      enabled: boolean;
      action: { type: string; url?: string };
      scope: { kind: string; id: string } | null;
      lastDelivery: {
        kind: string;
        status: string;
        lastAttempt: { startedAt: number; status: number | null };
      } | null;
    };
    const { hooks } = await call<{ hooks: HookRow[] }>('bureau.hooks.list', {});
    const named = (hook: { name: string }) => hooks.find((row) => row.name === hook.name);
    const { pageOnCall, notifySlack, triageFinishes, scheduleMisses, refundAudit } =
      SAMPLE_WORLD_HOOKS;
    expect(hooks).toHaveLength(5);
    const lastDelivered = (hook: HookRow | undefined, kind: string, moment: number) => {
      expect(hook?.lastDelivery).toMatchObject({ kind, status: 'delivered' });
      expectAt(new Date(hook?.lastDelivery?.lastAttempt.startedAt ?? 0).toISOString(), moment);
    };
    expect(named(pageOnCall)).toMatchObject({ enabled: true, events: ['schedule.failed'] });
    lastDelivered(
      named(pageOnCall),
      'schedule.failed',
      SAMPLE_WORLD_HISTORY_TIMES.releaseNotesFailed,
    );
    expect(named(notifySlack)).toMatchObject({ enabled: true, events: ['review.requested'] });
    lastDelivered(
      named(notifySlack),
      'review.requested',
      SAMPLE_WORLD_TIMES.refund4471Started + REFUND_4471_ASK_DELAY_MILLISECONDS,
    );
    expect(named(triageFinishes)).toMatchObject({
      enabled: true,
      action: { type: 'notify' },
      scope: { kind: 'workflow', id: 'triage-inbox' },
    });
    lastDelivered(
      named(triageFinishes),
      'schedule.completed',
      SAMPLE_WORLD_HISTORY_TIMES.triageSecondRun,
    );
    expect(named(scheduleMisses)).toMatchObject({ enabled: true, action: { type: 'notify' } });
    lastDelivered(named(scheduleMisses), 'schedule.missed', SAMPLE_WORLD_TIMES.serverStarted);
    expect(named(refundAudit)).toMatchObject({
      enabled: false,
      scope: { kind: 'agent', id: 'tool-runner' },
    });
    lastDelivered(named(refundAudit), 'hook.test', SAMPLE_WORLD_HISTORY_TIMES.refundAuditTested);
    // Every webhook answered 200: the showcase's own fetch, not the real address.
    for (const hook of [pageOnCall, notifySlack, refundAudit]) {
      expect(named(hook)?.lastDelivery?.lastAttempt.status).toBe(200);
    }
  });

  test('has cleared what the person’s own hooks wrote, so the bell lists what needs them now', async () => {
    type NotificationRow = { kind: string; title: string };
    const listed = await call<{ notifications: NotificationRow[] }>(
      'bureau.notifications.list',
      {},
    );
    expect(listed.notifications.filter((notification) => notification.kind === 'hook')).toEqual([]);
    // The hooks delivered, and what they wrote is dismissed, not gone: the record is kept.
    const everything = await call<{ notifications: NotificationRow[] }>(
      'bureau.notifications.list',
      { includeDismissed: true },
    );
    expect(
      everything.notifications.filter((notification) => notification.kind === 'hook').length,
    ).toBeGreaterThanOrEqual(3);
  });

  test('runs Guardrails and Inspectors, needs setup for the providers and TypeSafe, and keeps Demo, Workspace, Ollama and Voyage off', async () => {
    const response = await fetch(new URL('/host/plugins', world.host.url));
    const { plugins } = (await response.json()) as {
      plugins: Array<{ descriptor: { name: string }; source: string; status: string }>;
    };
    const statuses = Object.fromEntries(
      plugins
        .filter((plugin) => plugin.source !== 'built-in')
        .map((plugin) => [plugin.descriptor.name, plugin.status]),
    );
    expect(statuses).toEqual({
      guardrails: 'running',
      inspectors: 'running',
      anthropic: 'needs-setup',
      openai: 'needs-setup',
      gemini: 'needs-setup',
      typesafe: 'needs-setup',
      demo: 'disabled',
      workspace: 'disabled',
      ollama: 'disabled',
      voyage: 'disabled',
    });
  });

  test('connects GitHub, a stub MCP server, with List issues, Create issue and Delete branch off', async () => {
    const response = await fetch(new URL('/host/tool-sources', world.host.url));
    const { sources } = (await response.json()) as {
      sources: Array<{
        id: string;
        state: string;
        tools: Array<{ tool: string; enabled: boolean; tier: string }>;
      }>;
    };
    expect(sources).toHaveLength(1);
    const [github] = sources;
    expect(github).toMatchObject({ id: GITHUB_SOURCE_ID, state: 'loaded' });
    expect(github?.tools.map(({ tool, enabled }) => [tool, enabled])).toEqual([
      ['list_issues', true],
      ['create_issue', true],
      ['delete_branch', false],
    ]);
    // What a person reads: each tool's title, and its risk.
    const probe = await fetch(
      new URL(`/host/tool-sources/${GITHUB_SOURCE_ID}/probe`, world.host.url),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          source: {
            id: GITHUB_SOURCE_ID,
            kind: 'mcp',
            transport: {
              type: 'stdio',
              command: process.execPath,
              args: [join(import.meta.dir, 'github-stub-mcp.ts')],
            },
          },
        }),
      },
    );
    const probed = (await probe.json()) as {
      outcome: string;
      tools: Array<{ tool: string; title: string; tier: string }>;
    };
    expect(probed.outcome).toBe('listed');
    expect(probed.tools.map(({ tool, title, tier }) => [tool, title, tier])).toEqual([
      ['list_issues', GITHUB_STUB_TOOLS.list_issues, 'read-only'],
      ['create_issue', GITHUB_STUB_TOOLS.create_issue, 'mutating'],
      ['delete_branch', GITHUB_STUB_TOOLS.delete_branch, 'dangerous'],
    ]);
  });

  test('keeps Release notes’ four versions, the run on 1.2.0, and the files as the Code tabs show them', async () => {
    type Revision = {
      version: string;
      savedAt: string;
      surface: string | null;
      compatibility: string | null;
      changes: Array<{ kind: string }>;
      runs: { count: number; firstRunAt: string | null };
    };
    const { revisions } = await call<{ revisions: Revision[] }>('bureau.workflows.history', {
      id: 'release-notes',
    });
    const times = SAMPLE_WORLD_HISTORY_TIMES;
    expect(
      revisions.map(({ version, surface, compatibility, changes }) => ({
        version,
        surface,
        compatibility,
        changes: changes.map((change) => change.kind).toSorted(),
      })),
    ).toEqual([
      { version: '1.3.0', surface: 'web', compatibility: 'compatible', changes: ['step-reworded'] },
      { version: '1.2.0', surface: null, compatibility: 'compatible', changes: ['step-added'] },
      {
        version: '1.1.0',
        surface: null,
        compatibility: 'breaking',
        changes: ['input-schema', 'step-reworded'],
      },
      { version: '1.0.0', surface: null, compatibility: null, changes: [] },
    ]);
    const saved = [
      times.releaseNotesVersion4,
      times.releaseNotesVersion3,
      times.releaseNotesVersion2,
      times.releaseNotesVersion1,
    ];
    for (const [index, revision] of revisions.entries()) {
      expectAt(revision.savedAt, saved[index] ?? 0);
    }
    expect(revisions[1]?.runs.count).toBe(1);
    expectAt(revisions[1]?.runs.firstRunAt, times.releaseNotesFailed);

    const workflows = join(home, 'home', 'workflows');
    for (const file of [
      SHOWCASE_RELEASE_NOTES_FILE,
      SHOWCASE_TRIAGE_INBOX_FILE,
      SHOWCASE_ORDER_REFUND_FILE,
    ]) {
      expect(await readFile(join(workflows, `${file.id}.json`), 'utf8')).toBe(file.text);
    }
  });
});
