/**
 * The sample world's history outside its chats (`tmp/design-review/decisions.md`), played by the
 * seed (`sample-world-seed.ts`) on its hosts: the workflow files and their versions, the four
 * schedules, the runs they and the goals started, the hooks, the GitHub tool source, and the
 * storage alert. Each scene acts as a person or the scheduler would, at its moment on the story's
 * offset clock, so every record is the product's own.
 *
 * - Oct 21: Release notes 1.0.0 (10:30 AM) and 1.1.0 (2:40 PM), then paused until its approval step
 *   is written, so its Friday schedule misses nothing; the hooks; the GitHub source, Delete branch
 *   left off.
 * - Oct 23 and 24, 8:00 AM: the Inbox triage schedule starts Triage inbox (38 s and 41 s); after the
 *   second run Triage inbox, and so its schedule, is paused.
 * - Oct 29, 9:15 AM: Release notes 1.2.0 adds the approval step, which resumes it.
 * - Oct 30: the goals (Say hello at 7:48 AM, Draft release notes from 8:13 AM, Summarize open
 *   refunds from 10:05 AM, stopped at 10:08 AM), the Refund audit hook (tested, then turned off),
 *   Release notes' scheduled run at 11:00 AM, which fails at step 2 (GitHub didn't answer), and the
 *   "Look up order 4468" chat at 11:20 AM, whose remembered reply you forget at 11:21 AM.
 * - Nov 1, 4:30 PM: Release notes 1.3.0, edited in the builder; 4:35 PM: Order refund with its
 *   Weekly refund audit schedule (Mondays at 11:00 AM, first due Nov 2).
 * - Daily summary is created on Oct 28 and fires once, Oct 29 at 4:00 AM (9:00 AM UTC). It is played
 *   last, on a clock set back to Oct 28, because a live scheduler logs every occurrence it finds
 *   past: had the schedule existed while the Oct 30 and Nov 1 hosts ran, they would have run or
 *   missed it. So its four misses since Oct 30 are logged once, when the Nov 2 server starts.
 * - Before the Nov 2 server starts, Order refund loses the comma on line 11, so it can't load and
 *   Bureau holds the Weekly refund audit schedule from its last good version.
 * - Nov 2, 9:05 AM: the host's storage reports 1.6 GB, over the showcase's 1 GB `storage.size` rule,
 *   so the storage alert fires.
 *
 * @module sample-world-history
 */

import { waitUntil } from '@lostgradient/testing/wait-until';
import { StorageSizeReportedEvent } from '@lostgradient/weft';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { WORKFLOW_DIRECTORY_NAME } from '../src/host/host.ts';
import { SHOWCASE_GOAL_CHECKS } from '../src/host/showcase-agents.ts';
import { GITHUB_SOURCE_ID } from './github-stub-mcp.ts';
import {
  bureauCall,
  central,
  hostRequest,
  sendChatMessage,
  waitForSettledRuns,
  type EngineRun,
  type SessionContext,
} from './sample-world-host.ts';
import {
  SHOWCASE_ORDER_REFUND_FILE,
  SHOWCASE_ORDER_REFUND_VALID_FILE,
  SHOWCASE_RELEASE_NOTES_FILE,
  SHOWCASE_TRIAGE_INBOX_FILE,
  type ShowcaseWorkflowFile,
} from './showcase-content.ts';

