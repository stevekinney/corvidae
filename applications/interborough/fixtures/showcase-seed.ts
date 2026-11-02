/**
 * Believable content for a running Interborough host, so a design review sees every page with
 * a normal day's data in it (`showcase-content.ts` holds the words). Six agents (one with
 * memories), chats (a long one, tool calls, an approval waiting and two decided, a question
 * waiting, a picture attached, a run that failed), three agent-authored workflows with runs that
 * succeeded, failed, were cancelled and are still running, three schedules in three time zones
 * (one paused), two hooks (one delivery succeeded and one failed), two goals, and the audit entries
 * all of that leaves behind.
 *
 * The seed talks to the host over HTTP with plain `fetch`, as the uncredentialed local caller
 * (`anonymous:local`, `src/host/host.ts`), so the end-to-end showcase specification
 * (`tests/e2e/showcase.spec.ts`) and the development host (`bun run dev -- --showcase`) share it. It
 * imports nothing from Playwright. It needs the demo plugin on (its scripted agents answer the
 * chats) and a model provider that has the `anthropic/sonnet` and `anthropic/claude-haiku-4-5`
 * models (`src/host/stub-provider.ts`).
 *
 * Every record has a deterministic name and is looked for before it is created, so a second run
 * creates nothing. {@link removeShowcase} takes the records away again.
 *
 * @module showcase-seed
 */

import {
  SHOWCASE_AGENTS,
  SHOWCASE_CHAT_TITLES,
  SHOWCASE_CHATS,
  SHOWCASE_GOALS,
  SHOWCASE_HOOK_SECRET,
  SHOWCASE_HOOKS,
  SHOWCASE_REVIEW_INPUT,
  SHOWCASE_SCHEDULES,
  SHOWCASE_WORKFLOWS,
  type ShowcaseChat,
} from './showcase-content.ts';

/** What the seed made or found, by name, so a caller can open it and `removeShowcase` can take it away. */
export interface ShowcaseSeed {
  /** The identifier of every agent the seed defines. */
  readonly agents: readonly string[];
  /** The agent whose instructions are the longest, which the editor and the Instructions tab show. */
  readonly instructionsAgent: string;
  /** The agent that has memories, and the first of them. */
  readonly memoryAgent: string;
  readonly memory: string;
  /** Every memory the seed stored, to forget again. */
  readonly memories: readonly string[];
  /** The thread of each chat, by its key in `showcase-content.ts`. */
  readonly chats: Readonly<Record<string, string>>;
  /** The identifier of each workflow file. */
  readonly workflows: { readonly digest: string; readonly review: string; readonly sync: string };
  /** One run in each state the seed produces. */
  readonly runs: {
    readonly succeeded: string;
    readonly failed: string;
    readonly running: string;
    readonly cancelled: string;
  };
  /** The identifier of every schedule the seed holds, in the order of `SHOWCASE_SCHEDULES`. */
  readonly schedules: readonly string[];
  /** The identifier of every hook, in the order of `SHOWCASE_HOOKS`. */
  readonly hooks: readonly string[];
  /** The identifier of every goal, in the order of `SHOWCASE_GOALS`. */
  readonly goals: readonly string[];
  /** The key (`bureau:<id>`) of the review that waits, and of the one that was decided. */
  readonly reviews: { readonly waiting: string; readonly decided: string };
  /** What this call created, as `<kind> <name>`; empty when everything was already there. */
  readonly created: readonly string[];
}

/** One line saying what a seed holds and what the call that returned it created. */
export function describeShowcase(seed: ShowcaseSeed): string {
  const held =
    `${String(seed.agents.length)} agents, ${String(Object.keys(seed.chats).length)} chats, ` +
    `${String(Object.keys(seed.workflows).length)} workflows, ${String(seed.schedules.length)} schedules, ` +
    `${String(seed.hooks.length)} hooks, ${String(seed.goals.length)} goals`;
  return seed.created.length === 0
    ? `${held} (all there already, nothing created)`
    : `${held} (created ${String(seed.created.length)}: ${seed.created.join(', ')})`;
}

