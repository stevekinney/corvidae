/**
 * The sample world's seed driver (COR-2009, `tmp/design-review/decisions.md`): it fills a fresh
 * Interborough home by running the sample world's story on real hosts, so every record is written
 * the way the product writes it, at the time the story gives it. One offset clock
 * (`src/host/offset-runtime.ts`) carries the story: the driver sets it to each moment, then acts as a
 * person would (over HTTP, as the uncredentialed local caller, so the audit log says "You").
 *
 * The story is a list of sessions on one home. Each starts a host at its moment, acts, and stops it,
 * as a person's server is started and stopped over the days; the last, Monday Nov 2 from 9:00 AM,
 * is left running and handed back. Part A (this module's sessions) holds the chats, the reviews,
 * Tool runner's versions, the memories the Memory page lists and the audit entries they leave:
 *
 * - Oct 12, 20 and 27, and Oct 29 at 11:38 AM: Tool runner's Versions 1 to 4, saved by you.
 * - Oct 20 and 21: your two How-to memories for Tool runner.
 * - Oct 29, 11:04 AM: "Rename the billing tables", which the server stops mid-reply at 11:05 AM, so
 *   the chat reads Ended with the reason `host-stopped`.
 * - Nov 1, 4:12 PM: "Say hello" with Assistant, Done.
 * - Nov 2: the server starts at 9:00 AM; the release question is asked at 9:46 AM and waits; you ask
 *   to refund order 4472 at 10:30 AM, Tool runner corrects its memory at 10:31 AM, you approve at
 *   10:33 AM and it is refunded; you ask to refund order 4471 at 10:42 AM and Issue refund asks at
 *   10:42:20 AM and waits; you remove the Anthropic key at 10:45 AM.
 *
 * One record is written to a store directly rather than through a run: Tool runner's memory "by
 * phone" and its correction "by email, not by phone" (PageMemory). Bureau gives an agent no way to
 * write a fact outside its reply or to correct a memory, so the driver writes both into the host's
 * governed memory under the 10:30 AM refund run's own memory authority, correlated with that run
 * and chat; Bureau then audits the correction as it audits any (`memory.corrected`).
 *
 * @module sample-world-seed
 */

import { ANONYMOUS_LOCAL_OWNER } from '@lostgradient/bureau';
import { createMemoryAuthority, type MemoryAuthority } from '@lostgradient/memory';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { mkdir, rm } from 'node:fs/promises';

import { startHost, type Host } from '../src/host/host.ts';
import { createOffsetRuntime, type OffsetRuntime } from '../src/host/offset-runtime.ts';
import type { ShowcaseToolRunnerMoment } from '../src/host/showcase-agents.ts';
import { SHOWCASE_MODELS, showcaseHostOptions } from '../src/host/showcase.ts';
import { writeProviderHome } from '../src/host/stub-provider.ts';

/** An instant of the story in Central time, from its local date and time and its UTC offset. */
const central = (local: string, offset: '-05:00' | '-06:00'): number =>
  Date.parse(`${local}${offset}`);

/**
 * The moments of the story (Central time; daylight time ends Nov 1 at 2:00 AM, so October is UTC-5
 * and November UTC-6).
 */
export const SAMPLE_WORLD_TIMES = {
  toolRunnerVersion1: central('2026-10-12T10:00:00', '-05:00'),
  toolRunnerVersion2: central('2026-10-20T09:00:00', '-05:00'),
  neverShareEmails: central('2026-10-20T09:10:00', '-05:00'),
  lookUpBeforeAnswering: central('2026-10-21T09:00:00', '-05:00'),
  toolRunnerVersion3: central('2026-10-27T09:00:00', '-05:00'),
  billingAsked: central('2026-10-29T11:04:00', '-05:00'),
  billingStopped: central('2026-10-29T11:05:00', '-05:00'),
  toolRunnerVersion4: central('2026-10-29T11:38:00', '-05:00'),
  sayHello: central('2026-11-01T16:12:00', '-06:00'),
  serverStarted: central('2026-11-02T09:00:00', '-06:00'),
  releaseAsked: central('2026-11-02T09:46:00', '-06:00'),
  refund4472Asked: central('2026-11-02T10:30:00', '-06:00'),
  phoneRemembered: central('2026-11-02T10:30:30', '-06:00'),
  memoryCorrected: central('2026-11-02T10:31:00', '-06:00'),
  refund4472Approved: central('2026-11-02T10:33:00', '-06:00'),
  refund4471Started: central('2026-11-02T10:42:00', '-06:00'),
  anthropicKeyRemoved: central('2026-11-02T10:45:00', '-06:00'),
} as const;