/** The moments of the history (Central time: October is UTC-5, November UTC-6). */
export const SAMPLE_WORLD_HISTORY_TIMES = {
  releaseNotesVersion1: central('2026-10-21T10:30:00', '-05:00'),
  releaseNotesVersion2: central('2026-10-21T14:40:00', '-05:00'),
  releaseNotesPaused: central('2026-10-21T14:41:00', '-05:00'),
  hooksCreated: central('2026-10-21T15:00:00', '-05:00'),
  gitHubConnected: central('2026-10-21T15:10:00', '-05:00'),
  triageCreated: central('2026-10-23T07:58:00', '-05:00'),
  triageFirstRun: central('2026-10-23T08:00:00', '-05:00'),
  triageSecondRun: central('2026-10-24T08:00:00', '-05:00'),
  triagePaused: central('2026-10-24T08:05:00', '-05:00'),
  dailySummaryCreated: central('2026-10-28T09:00:00', '-05:00'),
  dailySummaryRan: central('2026-10-29T04:00:00', '-05:00'),
  releaseNotesVersion3: central('2026-10-29T09:15:00', '-05:00'),
  sayHelloGoal: central('2026-10-30T07:48:00', '-05:00'),
  draftReleaseNotesGoal: central('2026-10-30T08:13:00', '-05:00'),
  summarizeRefundsGoal: central('2026-10-30T10:05:00', '-05:00'),
  summarizeRefundsSecondAttempt: central('2026-10-30T10:07:00', '-05:00'),
  summarizeRefundsStopped: central('2026-10-30T10:08:12', '-05:00'),
  refundAuditTested: central('2026-10-30T10:20:00', '-05:00'),
  releaseNotesFailed: central('2026-10-30T11:00:00', '-05:00'),
  lookUp4468: central('2026-10-30T11:20:00', '-05:00'),
  lookUp4468Forgotten: central('2026-10-30T11:21:00', '-05:00'),
  releaseNotesVersion4: central('2026-11-01T16:30:00', '-06:00'),
  orderRefundSaved: central('2026-11-01T16:35:00', '-06:00'),
  storageAlertFired: central('2026-11-02T09:05:00', '-06:00'),
} as const;

/** How long each run of the history takes, in seconds (PageRuns' line two). */
export const SAMPLE_WORLD_DURATIONS = {
  triageFirstRun: 38,
  triageSecondRun: 41,
  dailySummary: 14,
  releaseNotesFailed: 3,
  lookUp4468: 23,
  sayHelloGoal: 8,
  draftReleaseNotesAttempts: [8, 6, 5, 7, 6],
  summarizeRefundsFirstAttempt: 125,
  summarizeRefundsSecondAttempt: 72,
} as const;

/** What GitHub didn't answer with on Oct 30, the cause of Release notes' one failed run. */
export const RELEASE_NOTES_FAILURE = 'GitHub didn’t answer (HTTP 503)';

/** The Daily summary schedule: Assistant every day at 9:00 AM UTC, 3:00 AM Central (CST). */
export const DAILY_SUMMARY_SCHEDULE = {
  description: 'Daily summary',
  agentName: 'assistant',
  input: 'Summarize yesterday’s chats and open reviews.',
  spec: '0 9 * * *',
  timeZone: 'UTC',
} as const;

/**
 * The "Look up order 4468" chat with Tool runner, on Oct 30 (RunDetail): what you ask, and the title
 * the chat and its run go by.
 */
export const LOOK_UP_4468_CHAT = {
  threadId: 'sample-chat-order-4468',
  agent: 'tool-runner',
  message: 'Can you look up order 4468?',
  title: 'Look up order 4468',
} as const;

/** A goal of the sample world (PageGoals): its agent, prompt, check and attempts. */
export interface SampleWorldGoal {
  /** The idempotency key it is created under, which fixes its id. */
  readonly key: string;
  /** Its name, which titles it. */
  readonly name: string;
  readonly agentName: string;
  readonly prompt: string;
  /** The check, one of {@link SHOWCASE_GOAL_CHECKS}. */
  readonly check: { readonly name: string; readonly version: string };
  readonly maximumAttempts: number;
}

/** The three goals of the sample world, in the order they started on Oct 30. */
export const SAMPLE_WORLD_GOALS = {
  sayHello: {
    key: 'sample-goal-say-hello',
    name: 'Say hello',
    agentName: 'assistant',
    prompt: 'Say hello to me.',
    check: SHOWCASE_GOAL_CHECKS.sayHello,
    maximumAttempts: 1,
  },
  draftReleaseNotes: {
    key: 'sample-goal-draft-release-notes',
    name: 'Draft release notes',
    agentName: 'assistant',
    prompt:
      'Draft release notes from the pull requests merged since the last release. Group them as fixes, features and chores. Keep the notes under 200 words, write in plain language, and be sure to mention the staging fix, which changed how releases are checked before they go out.',
    check: SHOWCASE_GOAL_CHECKS.stagingFix,
    maximumAttempts: 5,
  },
  summarizeRefunds: {
    key: 'sample-goal-summarize-open-refunds',
    name: 'Summarize open refunds',
    agentName: 'tool-runner',
    prompt: 'Summarize open refunds. List every refund that is waiting for approval and say why.',
    check: SHOWCASE_GOAL_CHECKS.waitingRefunds,
    maximumAttempts: 5,
  },
} as const satisfies Record<string, SampleWorldGoal>;