/** A fault the Bureau answered with. */
interface Fault {
  readonly code: string;
  readonly message: string;
}

/** A client of the host's two JSON-RPC planes and its AG-UI mount, as the local caller. */
class HostClient {
  private counter = 0;

  constructor(readonly origin: string) {}

  /** One JSON-RPC call to `path`; a fault comes back as `{ fault }` and a result as `{ result }`. */
  async attempt<T>(
    path: string,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<{ readonly result?: T; readonly fault?: Fault }> {
    this.counter += 1;
    const response = await fetch(`${this.origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: `showcase-${this.counter}`, method, params }),
    });
    const body = (await response.json()) as {
      result?: T;
      error?: { message?: string; data?: { weftCode?: string } };
    };
    if (body.error !== undefined) {
      return {
        fault: {
          code: body.error.data?.weftCode ?? 'unknown',
          message: body.error.message ?? 'no message',
        },
      };
    }
    return { result: body.result as T };
  }

  /** A Bureau call that must succeed. */
  async bureau<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const answer = await this.attempt<T>('/bureau/jsonrpc', method, params);
    if (answer.fault !== undefined) {
      throw new Error(`${method} answered ${answer.fault.code}: ${answer.fault.message}`);
    }
    return answer.result as T;
  }

  /** Starts a run and reads its stream to the end. A run that fails is still a finished stream. */
  async run(agent: string, threadId: string, content: unknown): Promise<string> {
    const response = await fetch(`${this.origin}/bureau/ag-ui/agents/${agent}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({
        threadId,
        runId: `run-${crypto.randomUUID()}`,
        messages: [{ id: `user-${crypto.randomUUID()}`, role: 'user', content }],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      }),
    });
    if (response.status !== 200) {
      throw new Error(`The run of ${agent} on ${threadId} answered ${String(response.status)}`);
    }
    return response.text();
  }

  /** The threads of the Bureau's chats whose identifier starts with `prefix`. */
  async chatsStartingWith(prefix: string): Promise<string[]> {
    const threads: string[] = [];
    for (let offset: number | null = 0; offset !== null;) {
      const page: { contexts: { id: string }[]; nextOffset: number | null } = await this.bureau(
        'bureau.contexts.list',
        { limit: 100, offset },
      );
      for (const context of page.contexts)
        if (context.id.startsWith(prefix)) threads.push(context.id);
      offset = page.nextOffset;
    }
    return threads;
  }
}

/** The thread a chat of `key` lives in, unless that thread was deleted and so can never be used again. */
function threadOf(key: string, attempt = 1): string {
  return attempt === 1 ? `showcase-chat-${key}` : `showcase-chat-${key}-${String(attempt)}`;
}

/** What a run's stream says when the thread it was sent to was deleted: the Bureau never reuses one. */
const THREAD_DELETED = 'THREAD_DELETED';

/** A 1 x 1 PNG: real bytes, so the Bureau detects its type. */
const PICTURE = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  ),
  (character) => character.charCodeAt(0),
);

/** Uploads the picture and answers its asset's identifier. */
async function uploadPicture(host: HostClient): Promise<string> {
  const upload = await host.bureau<{ uploadId: string }>('bureau.assets.uploads.create', {
    declaredByteLength: PICTURE.length,
    declaredMediaType: 'image/png',
  });
  await host.bureau('bureau.assets.uploads.append', {
    uploadId: upload.uploadId,
    chunk: btoa(String.fromCharCode(...PICTURE)),
  });
  const asset = await host.bureau<{ assetId: string }>('bureau.assets.uploads.complete', {
    uploadId: upload.uploadId,
  });
  return asset.assetId;
}

/** The attempts of a goal, each in a chat of its own. */
type GoalDetail = { attempts?: { sessionId: string }[] };

type AgentDetail = { hash: string | null; source: string };