/** How long after its run starts Issue refund asks to refund order 4471 (10:42:00 to 10:42:20). */
export const REFUND_4471_ASK_DELAY_MILLISECONDS = 20_000;

/** The chats of the sample world: each thread, the agent it is with, and what you write. */
export const SAMPLE_WORLD_CHATS = {
  billing: {
    threadId: 'sample-chat-billing-tables',
    agent: 'tool-runner',
    message: 'Rename the billing tables',
  },
  sayHello: { threadId: 'sample-chat-say-hello', agent: 'assistant', message: 'Say hello' },
  release: {
    threadId: 'sample-chat-release-notes-fix',
    agent: 'request-human-input',
    message: 'Ship the release notes fix.',
  },
  refund: {
    threadId: 'sample-chat-refunds',
    agent: 'tool-runner',
    /** The refund chat's two messages, and its title, which is the second (the one still waiting). */
    first: 'Please refund order 4472, $18.50.',
    second: 'Please refund order 4471, it arrived damaged.',
  },
} as const;

/**
 * Tool runner's saved overrides, Version 1 to 4 (PageAgent's Versions list): created on Oct 12, its
 * Role rewritten on Oct 20, moved from Haiku 5.5 to Sonnet 5.5 on Oct 27, and on Oct 29 the $25
 * refund rule added with Issue refund. Asks: Lookup order Never, Issue refund Always, Triage refunds
 * On changes.
 */
export const TOOL_RUNNER_VERSIONS = [
  {
    instructions: 'You help customers with orders.',
    tools: ['lookup-order', 'triage-refunds'],
    toolApproval: { 'lookup-order': 'never', 'triage-refunds': 'on-changes' },
    model: 'anthropic/claude-haiku-5-5',
  },
  {
    instructions:
      'You help customers with orders. Look an order up with lookup-order before you answer anything about it.',
    tools: ['lookup-order', 'triage-refunds'],
    toolApproval: { 'lookup-order': 'never', 'triage-refunds': 'on-changes' },
    model: 'anthropic/claude-haiku-5-5',
  },
  {
    instructions:
      'You help customers with orders. Look an order up with lookup-order before you answer anything about it.',
    tools: ['lookup-order', 'triage-refunds'],
    toolApproval: { 'lookup-order': 'never', 'triage-refunds': 'on-changes' },
    model: 'anthropic/claude-sonnet-5-5',
  },
  {
    instructions:
      'You help customers with orders. Look an order up with lookup-order before you answer anything about it.\n\nEvery refund over $25 needs a person to approve it first.',
    tools: ['lookup-order', 'issue-refund', 'triage-refunds'],
    toolApproval: {
      'lookup-order': 'never',
      'issue-refund': 'always',
      'triage-refunds': 'on-changes',
    },
    model: 'anthropic/claude-sonnet-5-5',
  },
] as const;

/** The memories you gave Tool runner, both How-to. */
export const TOOL_RUNNER_HOW_TOS = {
  neverShareEmails: 'Never share customer emails in replies.',
  lookUpBeforeAnswering: 'To check an order, call lookup-order before answering.',
} as const;

/** The memory Tool runner corrects at 10:31 AM in the refund chat: what it said, and what it says. */
export const TOOL_RUNNER_CORRECTION = {
  original: 'Customers prefer refund updates by phone.',
  corrected: 'Customers prefer refund updates by email, not by phone.',
} as const;

/** The authorization revision the driver's direct memory writes are attributed under. */
const SEED_AUTHORIZATION_REVISION = 'interborough:sample-world-seed';

/** What the seed made, by name, with the host it left running at Nov 2. */
export interface SampleWorld {
  /** The Nov 2 host, running on {@link SampleWorld.runtime}; the caller closes it. */
  readonly host: Host;
  /** The story's clock, left a little after 10:45 AM on Nov 2. */
  readonly runtime: OffsetRuntime;
  /** The run that asked to refund order 4472, and the one that waits to refund order 4471. */
  readonly runs: { readonly refund4472: string; readonly refund4471: string };
  /** The two reviews waiting on you: the 4471 refund and the release question. */
  readonly reviews: { readonly refund4471: string; readonly release: string };
  /** Tool runner's corrected memory, and the one it corrected. */
  readonly memories: { readonly corrected: string; readonly original: string };
}