/** A hook of the sample world (PageHooks), as `bureau.hooks.create` takes it. */
export interface SampleWorldHook {
  readonly name: string;
  readonly events: readonly string[];
  readonly action:
    | { readonly type: 'webhook'; readonly url: string }
    | { readonly type: 'notify'; readonly title?: string };
  readonly scope?: { readonly kind: 'agent' | 'workflow' | 'schedule'; readonly id: string };
}

/**
 * The five hooks of the sample world. The first four are made on Oct 21 and stay on; Refund audit
 * is made on Oct 30, sent a test event and turned off. Webhooks deliver through the showcase's
 * own fetch (`showcaseHookFetch`), so none reaches the address it names.
 */
export const SAMPLE_WORLD_HOOKS = {
  pageOnCall: {
    name: 'Page on-call when a run fails',
    events: ['schedule.failed'],
    action: { type: 'webhook', url: 'https://events.pagerduty.com/v2/enqueue' },
  },
  notifySlack: {
    name: 'Notify Slack when a review is waiting',
    events: ['review.requested'],
    action: {
      type: 'webhook',
      url: 'https://hooks.slack.com/services/T0SAMPLE/B0SAMPLE/sampleworldhook',
    },
  },
  triageFinishes: {
    name: 'Tell me when triage finishes',
    events: ['schedule.completed'],
    action: { type: 'notify' },
    scope: { kind: 'workflow', id: 'triage-inbox' },
  },
  scheduleMisses: {
    name: 'Tell me when a schedule misses',
    events: ['schedule.missed'],
    action: { type: 'notify' },
  },
  refundAudit: {
    name: 'Refund audit',
    events: ['review.approved'],
    action: { type: 'webhook', url: 'https://audit.example.com/refunds' },
    scope: { kind: 'agent', id: 'tool-runner' },
  },
} as const satisfies Record<string, SampleWorldHook>;

/** The storage size the host reports at 9:05 AM on Nov 2: 1.6 GB. */
export const SAMPLE_WORLD_STORAGE_BYTES = Math.round(1.6 * 1024 ** 3);

/** A workflow file's document without its `name`, which is what `bureau.workflows.*` takes. */
type Definition = Record<string, unknown>;

/** The document of `file`, without `name`. */
function definitionOf(file: ShowcaseWorkflowFile): Definition {
  const { name: _name, ...definition } = JSON.parse(file.text) as Definition;
  return definition;
}

/** `definition` with step `index`'s message (an agent step's `input.message`) replaced. */
function withStepMessage(definition: Definition, index: number, message: string): Definition {
  const steps = (definition['steps'] as Definition[]).map((step, at) =>
    at === index ? { ...step, input: { ...(step['input'] as Definition), message } } : step,
  );
  return { ...definition, steps };
}

/**
 * Release notes' four versions, oldest first (PageWorkflow, "History tab"): 1.0.0 with three steps
 * and a `branch` input; 1.1.0 changes step 2's message and adds the `since` input (breaking, since
 * the input changed); 1.2.0 adds the approval step (compatible); 1.3.0 rewords step 2 in the builder
 * (compatible), and is the file the Code tab shows.
 */
export function releaseNotesVersions(): readonly Definition[] {
  const current = definitionOf(SHOWCASE_RELEASE_NOTES_FILE);
  const version3 = withStepMessage(
    current,
    1,
    'Collect the changes merged since the last release, or since the date given.',
  );
  const steps = current['steps'] as Definition[];
  const version2 = { ...version3, steps: (version3['steps'] as Definition[]).slice(0, 3) };
  const inputSchema = current['inputSchema'] as Definition;
  const { since: _since, ...branchOnly } = inputSchema['properties'] as Definition;
  const version1 = withStepMessage(
    { ...version2, inputSchema: { ...inputSchema, properties: branchOnly } },
    1,
    'Collect the changes merged into the branch.',
  );
  if (steps.length !== 4) throw new Error('Release notes is expected to have four steps.');
  return [version1, version2, version3, current];
}