/** Defines each agent that is missing, and stores each memory that is missing. */
async function seedAgents(host: HostClient, created: string[]): Promise<readonly string[]> {
  const memories: string[] = [];
  for (const agent of SHOWCASE_AGENTS) {
    const found = await host.attempt('/bureau/jsonrpc', 'bureau.agents.definitions.get', {
      id: agent.id,
    });
    if (found.fault !== undefined) {
      await host.bureau('bureau.agents.definitions.create', {
        id: agent.id,
        definition: { skillDescriptors: [], tools: [], ...agent.definition },
      });
      created.push(`agent ${agent.id}`);
    }
    if (agent.memories === undefined) continue;
    const stored = await host.bureau<{ memories: { id: string; content: string }[] }>(
      'bureau.memory.list',
      { agentId: agent.id, limit: 100 },
    );
    for (const content of agent.memories) {
      const held = stored.memories.find((memory) => memory.content === content);
      if (held !== undefined) {
        memories.push(held.id);
        continue;
      }
      const added = await host.bureau<{ memory: { id: string } }>('bureau.memory.remember', {
        agentId: agent.id,
        content,
      });
      memories.push(added.memory.id);
      created.push(`memory of ${agent.id}`);
    }
  }
  return memories;
}

/** The review a chat's run waits on, as the Bureau lists it. */
async function reviewOf(host: HostClient, threadId: string): Promise<string> {
  const listed = await host.bureau<{ reviews: { id: string; sessionId?: string }[] }>(
    'bureau.reviews.list',
    {},
  );
  const review = listed.reviews.find((entry) => entry.sessionId === threadId);
  if (review === undefined) throw new Error(`The chat ${threadId} is waiting on no review.`);
  return review.id;
}

/** A chat the seed holds: its thread, and whether this call started it. */
interface HeldChat {
  readonly threadId: string;
  readonly started: boolean;
}

/**
 * Finds the chat of `chat.key`, or starts it with a run for each of its messages, in order. The
 * Bureau never reuses a thread it deleted, so when the first run says its thread was deleted (a
 * host the seed was removed from and run on again) the chat starts on the next thread name.
 */
async function startChat(
  host: HostClient,
  chat: ShowcaseChat,
  created: string[],
  content: (message: string) => unknown = (message) => message,
): Promise<HeldChat> {
  const held = await host.chatsStartingWith(threadOf(chat.key));
  const [existing] = held.toSorted();
  if (existing !== undefined) return { threadId: existing, started: false };
  const [first, ...rest] = chat.messages;
  for (let attempt = 1; ; attempt += 1) {
    const threadId = threadOf(chat.key, attempt);
    const stream = await host.run(chat.agent, threadId, content(first ?? ''));
    if (stream.includes(THREAD_DELETED)) continue;
    for (const message of rest) await host.run(chat.agent, threadId, content(message));
    created.push(`chat ${chat.key}`);
    return { threadId, started: true };
  }
}

/** Makes every chat, and answers each thread by key, with the reviews of the waiting and decided approvals. */
async function seedChats(
  host: HostClient,
  created: string[],
): Promise<{ chats: Record<string, string>; waiting: string; decided: string }> {
  const chats = SHOWCASE_CHATS;
  const threads: Record<string, string> = {};
  const start = async (chat: ShowcaseChat, content?: (message: string) => unknown) => {
    const held = await startChat(host, chat, created, content);
    threads[chat.key] = held.threadId;
    return held;
  };
  await start(chats.release);
  const denied = await start(chats.refundDenied);
  if (denied.started) {
    await host.bureau('bureau.reviews.resolve', {
      id: await reviewOf(host, denied.threadId),
      decision: 'deny',
      reason: 'The customer was refunded by hand last week.',
      round: 0,
    });
  }
  const waiting = await start(chats.refundWaiting);
  const approved = await start(chats.refundApproved);
  if (approved.started) {
    await host.bureau('bureau.reviews.resolve', {
      id: await reviewOf(host, approved.threadId),
      decision: 'approve',
      round: 0,
    });
  }
  await start(chats.question);
  await start(chats.modelPicker);
  const pictureChats = await host.chatsStartingWith(threadOf(chats.attachment.key));
  const assetId = pictureChats.length === 0 ? await uploadPicture(host) : undefined;
  await start(chats.attachment, (message) =>
    assetId === undefined
      ? message
      : [
          { type: 'text', text: message },
          {
            type: 'image',
            mimeType: 'image/png',
            source: { type: 'file', provider: 'bureau', value: assetId },
          },
        ],
  );
  await start(chats.failed);
  for (const chat of Object.values(chats)) {
    const title = SHOWCASE_CHAT_TITLES[chat.key];
    if (title === undefined) continue;
    await host.bureau('bureau.contexts.rename', { contextId: threads[chat.key], title });
  }
  return {
    chats: threads,
    waiting: `bureau:${await reviewOf(host, waiting.threadId)}`,
    decided: `bureau:${await decidedReviewOf(host, approved.threadId)}`,
  };
}