/** A fault the host answered a JSON-RPC call with. */
class HostFault extends Error {}

/** One JSON-RPC call to the host's Bureau plane, as the local caller; a fault throws. */
async function bureauCall<T>(
  host: Host,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const response = await fetch(new URL('/bureau/jsonrpc', host.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params }),
  });
  const body = (await response.json()) as { result?: T; error?: { message?: string } };
  if (body.error !== undefined) {
    throw new HostFault(`${method} answered: ${body.error.message ?? 'no message'}`);
  }
  return body.result as T;
}

/**
 * Sends `message` to `agent` in `threadId` over AG-UI, as a person's chat does, and reads the run's
 * stream to its end: the run finished, or parked waiting on a person.
 */
async function sendChatMessage(
  host: Host,
  agent: string,
  threadId: string,
  message: string,
): Promise<void> {
  const response = await fetch(new URL(`/bureau/ag-ui/agents/${agent}/run`, host.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({
      threadId,
      runId: `run-${crypto.randomUUID()}`,
      messages: [{ id: `user-${crypto.randomUUID()}`, role: 'user', content: message }],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    }),
  });
  const stream = await response.text();
  if (response.status !== 200 || stream.includes('RUN_ERROR')) {
    throw new Error(`The run of ${agent} in ${threadId} failed: ${stream.slice(0, 400)}`);
  }
}

/** A review waiting on you, as `bureau.reviews.list` shows it. */
type ReviewRow = {
  readonly id: string;
  readonly runId: string;
  readonly sessionId?: string;
  readonly round?: number;
};

/** The pending review of the chat `threadId`. */
async function pendingReviewOf(host: Host, threadId: string): Promise<ReviewRow> {
  const listed = await bureauCall<{ reviews: ReviewRow[] }>(host, 'bureau.reviews.list', {});
  const review = listed.reviews.find((entry) => entry.sessionId === threadId);
  if (review === undefined) throw new Error(`The chat ${threadId} is waiting on no review.`);
  return review;
}

/** Saves `overrides` as Tool runner's next version. */
async function saveToolRunnerVersion(
  host: Host,
  overrides: (typeof TOOL_RUNNER_VERSIONS)[number],
): Promise<void> {
  const current = await bureauCall<{ hash: string }>(host, 'bureau.agents.overrides.get', {
    id: 'tool-runner',
  });
  await bureauCall(host, 'bureau.agents.overrides.update', {
    id: 'tool-runner',
    expectedHash: current.hash,
    overrides,
  });
}

/** Gives Tool runner a How-to memory, from you. */
async function rememberHowTo(host: Host, content: string): Promise<void> {
  await bureauCall(host, 'bureau.memory.remember', {
    agentId: 'tool-runner',
    content,
    kind: 'how-to',
  });
}

/**
 * The memory authority of Tool runner's run `runId`, as the Bureau composes one for a run of the
 * local caller: Tool runner writes and corrects what it remembers under it.
 */
function runMemoryAuthority(host: Host, runId: string): MemoryAuthority {
  return createMemoryAuthority({
    principal: { kind: 'run', id: runId },
    tenantId: host.bureau.id,
    ownerId: ANONYMOUS_LOCAL_OWNER,
    purpose: 'conversation-memory',
    capabilities: ['memory:write', 'memory:get'],
    policyRevision: SEED_AUTHORIZATION_REVISION,
    projection: 'bureau',
  });
}

/**
 * Writes Tool runner's "by phone" memory from the 4472 refund run at 10:30:30 AM, then corrects it
 * from the same run at 10:31 AM, and answers both records' identifiers.
 */