/** The hash a workflow file holds now, which an update must name. */
async function workflowHash(context: SessionContext, id: string): Promise<string> {
  const found = await bureauCall<{ hash: string }>(context.host, 'bureau.workflows.get', { id });
  return found.hash;
}

/** How a workflow save is made: whether it creates the file, and from the builder (`web`) or not. */
interface SaveOptions {
  readonly create?: boolean;
  readonly surface?: 'web';
}

/** Saves `definition` as workflow `id`'s next version. */
async function saveWorkflow(
  context: SessionContext,
  id: string,
  definition: Definition,
  { create = false, surface }: SaveOptions = {},
): Promise<void> {
  const how = surface === undefined ? {} : { surface };
  if (create) {
    await bureauCall(context.host, 'bureau.workflows.create', { id, definition, ...how });
    return;
  }
  await bureauCall(context.host, 'bureau.workflows.update', {
    id,
    expectedHash: await workflowHash(context, id),
    definition,
    ...how,
  });
}

/** Creates `hook`, and answers its id. */
async function createHook(context: SessionContext, hook: SampleWorldHook): Promise<string> {
  const created = await bureauCall<{ id: string }>(context.host, 'bureau.hooks.create', {
    name: hook.name,
    events: hook.events,
    action: hook.action,
    ...(hook.scope === undefined ? {} : { scope: hook.scope }),
  });
  return created.id;
}

/**
 * Oct 21: Release notes 1.0.0 and 1.1.0, then paused, so the Friday schedule its file defines
 * misses no Friday before its approval step is written; the four hooks that stay on; and the GitHub
 * source (`github-stub-mcp.ts`), with Delete branch left off.
 */
export async function october21(context: SessionContext): Promise<void> {
  const { runtime } = context;
  const times = SAMPLE_WORLD_HISTORY_TIMES;
  const [version1, version2] = releaseNotesVersions();
  runtime.setTime(times.releaseNotesVersion1);
  await saveWorkflow(context, 'release-notes', version1 ?? {}, { create: true });
  runtime.setTime(times.releaseNotesVersion2);
  await saveWorkflow(context, 'release-notes', version2 ?? {});
  runtime.setTime(times.releaseNotesPaused);
  await saveWorkflow(context, 'release-notes', { ...version2, paused: true });

  runtime.setTime(times.hooksCreated);
  const { pageOnCall, notifySlack, triageFinishes, scheduleMisses } = SAMPLE_WORLD_HOOKS;
  for (const hook of [pageOnCall, notifySlack, triageFinishes, scheduleMisses]) {
    await createHook(context, hook);
  }

  runtime.setTime(times.gitHubConnected);
  const toolSources = await context.host.toolSources.snapshot();
  await hostRequest(context.host, 'PUT', `/host/tool-sources/${GITHUB_SOURCE_ID}`, {
    source: {
      id: GITHUB_SOURCE_ID,
      kind: 'mcp',
      transport: {
        type: 'stdio',
        command: process.execPath,
        args: [join(import.meta.dir, 'github-stub-mcp.ts')],
      },
    },
    tools: { delete_branch: { enabled: false } },
    operationId: crypto.randomUUID(),
    expectedRevision: toolSources.configurationRevision,
  });
}

/** Whether `run` is a run of the workflow `id`, as its type names it. */
function runOfWorkflow(id: string): (run: EngineRun) => boolean {
  return (run) => run.type === id || run.type.startsWith(`${id}@`) || run.type.endsWith(`:${id}`);
}

/**
 * Paces Assistant through a workflow's agent steps: step `n` (from zero, in the order Assistant is
 * asked) takes `seconds[n]` seconds.
 */
function pacedSteps(context: SessionContext, seconds: readonly number[]): void {
  let step = 0;
  context.director.scene = {
    assistant: () => {
      context.runtime.advance((seconds[step] ?? 0) * 1000);
      step += 1;
    },
  };
}

/** At `at`, waits for the schedule due then to start `workflow` and for that run to end. */
async function scheduledRun(
  context: SessionContext,
  workflow: string,
  at: number,
  runsBefore: number,
): Promise<void> {
  context.runtime.setTime(at);
  await waitForSettledRuns(
    context.host,
    runOfWorkflow(workflow),
    runsBefore + 1,
    `the scheduled run of ${workflow}`,
  );
  context.director.scene = {};
}