/** The identifier of the review of `threadId` that was decided, found among the Bureau's decided reviews. */
async function decidedReviewOf(host: HostClient, threadId: string): Promise<string> {
  const listed = await host.bureau<{ reviews: { id: string; sessionId?: string }[] }>(
    'bureau.reviews.list',
    { status: 'resolved' },
  );
  const review = listed.reviews.find((entry) => entry.sessionId === threadId);
  if (review === undefined) throw new Error(`The chat ${threadId} has no decided review.`);
  return review.id;
}

/** A run of a workflow, as `bureau.workflows.runs.list` shows it. */
type RunSummary = { id: string; status: string };

/** Starts a run of `workflow` and answers its identifier. */
async function startRun(host: HostClient, workflow: string, input: unknown): Promise<string> {
  const started = await host.bureau<{ runId: string }>('bureau.workflows.start', {
    id: workflow,
    input,
  });
  return started.runId;
}

/** Writes the three workflow files that are missing, and starts their runs when none exist. */
async function seedWorkflows(host: HostClient, created: string[]): Promise<ShowcaseSeed['runs']> {
  const { digest, review, sync } = SHOWCASE_WORKFLOWS;
  for (const workflow of [digest, review, sync]) {
    const found = await host.attempt('/bureau/jsonrpc', 'bureau.workflows.get', {
      id: workflow.id,
    });
    if (found.fault === undefined) continue;
    await host.bureau('bureau.workflows.create', {
      id: workflow.id,
      definition: workflow.definition,
    });
    created.push(`workflow ${workflow.id}`);
  }
  const runsOf = async (id: string): Promise<RunSummary[]> => {
    const listed = await host.bureau<{ runs: RunSummary[] }>('bureau.workflows.runs.list', {
      workflow: id,
      limit: 100,
    });
    return listed.runs;
  };
  const find = (runs: RunSummary[], status: string): string | undefined =>
    runs.find((run) => run.status === status)?.id;

  let digestRuns = await runsOf(digest.id);
  if (digestRuns.length === 0) {
    await startRun(host, digest.id, null);
    await startRun(host, digest.id, null);
    created.push(`runs of ${digest.id}`);
    digestRuns = await runsOf(digest.id);
  }
  let reviewRuns = await runsOf(review.id);
  if (reviewRuns.length === 0) {
    // The first run is cancelled while it waits for its sign-off; the second is left waiting.
    const first = await startRun(host, review.id, SHOWCASE_REVIEW_INPUT);
    const cancelled = await host.attempt('/jsonrpc', 'weft.workflows.cancel', {
      workflowId: first,
    });
    if (cancelled.fault !== undefined) {
      throw new Error(`Cancelling ${first} answered ${cancelled.fault.message}`);
    }
    await startRun(host, review.id, SHOWCASE_REVIEW_INPUT);
    created.push(`runs of ${review.id}`);
    reviewRuns = await runsOf(review.id);
  }
  let syncRuns = await runsOf(sync.id);
  if (syncRuns.length === 0) {
    await startRun(host, sync.id, null);
    created.push(`runs of ${sync.id}`);
    syncRuns = await runsOf(sync.id);
  }
  return {
    succeeded: find(digestRuns, 'completed') ?? digestRuns[0]?.id ?? '',
    failed: find(syncRuns, 'failed') ?? syncRuns[0]?.id ?? '',
    running: find(reviewRuns, 'running') ?? reviewRuns[0]?.id ?? '',
    cancelled: find(reviewRuns, 'cancelled') ?? reviewRuns.at(-1)?.id ?? '',
  };
}

