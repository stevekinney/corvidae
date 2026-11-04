/**
 * The identifiers of the sample world's records (`sample-world-seed.ts`), read from a seeded host
 * over HTTP as the local caller, so a page can be opened on each: the end-to-end showcase
 * specification (`tests/e2e/showcase-routes.ts`) fills its addresses from them. The chats and
 * workflows have fixed identifiers; the rest are read from the Bureau's lists.
 *
 * @module sample-world-records
 */

import { GITHUB_SOURCE_ID } from './github-stub-mcp.ts';
import {
  LOOK_UP_4468_CHAT,
  SAMPLE_WORLD_GOALS,
  SAMPLE_WORLD_HOOKS,
} from './sample-world-history.ts';

/** The chats of the sample world, by the thread each lives in. */
export const SAMPLE_WORLD_THREADS = {
  refund: 'sample-chat-refunds',
  release: 'sample-chat-release-notes-fix',
  sayHello: 'sample-chat-say-hello',
  lookUp4468: LOOK_UP_4468_CHAT.threadId,
  billing: 'sample-chat-billing-tables',
} as const;

/** The identifiers a page of the sample world is opened on. */
export interface SampleWorldRecords {
  /** Each chat's thread. */
  readonly chats: Readonly<Record<keyof typeof SAMPLE_WORLD_THREADS, string>>;
  /** The agent with the versions, memories and hooks: Tool runner. */
  readonly agent: string;
  /** Tool runner's corrected memory. */
  readonly memory: string;
  /** The three workflow files. */
  readonly workflows: {
    readonly releaseNotes: string;
    readonly triageInbox: string;
    readonly orderRefund: string;
  };
  /** A run in each state the sample world holds. */
  readonly runs: {
    /** Release notes' Oct 30 run, which failed at step 2. */
    readonly failed: string;
    /** The order 4468 lookup, done. */
    readonly done: string;
    /** The order 4471 refund, waiting on you. */
    readonly waiting: string;
    /** Summarize open refunds' second attempt, canceled. */
    readonly canceled: string;
  };
  /** The four schedules, by name. */
  readonly schedules: {
    readonly dailySummary: string;
    readonly inboxTriage: string;
    readonly releaseNotesDigest: string;
    readonly weeklyRefundAudit: string;
  };
  /** The three goals. */
  readonly goals: {
    readonly sayHello: string;
    readonly draftReleaseNotes: string;
    readonly summarizeRefunds: string;
  };
  /** The five hooks, by their keys in {@link SAMPLE_WORLD_HOOKS}. */
  readonly hooks: Readonly<Record<keyof typeof SAMPLE_WORLD_HOOKS, string>>;
  /** The review key (`bureau:<id>`) of the 4471 refund waiting on you, and of the 4472 one you approved. */
  readonly reviews: { readonly waiting: string; readonly decided: string };
  /** The tool source: GitHub. */
  readonly toolSource: string;
}

/** One JSON-RPC call to the Bureau plane at `origin`, as the local caller. */
async function call<T>(origin: string, method: string, params: Record<string, unknown>) {
  const response = await fetch(new URL('/bureau/jsonrpc', origin), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params }),
  });
  const body = (await response.json()) as { result?: T; error?: unknown };
  if (body.result === undefined) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

/** The value `pick` finds in `rows`, or a thrown error naming `what`. */
function found<T, V>(rows: readonly T[], pick: (row: T) => V | undefined, what: string): V {
  for (const row of rows) {
    const value = pick(row);
    if (value !== undefined) return value;
  }
  throw new Error(`The sample world holds no ${what}.`);
}