/** Oct 23, from 7:58 AM: Triage inbox is written, and at 8:00 AM Inbox triage starts it (38 s). */
export async function october23(context: SessionContext): Promise<void> {
  const times = SAMPLE_WORLD_HISTORY_TIMES;
  context.runtime.setTime(times.triageCreated);
  await saveWorkflow(
    context,
    'triage-inbox',
    { ...definitionOf(SHOWCASE_TRIAGE_INBOX_FILE), paused: false },
    { create: true },
  );
  pacedSteps(context, [12, 13, 13]);
  await scheduledRun(context, 'triage-inbox', times.triageFirstRun, 0);
}

/** Oct 24, 8:00 AM: Inbox triage starts Triage inbox again (41 s); then you pause Triage inbox. */
export async function october24(context: SessionContext): Promise<void> {
  const times = SAMPLE_WORLD_HISTORY_TIMES;
  pacedSteps(context, [13, 14, 14]);
  await scheduledRun(context, 'triage-inbox', times.triageSecondRun, 1);
  context.runtime.setTime(times.triagePaused);
  await saveWorkflow(context, 'triage-inbox', definitionOf(SHOWCASE_TRIAGE_INBOX_FILE));
}

/** Oct 29, 9:15 AM: Release notes 1.2.0 adds the approval step, and is no longer paused. */
export async function october29Morning(context: SessionContext): Promise<void> {
  context.runtime.setTime(SAMPLE_WORLD_HISTORY_TIMES.releaseNotesVersion3);
  await saveWorkflow(context, 'release-notes', releaseNotesVersions()[2] ?? {});
}

/** A goal as `bureau.goals.get` shows it. */
type GoalView = { readonly goalRunId: string; readonly status: string };

/** The statuses a goal ends in. */
const GOAL_ENDED = new Set(['succeeded', 'exhausted', 'canceled', 'failed']);

/** Starts `goal`, and answers its id. */
async function startGoal(context: SessionContext, goal: SampleWorldGoal): Promise<string> {
  const created = await bureauCall<{ goal: GoalView }>(context.host, 'bureau.goals.create', {
    idempotencyKey: goal.key,
    agentName: goal.agentName,
    prompt: goal.prompt,
    identity: { name: goal.name, version: '1' },
    validator: { name: goal.check.name, version: goal.check.version },
    bounds: { maximumAttempts: goal.maximumAttempts, maximumTotalDurationMs: 3_600_000 },
    retryPolicy: { retryOn: ['validator-fail-retryable'] },
  });
  return created.goal.goalRunId;
}

/** The status of the goal `goalRunId`. */
async function goalStatus(context: SessionContext, goalRunId: string): Promise<string> {
  const found = await bureauCall<GoalView>(context.host, 'bureau.goals.get', { goalRunId });
  return found.status;
}

/** Waits until the goal `goalRunId` has ended, and clears the scene. */
async function goalEnded(context: SessionContext, goalRunId: string): Promise<void> {
  await waitUntil(async () => GOAL_ENDED.has(await goalStatus(context, goalRunId)), {
    message: `the goal ${goalRunId} to end`,
  });
  context.director.scene = {};
}

/** 7:48 AM: Say hello, met on its one attempt (8 s). */
async function sayHelloGoal(context: SessionContext): Promise<void> {
  context.runtime.setTime(SAMPLE_WORLD_HISTORY_TIMES.sayHelloGoal);
  pacedSteps(context, [SAMPLE_WORLD_DURATIONS.sayHelloGoal]);
  await goalEnded(context, await startGoal(context, SAMPLE_WORLD_GOALS.sayHello));
}

/**
 * From 8:13 AM: Draft release notes, whose five attempts start two minutes apart and never mention
 * the staging fix, so it gives up.
 */
async function draftReleaseNotesGoal(context: SessionContext): Promise<void> {
  const start = SAMPLE_WORLD_HISTORY_TIMES.draftReleaseNotesGoal;
  const { runtime, director } = context;
  runtime.setTime(start);
  pacedSteps(context, SAMPLE_WORLD_DURATIONS.draftReleaseNotesAttempts);
  director.scene = {
    ...director.scene,
    // Each check that misses starts the next attempt two minutes after the one it judged; the last
    // ends the goal where its attempt ended.
    check: ({ attemptIndex }) => {
      if (attemptIndex + 1 < SAMPLE_WORLD_GOALS.draftReleaseNotes.maximumAttempts) {
        runtime.setTime(start + (attemptIndex + 1) * 120_000);
      }
    },
  };
  await goalEnded(context, await startGoal(context, SAMPLE_WORLD_GOALS.draftReleaseNotes));
}