type ScheduleSummary = { id: string; description: string | null; status: string };

/** Creates the schedules that are missing, pausing the one that is paused. */
async function seedSchedules(host: HostClient, created: string[]): Promise<string[]> {
  const listed = await host.bureau<{ schedules: ScheduleSummary[] }>('bureau.schedules.list', {
    limit: 100,
  });
  const ids: string[] = [];
  for (const schedule of SHOWCASE_SCHEDULES) {
    const held = listed.schedules.find(
      (entry) => entry.description === schedule.description && entry.status !== 'cancelled',
    );
    if (held !== undefined) {
      ids.push(held.id);
      continue;
    }
    const made = await host.bureau<{ id: string }>('bureau.schedules.create', {
      agentName: schedule.agentName,
      description: schedule.description,
      input: schedule.input,
      spec: schedule.spec,
      timeZone: schedule.timeZone,
    });
    if (schedule.paused) await host.bureau('bureau.schedules.pause', { scheduleId: made.id });
    ids.push(made.id);
    created.push(`schedule ${schedule.key}`);
  }
  return ids;
}

/**
 * Creates the hooks that are missing. Each posts to a listener this call starts and stops, so one
 * test delivery succeeds against it and the other (to a path that answers 503) fails.
 */
async function seedHooks(host: HostClient, created: string[]): Promise<string[]> {
  const listed = await host.bureau<{ hooks: { id: string; name: string | null }[] }>(
    'bureau.hooks.list',
    {},
  );
  const ids: string[] = [];
  const missing = SHOWCASE_HOOKS.filter((hook) => !listed.hooks.some((h) => h.name === hook.name));
  const listener =
    missing.length === 0
      ? undefined
      : Bun.serve({
          hostname: '127.0.0.1',
          port: 0,
          fetch: (request) =>
            new URL(request.url).pathname === '/outage'
              ? new Response('The service is down for maintenance.', { status: 503 })
              : new Response('ok'),
        });
  try {
    for (const hook of SHOWCASE_HOOKS) {
      const held = listed.hooks.find((entry) => entry.name === hook.name);
      if (held !== undefined) {
        ids.push(held.id);
        continue;
      }
      const made = await host.bureau<{ id: string }>('bureau.hooks.create', {
        name: hook.name,
        events: hook.events,
        action: { type: 'webhook', url: `http://127.0.0.1:${String(listener?.port)}${hook.path}` },
        signingSecret: SHOWCASE_HOOK_SECRET,
      });
      await host.bureau('bureau.hooks.test', { hookId: made.id });
      ids.push(made.id);
      created.push(`hook ${hook.key}`);
    }
  } finally {
    await listener?.stop(true);
  }
  return ids;
}

/** Creates the goals that are missing: the same key is the same goal, so a repeat answers `existing`. */
async function seedGoals(host: HostClient, created: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const goal of SHOWCASE_GOALS) {
    const made = await host.bureau<{ outcome: string; goal: { goalRunId: string } }>(
      'bureau.goals.create',
      {
        agentName: goal.agentName,
        prompt: goal.prompt,
        identity: goal.identity,
        validator: { name: `demo:${goal.validator}`, version: '1' },
        bounds: goal.bounds,
        idempotencyKey: goal.key,
      },
    );
    ids.push(made.goal.goalRunId);
    if (made.outcome !== 'existing') created.push(`goal ${goal.key}`);
  }
  return ids;
}