/** Reads the identifiers of the sample world's records from the host at `origin`. */
export async function readSampleWorldRecords(origin: string): Promise<SampleWorldRecords> {
  type Row = { id: string; description?: string | null; name?: string | null };
  const [schedules, goals, hooks, memories, pending, resolved, releaseRuns, tasks] =
    await Promise.all([
      call<{ schedules: Row[] }>(origin, 'bureau.schedules.list', { limit: 100 }),
      call<{ goals: Array<{ goalRunId: string; attempts: Array<{ runId?: string }> }> }>(
        origin,
        'bureau.goals.list',
        {},
      ),
      call<{ hooks: Row[] }>(origin, 'bureau.hooks.list', {}),
      call<{ memories: Array<{ id: string; content: string }> }>(origin, 'bureau.memory.list', {
        agentId: 'tool-runner',
        limit: 100,
      }),
      call<{ reviews: Array<{ id: string; sessionId?: string }> }>(
        origin,
        'bureau.reviews.list',
        {},
      ),
      call<{ reviews: Array<{ id: string; sessionId?: string }> }>(origin, 'bureau.reviews.list', {
        status: 'resolved',
      }),
      call<{ runs: Row[] }>(origin, 'bureau.workflows.runs.list', {
        workflow: 'release-notes',
        limit: 10,
      }),
      call<{ tasks: Array<{ id: string; contextId: string | null; status: string }> }>(
        origin,
        'bureau.tasks.list',
        { limit: 100 },
      ),
    ]);
  const schedule = (description: string) =>
    found(
      schedules.schedules,
      (row) => (row.description === description ? row.id : undefined),
      `${description} schedule`,
    );
  const goal = (key: string) =>
    found(
      goals.goals,
      (row) => (row.goalRunId.endsWith(key) ? row.goalRunId : undefined),
      `goal ${key}`,
    );
  const hook = (name: string) =>
    found(hooks.hooks, (row) => (row.name === name ? row.id : undefined), `hook ${name}`);
  const review = (rows: Array<{ id: string; sessionId?: string }>, what: string) =>
    `bureau:${found(rows, (row) => (row.sessionId === SAMPLE_WORLD_THREADS.refund ? row.id : undefined), what)}`;
  const summarize = goal(SAMPLE_WORLD_GOALS.summarizeRefunds.key);
  const summarizeAttempts = goals.goals.find((row) => row.goalRunId === summarize)?.attempts ?? [];
  return {
    chats: SAMPLE_WORLD_THREADS,
    agent: 'tool-runner',
    memory: found(
      memories.memories,
      (row) => (row.content.includes('by email, not by phone') ? row.id : undefined),
      'corrected memory',
    ),
    workflows: {
      releaseNotes: 'release-notes',
      triageInbox: 'triage-inbox',
      orderRefund: 'order-refund',
    },
    runs: {
      failed: found(releaseRuns.runs, (row) => row.id, 'Release notes run'),
      done: found(
        tasks.tasks,
        (row) => (row.contextId === SAMPLE_WORLD_THREADS.lookUp4468 ? row.id : undefined),
        'order 4468 run',
      ),
      waiting: found(
        tasks.tasks,
        (row) =>
          row.contextId === SAMPLE_WORLD_THREADS.refund && row.status === 'input-required'
            ? row.id
            : undefined,
        'order 4471 run',
      ),
      canceled: found(summarizeAttempts.slice(1), (row) => row.runId, 'canceled goal attempt'),
    },
    schedules: {
      dailySummary: schedule('Daily summary'),
      inboxTriage: schedule('Inbox triage'),
      releaseNotesDigest: schedule('Release notes digest'),
      weeklyRefundAudit: schedule('Weekly refund audit'),
    },
    goals: {
      sayHello: goal(SAMPLE_WORLD_GOALS.sayHello.key),
      draftReleaseNotes: goal(SAMPLE_WORLD_GOALS.draftReleaseNotes.key),
      summarizeRefunds: summarize,
    },
    hooks: {
      pageOnCall: hook(SAMPLE_WORLD_HOOKS.pageOnCall.name),
      notifySlack: hook(SAMPLE_WORLD_HOOKS.notifySlack.name),
      triageFinishes: hook(SAMPLE_WORLD_HOOKS.triageFinishes.name),
      scheduleMisses: hook(SAMPLE_WORLD_HOOKS.scheduleMisses.name),
      refundAudit: hook(SAMPLE_WORLD_HOOKS.refundAudit.name),
    },
    reviews: {
      waiting: review(pending.reviews, 'review waiting on you'),
      decided: review(resolved.reviews, 'decided review'),
    },
    toolSource: GITHUB_SOURCE_ID,
  };
}