/**
 * From 10:05 AM: Summarize open refunds. Its first attempt misses the check after 2 min 5 s; the
 * second starts at 10:07 AM and is still answering when you stop the goal at 10:08 AM.
 */
async function summarizeRefundsGoal(context: SessionContext): Promise<void> {
  const times = SAMPLE_WORLD_HISTORY_TIMES;
  const { runtime, director } = context;
  const secondAnswering = Promise.withResolvers<void>();
  let attempt = 0;
  runtime.setTime(times.summarizeRefundsGoal);
  director.scene = {
    toolRunner: async ({ step, signal }) => {
      if (step !== 'answer') return;
      attempt += 1;
      if (attempt === 1) {
        runtime.advance(SAMPLE_WORLD_DURATIONS.summarizeRefundsFirstAttempt * 1000);
        return;
      }
      secondAnswering.resolve();
      await new Promise<never>((_resolve, reject) => {
        if (signal === undefined) return;
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
    check: () => runtime.setTime(times.summarizeRefundsSecondAttempt),
  };
  const goalRunId = await startGoal(context, SAMPLE_WORLD_GOALS.summarizeRefunds);
  await secondAnswering.promise;
  runtime.setTime(times.summarizeRefundsStopped);
  await bureauCall(context.host, 'bureau.goals.cancel', { goalRunId });
  await goalEnded(context, goalRunId);
}

/** 10:20 AM: the Refund audit hook, sent a test event, then turned off. */
async function refundAuditHook(context: SessionContext): Promise<void> {
  context.runtime.setTime(SAMPLE_WORLD_HISTORY_TIMES.refundAuditTested);
  const hookId = await createHook(context, SAMPLE_WORLD_HOOKS.refundAudit);
  await bureauCall(context.host, 'bureau.hooks.test', { hookId });
  await bureauCall(context.host, 'bureau.hooks.update', { hookId, enabled: false });
}

/**
 * 11:00 AM: the Release notes digest starts Release notes, which fails at step 2 after 3 s because
 * GitHub didn't answer: step 1 takes a second, and step 2 two before it fails.
 */
async function releaseNotesFails(context: SessionContext): Promise<void> {
  const { runtime, director } = context;
  director.scene = {
    assistant: ({ request }) => {
      if (request.startsWith('Find the most recent release')) runtime.advance(1000);
      if (request.startsWith('Collect the changes merged')) {
        runtime.advance(2000);
        throw new Error(RELEASE_NOTES_FAILURE);
      }
    },
  };
  await scheduledRun(context, 'release-notes', SAMPLE_WORLD_HISTORY_TIMES.releaseNotesFailed, 0);
}

/**
 * 11:20 AM: you ask Tool runner to look up order 4468; Lookup order answers 0.4 s in, and Tool
 * runner replies 23 s after you asked (RunDetail). Tool runner remembers its reply, as it does
 * every answer, and at 11:21 AM you forget that memory, so the Memory page lists only the four
 * PageMemory draws.
 */
async function lookUp4468(context: SessionContext): Promise<void> {
  const { host, runtime, director } = context;
  const times = SAMPLE_WORLD_HISTORY_TIMES;
  runtime.setTime(times.lookUp4468);
  director.scene = {
    toolRunner: ({ step }) => runtime.advance(step === 'lookup' ? 400 : 22_600),
  };
  const chat = LOOK_UP_4468_CHAT;
  await sendChatMessage(host, chat.agent, chat.threadId, chat.message);
  director.scene = {};
  await bureauCall(host, 'bureau.contexts.rename', { contextId: chat.threadId, title: chat.title });

  runtime.setTime(times.lookUp4468Forgotten);
  const { memories } = await bureauCall<{ memories: Array<{ id: string; sessionId?: string }> }>(
    host,
    'bureau.memory.list',
    { agentId: chat.agent, limit: 100 },
  );
  for (const memory of memories.filter((entry) => entry.sessionId === chat.threadId)) {
    await bureauCall(host, 'bureau.memory.forget', { agentId: chat.agent, id: memory.id });
  }
}

/** Oct 30, from 7:48 AM to 11:20 AM: the goals, the Refund audit hook, the failure, and 4468. */
export async function october30(context: SessionContext): Promise<void> {
  await sayHelloGoal(context);
  await draftReleaseNotesGoal(context);
  await summarizeRefundsGoal(context);
  await refundAuditHook(context);
  await releaseNotesFails(context);
  await lookUp4468(context);
}

/** Nov 1, 4:30 PM: Release notes 1.3.0 in the builder; 4:35 PM: Order refund, last whole. */
export async function november1Afternoon(context: SessionContext): Promise<void> {
  const times = SAMPLE_WORLD_HISTORY_TIMES;
  context.runtime.setTime(times.releaseNotesVersion4);
  await saveWorkflow(context, 'release-notes', releaseNotesVersions()[3] ?? {}, { surface: 'web' });
  context.runtime.setTime(times.orderRefundSaved);
  await saveWorkflow(context, 'order-refund', definitionOf(SHOWCASE_ORDER_REFUND_VALID_FILE), {
    create: true,
  });
}

/** Oct 28, 9:00 AM: you create the Daily summary schedule. */
export async function october28(context: SessionContext): Promise<void> {
  context.runtime.setTime(SAMPLE_WORLD_HISTORY_TIMES.dailySummaryCreated);
  await bureauCall(context.host, 'bureau.schedules.create', { ...DAILY_SUMMARY_SCHEDULE });
}

/** Whether `run` is a fire of an agent schedule: a run of the built-in chat workflow a schedule started. */
function isScheduleFire(run: EngineRun): boolean {
  return run.type === 'agentRun' && (run.tags ?? []).includes('origin:schedule');
}

/** Oct 29, 4:00 AM: Daily summary comes due and Assistant answers it (14 s). */
export async function october29DailySummary(context: SessionContext): Promise<void> {
  const { runtime, director } = context;
  director.scene = {
    assistant: () => runtime.advance(SAMPLE_WORLD_DURATIONS.dailySummary * 1000),
  };
  runtime.setTime(SAMPLE_WORLD_HISTORY_TIMES.dailySummaryRan);
  await waitForSettledRuns(context.host, isScheduleFire, 1, 'the Daily summary fire');
  director.scene = {};
}

/**
 * Writes the workflow files as the sample world keeps them, with no host running: Release notes and
 * Triage inbox byte for byte as their Code tabs show them (the same content as their newest
 * versions, so no version is added), and Order refund broken by the missing comma on line 11.
 */
export async function writeFinalWorkflowFiles(home: string): Promise<void> {
  const directory = join(home, WORKFLOW_DIRECTORY_NAME);
  for (const file of [
    SHOWCASE_RELEASE_NOTES_FILE,
    SHOWCASE_TRIAGE_INBOX_FILE,
    SHOWCASE_ORDER_REFUND_FILE,
  ]) {
    await writeFile(join(directory, `${file.id}.json`), file.text);
  }
}

/**
 * Nov 2, 9:00 AM: the server starts and its scheduler finds the four Daily summary occurrences it
 * missed while it was off (Oct 30, Oct 31, Nov 1 and Nov 2 at 9:00 AM UTC), and logs them, with the
 * schedule tick that records it. This waits until that tick has run.
 */
export async function missedRunsLogged(context: SessionContext): Promise<void> {
  await waitForSettledRuns(
    context.host,
    (run) => run.id.startsWith('schedule-tick:missed-runs:'),
    1,
    'the missed Daily summary runs to be logged',
  );
}

/** Nov 2, 9:05 AM: the host's storage reports 1.6 GB, and the storage alert fires. */
export function storageAlertFires(context: SessionContext): void {
  const engine = context.host.bureau.durableEngine();
  if (engine === undefined) throw new Error('The host composed no durable engine.');
  context.runtime.setTime(SAMPLE_WORLD_HISTORY_TIMES.storageAlertFired);
  engine.dispatchEvent(new StorageSizeReportedEvent(SAMPLE_WORLD_STORAGE_BYTES));
}