/**
 * Fills the host at `baseUrl` with the showcase content, creating only what is missing, and
 * answers what it holds. The host must be running with the demo plugin on and a model provider that
 * offers the models the agents name.
 */
export async function seedShowcase(baseUrl: string): Promise<ShowcaseSeed> {
  const host = new HostClient(baseUrl.replace(/\/+$/, ''));
  const created: string[] = [];
  const memories = await seedAgents(host, created);
  const chats = await seedChats(host, created);
  const runs = await seedWorkflows(host, created);
  const schedules = await seedSchedules(host, created);
  const goals = await seedGoals(host, created);
  // Last, so no event the seed itself causes is delivered to a listener that has gone by then.
  const hooks = await seedHooks(host, created);
  const memoryAgent = SHOWCASE_AGENTS.find((agent) => agent.memories !== undefined);
  return {
    agents: SHOWCASE_AGENTS.map((agent) => agent.id),
    instructionsAgent: 'support-triage',
    memoryAgent: memoryAgent?.id ?? '',
    memory: memories[0] ?? '',
    memories,
    chats: chats.chats,
    workflows: {
      digest: SHOWCASE_WORKFLOWS.digest.id,
      review: SHOWCASE_WORKFLOWS.review.id,
      sync: SHOWCASE_WORKFLOWS.sync.id,
    },
    runs,
    schedules,
    hooks,
    goals,
    reviews: { waiting: chats.waiting, decided: chats.decided },
    created,
  };
}

/** Runs `work` and ignores a fault, because the record it removes may already be gone. */
async function ignoringFault(work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('answered')) throw error;
  }
}

/**
 * Removes what {@link seedShowcase} made: the chats, hooks, goals (cancelled, because a goal cannot
 * be deleted), schedules, memories, workflow files and agent files. A record that is already gone
 * is not an error.
 */
export async function removeShowcase(baseUrl: string, seed: ShowcaseSeed): Promise<void> {
  const host = new HostClient(baseUrl.replace(/\/+$/, ''));
  for (const threadId of Object.values(seed.chats)) {
    await ignoringFault(() => host.bureau('bureau.contexts.delete', { contextId: threadId }));
  }
  for (const hookId of seed.hooks) {
    await ignoringFault(() => host.bureau('bureau.hooks.delete', { hookId }));
  }
  for (const goalRunId of seed.goals) {
    await ignoringFault(() => host.bureau('bureau.goals.cancel', { goalRunId }));
    // Each attempt of a goal runs in a chat of its own, which outlives the goal.
    const goal = await host.attempt<{ goal?: GoalDetail } & GoalDetail>(
      '/bureau/jsonrpc',
      'bureau.goals.get',
      { goalRunId },
    );
    const attempts = goal.result?.goal?.attempts ?? goal.result?.attempts ?? [];
    for (const { sessionId } of attempts) {
      await ignoringFault(() => host.bureau('bureau.contexts.delete', { contextId: sessionId }));
    }
  }
  for (const scheduleId of seed.schedules) {
    await ignoringFault(() => host.bureau('bureau.schedules.cancel', { scheduleId }));
  }
  for (const id of seed.memories) {
    await ignoringFault(() =>
      host.bureau('bureau.memory.forget', { agentId: seed.memoryAgent, id }),
    );
  }
  for (const id of Object.values(seed.workflows)) {
    const found = await host.attempt<{ hash: string | null }>(
      '/bureau/jsonrpc',
      'bureau.workflows.get',
      { id },
    );
    if (found.result?.hash) {
      await ignoringFault(() =>
        host.bureau('bureau.workflows.delete', { id, expectedHash: found.result?.hash }),
      );
    }
  }
  for (const id of seed.agents) {
    const found = await host.attempt<AgentDetail>(
      '/bureau/jsonrpc',
      'bureau.agents.definitions.get',
      { id },
    );
    if (found.result?.source === 'file' && found.result.hash !== null) {
      await ignoringFault(() =>
        host.bureau('bureau.agents.definitions.delete', { id, expectedHash: found.result?.hash }),
      );
    }
  }
}