async function correctToolRunnerMemory(
  host: Host,
  runtime: OffsetRuntime,
  runId: string,
): Promise<SampleWorld['memories']> {
  const memory = host.bureau.memory;
  if (memory === undefined) throw new Error('The host has no governed memory.');
  const authority = runMemoryAuthority(host, runId);
  const correlation = { runId, sessionId: SAMPLE_WORLD_CHATS.refund.threadId };
  const metadata = { sessionId: SAMPLE_WORLD_CHATS.refund.threadId };
  runtime.setTime(SAMPLE_WORLD_TIMES.phoneRemembered);
  const written = await memory.write(authority, TOOL_RUNNER_CORRECTION.original, {
    collection: 'tool-runner',
    source: 'model-tool',
    memoryClass: 'semantic',
    metadata,
    correlation,
  });
  if (written.recordId === undefined) {
    throw new Error(`Tool runner's memory was not written: ${written.status}.`);
  }
  runtime.setTime(SAMPLE_WORLD_TIMES.memoryCorrected);
  const corrected = await memory.forget(authority, {
    mode: 'supersession',
    locator: { id: written.recordId, collection: 'tool-runner' },
    successor: {
      content: TOOL_RUNNER_CORRECTION.corrected,
      collection: 'tool-runner',
      source: 'model-tool',
      memoryClass: 'semantic',
      metadata,
      correlation,
    },
  });
  const correctedId = corrected.write?.recordId;
  if (corrected.status !== 'applied' || correctedId === undefined) {
    throw new Error(`Tool runner's memory was not corrected: ${corrected.status}.`);
  }
  return { original: written.recordId, corrected: correctedId };
}

/** What a session of the story is handed: its host and the story's clock. */
interface SessionContext {
  readonly host: Host;
  readonly runtime: OffsetRuntime;
}

/** Tool runner's answers wait here while the server stops it mid-reply. */
interface Holding {
  /** Resolved once Tool runner is answering the billing chat. */
  readonly answering: PromiseWithResolvers<void>;
}

/**
 * How the driver paces Tool runner: Issue refund asks for order 4471 twenty seconds after its run
 * starts, and the billing chat's answer waits until the run is stopped.
 */
function samplePacing(runtime: OffsetRuntime, holding: Holding) {
  return {
    toolRunner: async (moment: ShowcaseToolRunnerMoment): Promise<void> => {
      if (moment.step === 'refund-ask' && moment.orderId === '4471') {
        runtime.advance(REFUND_4471_ASK_DELAY_MILLISECONDS);
        return;
      }
      if (moment.step !== 'answer' || moment.request !== SAMPLE_WORLD_CHATS.billing.message) return;
      holding.answering.resolve();
      const { signal } = moment;
      await new Promise<never>((_resolve, reject) => {
        if (signal === undefined) return;
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  };
}

/** Starts a host on `home` at `at` on the story's clock. */
async function startAt(
  home: string,
  runtime: OffsetRuntime,
  holding: Holding,
  at: number,
): Promise<Host> {
  runtime.setTime(at);
  return startHost({
    environment: { INTERBOROUGH_HOME: home },
    port: 0,
    runtime,
    ...showcaseHostOptions(samplePacing(runtime, holding)),
  });
}

/** Runs `act` on a host started at `at`, then stops the host. */
async function session(
  home: string,
  runtime: OffsetRuntime,
  holding: Holding,
  at: number,
  act: (context: SessionContext) => Promise<void>,
): Promise<void> {
  const host = await startAt(home, runtime, holding, at);
  try {
    await act({ host, runtime });
  } finally {
    await host.close();
  }
}

/**
 * Oct 29, 11:04 AM: "Rename the billing tables" with Tool runner, which the server stops at 11:05 AM
 * while Tool runner is still answering. The server aborts the run it stops, so the chat ends with
 * the reason `host-stopped`.
 */
async function billingChatEndedByARestart({ host, runtime }: SessionContext, holding: Holding) {
  const chat = SAMPLE_WORLD_CHATS.billing;
  runtime.setTime(SAMPLE_WORLD_TIMES.billingAsked);
  const answer = sendChatMessage(host, chat.agent, chat.threadId, chat.message).then(
    () => undefined,
    () => undefined,
  );
  await holding.answering.promise;
  runtime.setTime(SAMPLE_WORLD_TIMES.billingStopped);
  await host.bureau.shutdown({ policy: 'abort' });
  await answer;
}

/** The Nov 2 story on the host that started at 9:00 AM: everything from 9:46 AM to 10:45 AM. */
async function monday({
  host,
  runtime,
}: SessionContext): Promise<Omit<SampleWorld, 'host' | 'runtime'>> {
  const { release, refund } = SAMPLE_WORLD_CHATS;
  runtime.setTime(SAMPLE_WORLD_TIMES.releaseAsked);
  await sendChatMessage(host, release.agent, release.threadId, release.message);
  const releaseReview = await pendingReviewOf(host, release.threadId);

  runtime.setTime(SAMPLE_WORLD_TIMES.refund4472Asked);
  await sendChatMessage(host, refund.agent, refund.threadId, refund.first);
  const refund4472 = await pendingReviewOf(host, refund.threadId);
  const memories = await correctToolRunnerMemory(host, runtime, refund4472.runId);

  runtime.setTime(SAMPLE_WORLD_TIMES.refund4472Approved);
  await bureauCall(host, 'bureau.reviews.resolve', {
    id: refund4472.id,
    decision: 'approve',
    round: refund4472.round ?? 0,
  });
  await waitForIdle(host, refund.threadId);

  runtime.setTime(SAMPLE_WORLD_TIMES.refund4471Started);
  await sendChatMessage(host, refund.agent, refund.threadId, refund.second);
  const refund4471 = await pendingReviewOf(host, refund.threadId);
  await bureauCall(host, 'bureau.contexts.rename', {
    contextId: refund.threadId,
    title: refund.second,
  });

  runtime.setTime(SAMPLE_WORLD_TIMES.anthropicKeyRemoved);
  const removed = await fetch(new URL('/host/providers/anthropic', host.url), { method: 'DELETE' });
  if (!removed.ok)
    throw new Error(`Removing the Anthropic key answered ${String(removed.status)}.`);

  return {
    runs: { refund4472: refund4472.runId, refund4471: refund4471.runId },
    reviews: { refund4471: refund4471.id, release: releaseReview.id },
    memories,
  };
}

/** Waits until the chat `threadId` has no run in flight and nothing waiting on you. */
async function waitForIdle(host: Host, threadId: string): Promise<void> {
  await waitUntil(
    async () => {
      const context = await bureauCall<{ activity: string }>(host, 'bureau.contexts.get', {
        contextId: threadId,
      });
      return context.activity === 'idle';
    },
    { message: `the chat ${threadId} to finish its run` },
  );
}

/**
 * Seeds the sample world into `home`, which it empties first so every seed starts the same, and
 * answers the Nov 2 host it leaves running at a little after 10:45 AM.
 */
export async function seedSampleWorld(home: string): Promise<SampleWorld> {
  await rm(home, { recursive: true, force: true });
  await mkdir(home, { recursive: true });
  await writeProviderHome(home, SHOWCASE_MODELS);
  const runtime = createOffsetRuntime(SAMPLE_WORLD_TIMES.toolRunnerVersion1);
  const holding: Holding = { answering: Promise.withResolvers<void>() };
  const times = SAMPLE_WORLD_TIMES;
  const [version1, version2, version3, version4] = TOOL_RUNNER_VERSIONS;

  await session(home, runtime, holding, times.toolRunnerVersion1, async ({ host }) =>
    saveToolRunnerVersion(host, version1),
  );
  await session(home, runtime, holding, times.toolRunnerVersion2, async ({ host }) => {
    await saveToolRunnerVersion(host, version2);
    runtime.setTime(times.neverShareEmails);
    await rememberHowTo(host, TOOL_RUNNER_HOW_TOS.neverShareEmails);
  });
  await session(home, runtime, holding, times.lookUpBeforeAnswering, async ({ host }) =>
    rememberHowTo(host, TOOL_RUNNER_HOW_TOS.lookUpBeforeAnswering),
  );
  await session(home, runtime, holding, times.toolRunnerVersion3, async ({ host }) =>
    saveToolRunnerVersion(host, version3),
  );
  // The server was started a minute before the chat, so its start comes first in the audit log.
  await session(home, runtime, holding, times.billingAsked - 60_000, (context) =>
    billingChatEndedByARestart(context, holding),
  );
  await session(home, runtime, holding, times.toolRunnerVersion4, async ({ host }) =>
    saveToolRunnerVersion(host, version4),
  );
  await session(home, runtime, holding, times.sayHello, async ({ host }) => {
    const chat = SAMPLE_WORLD_CHATS.sayHello;
    await sendChatMessage(host, chat.agent, chat.threadId, chat.message);
  });

  const host = await startAt(home, runtime, holding, times.serverStarted);
  try {
    return { host, runtime, ...(await monday({ host, runtime })) };
  } catch (error) {
    await host.close();
    throw error;
  }
}
