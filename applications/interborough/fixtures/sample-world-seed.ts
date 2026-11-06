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
import { createAgentSession, SESSION_OWNER_METADATA_KEY } from '@lostgradient/operative';
import { Conversation } from 'conversationalist';
import { mkdir, rm } from 'node:fs/promises';

import { setPluginsEnabled } from '../src/host/demo-plugin-home.ts';
import { startHost, type Host, type HostOptions } from '../src/host/host.ts';
import { createOffsetRuntime, type OffsetRuntime } from '../src/host/offset-runtime.ts';
import type { ShowcasePacing } from '../src/host/showcase-agents.ts';
import { SHOWCASE_MODELS, showcaseHostOptions } from '../src/host/showcase.ts';
import { writeProviderHome } from '../src/host/stub-provider.ts';
import {
  missedRunsLogged,
  november1Afternoon,
  october21,
  october23,
  october24,
  october28,
  october29DailySummary,
  october29Morning,
  october30,
  SAMPLE_WORLD_HISTORY_TIMES,
  storageAlertFires,
  writeFinalWorkflowFiles,
} from './sample-world-history.ts';
import {
  bureauCall,
  central,
  pendingReviewOf,
  sendChatMessage,
  waitForIdle,
  type Director,
  type SessionContext,
} from './sample-world-host.ts';
import { SAMPLE_WORLD_THREADS } from './sample-world-records.ts';

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
    threadId: SAMPLE_WORLD_THREADS.billing,
    agent: 'tool-runner',
    message: 'Rename the billing tables',
  },
  sayHello: { threadId: SAMPLE_WORLD_THREADS.sayHello, agent: 'assistant', message: 'Say hello' },
  release: {
    threadId: SAMPLE_WORLD_THREADS.release,
    agent: 'request-human-input',
    message: 'Ship the release notes fix.',
  },
  refund: {
    threadId: SAMPLE_WORLD_THREADS.refund,
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

/**
 * What the Nov 2 host the seed leaves running is started with beside the showcase's own options:
 * the development entry's port, build directory, reload and restart, or the end-to-end host's port.
 * Its home is always the seed's, and its runtime and showcase options are the seed's to set.
 */
export type SampleWorldHostOptions = Omit<
  HostOptions,
  'runtime' | keyof ReturnType<typeof showcaseHostOptions>
>;

/** How {@link seedSampleWorld} leaves its host. */
export interface SampleWorldOptions {
  /** Options for the Nov 2 host the seed leaves running; the earlier hosts listen on a free port. */
  readonly host?: SampleWorldHostOptions;
}

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

/** Tool runner's answers wait here while the server stops it mid-reply. */
interface Holding {
  /** Resolved once Tool runner is answering the billing chat. */
  readonly answering: PromiseWithResolvers<void>;
}

/** How long Assistant takes to say hello on Nov 1 (8 s). */
const SAY_HELLO_MILLISECONDS = 8000;

/**
 * How the driver paces the scripted agents and checks: the scene the director is playing first
 * (`sample-world-history.ts`), then the chats': Issue refund asks for order 4471 twenty seconds
 * after its run starts, and the billing chat's answer waits until the run is stopped.
 */
function samplePacing(
  runtime: OffsetRuntime,
  holding: Holding,
  director: Director,
): ShowcasePacing {
  return {
    assistant: async (moment) => director.scene.assistant?.(moment),
    check: async (moment) => director.scene.check?.(moment),
    toolRunner: async (moment) => {
      await director.scene.toolRunner?.(moment);
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

/** The story's home, clock, holding and director, which every session of it shares. */
interface Story {
  readonly home: string;
  readonly runtime: OffsetRuntime;
  readonly holding: Holding;
  readonly director: Director;
}

/**
 * Starts a host on the story's home at `at` on the story's clock: on a free port, or, with
 * `options`, as they say (a port they leave out is the environment's).
 */
async function startAt(story: Story, at: number, options?: SampleWorldHostOptions): Promise<Host> {
  const { home, runtime, holding, director } = story;
  runtime.setTime(at);
  return startHost({
    ...(options ?? { port: 0 }),
    environment: { ...options?.environment, INTERBOROUGH_HOME: home },
    runtime,
    ...showcaseHostOptions(samplePacing(runtime, holding, director)),
  });
}

/** Runs `act` on a host started at `at`, then stops the host. */
async function session(
  story: Story,
  at: number,
  act: (context: SessionContext) => Promise<void>,
): Promise<void> {
  const host = await startAt(story, at);
  try {
    await act({ host, runtime: story.runtime, director: story.director });
  } finally {
    story.director.scene = {};
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

/** Nov 1, 4:12 PM: "Say hello" with Assistant, which answers in 8 s. */
async function sayHelloChat({ host, runtime, director }: SessionContext): Promise<void> {
  const chat = SAMPLE_WORLD_CHATS.sayHello;
  director.scene = { assistant: () => runtime.advance(SAY_HELLO_MILLISECONDS) };
  await sendChatMessage(host, chat.agent, chat.threadId, chat.message);
  director.scene = {};
}

/**
 * The chat the person tries things in and deletes on Nov 1 at 4:12 PM: its title, which is its
 * first message, and the twelve messages it held (six of yours, six of the agent's).
 */
export const SAMPLE_WORLD_SCRATCH_CHAT = {
  threadId: 'sample-chat-scratch-test',
  agent: 'assistant',
  title: 'Scratch test',
  messageCount: 12,
} as const;

/**
 * Nov 1, 4:12 PM, as Say hello starts: you delete "Scratch test", a chat of twelve messages,
 * the way the chat's menu does (`bureau.contexts.delete`, as the local caller), so the Bureau
 * writes the deletion's audit record itself, with the title and the message count the chat had.
 * The chat is saved to the store directly, as Tool runner's memory is, because twelve messages
 * through runs would add runs to the story that the Runs page and the metrics would count.
 */
async function scratchChatDeleted({ host }: SessionContext): Promise<void> {
  const chat = SAMPLE_WORLD_SCRATCH_CHAT;
  const store = host.bureau.internals.sessionStore;
  if (store === undefined) throw new Error('The host has no session store.');
  const conversation = new Conversation();
  for (let exchange = 1; exchange <= chat.messageCount / 2; exchange += 1) {
    conversation.appendUserMessage(exchange === 1 ? chat.title : `Try number ${String(exchange)}`);
    conversation.appendAssistantMessage(`Trying number ${String(exchange)}.`);
  }
  await store.save(
    createAgentSession({
      id: chat.threadId,
      agentName: chat.agent,
      conversationHistory: conversation.current,
      metadata: { [SESSION_OWNER_METADATA_KEY]: ANONYMOUS_LOCAL_OWNER },
      runs: [],
    }),
  );
  await bureauCall(host, 'bureau.contexts.delete', { contextId: chat.threadId });
  await host.bureau.maintain();
}

/**
 * The Nov 2 story on the host that started at 9:00 AM: the missed Daily summary runs it logs as it
 * starts, the storage alert at 9:05 AM, then
 * everything from 9:46 AM to 10:45 AM.
 */
/**
 * The notifications the person's own hooks wrote ("Tell me when triage finishes", "Tell me when a
 * schedule misses") are read and cleared by Nov 2, 10:45 AM, so the bell lists what needs them now
 * (design row 02w) and not every event their hooks announced since Oct 23.
 */
async function clearHookNotifications(host: Host): Promise<void> {
  const listed = await bureauCall<{ notifications: { id: string; kind: string }[] }>(
    host,
    'bureau.notifications.list',
    { limit: 100 },
  );
  const ids = listed.notifications
    .filter((notification) => notification.kind === 'hook')
    .map((notification) => notification.id);
  if (ids.length > 0) await bureauCall(host, 'bureau.notifications.dismiss', { ids });
}

async function monday(context: SessionContext): Promise<Omit<SampleWorld, 'host' | 'runtime'>> {
  const { host, runtime } = context;
  await missedRunsLogged(context);
  storageAlertFires(context);
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
  await clearHookNotifications(host);

  return {
    runs: { refund4472: refund4472.runId, refund4471: refund4471.runId },
    reviews: { refund4471: refund4471.id, release: releaseReview.id },
    memories,
  };
}

/**
 * The plugins the sample world keeps off (decisions.md, "Owner answers during B01"): Demo, Ollama
 * and Voyage. Guardrails and Inspectors run; Anthropic, OpenAI, Gemini and TypeSafe are on but
 * need setup, since no key of theirs is saved once the Anthropic key is removed.
 */
export const SAMPLE_WORLD_DISABLED_PLUGINS = ['demo', 'ollama', 'voyage'] as const;

/**
 * Seeds the sample world into `home`, which it empties first so every seed starts the same, and
 * answers the Nov 2 host it leaves running at a little after 10:45 AM.
 */
export async function seedSampleWorld(
  home: string,
  options: SampleWorldOptions = {},
): Promise<SampleWorld> {
  await rm(home, { recursive: true, force: true });
  await mkdir(home, { recursive: true });
  await writeProviderHome(home, SHOWCASE_MODELS);
  await setPluginsEnabled(
    home,
    Object.fromEntries(SAMPLE_WORLD_DISABLED_PLUGINS.map((name) => [name, false])),
  );
  const story: Story = {
    home,
    runtime: createOffsetRuntime(SAMPLE_WORLD_TIMES.toolRunnerVersion1),
    holding: { answering: Promise.withResolvers<void>() },
    director: { scene: {} },
  };
  const { runtime, holding } = story;
  const times = SAMPLE_WORLD_TIMES;
  const history = SAMPLE_WORLD_HISTORY_TIMES;
  const [version1, version2, version3, version4] = TOOL_RUNNER_VERSIONS;

  await session(story, times.toolRunnerVersion1, async ({ host }) =>
    saveToolRunnerVersion(host, version1),
  );
  await session(story, times.toolRunnerVersion2, async ({ host }) => {
    await saveToolRunnerVersion(host, version2);
    runtime.setTime(times.neverShareEmails);
    await rememberHowTo(host, TOOL_RUNNER_HOW_TOS.neverShareEmails);
  });
  await session(story, times.lookUpBeforeAnswering, async (context) => {
    await rememberHowTo(context.host, TOOL_RUNNER_HOW_TOS.lookUpBeforeAnswering);
    await october21(context);
  });
  await session(story, history.triageCreated - 60_000, october23);
  await session(story, history.triageSecondRun - 60_000, october24);
  await session(story, times.toolRunnerVersion3, async ({ host }) =>
    saveToolRunnerVersion(host, version3),
  );
  await session(story, history.releaseNotesVersion3 - 60_000, october29Morning);
  // The server was started a minute before the chat, so its start comes first in the audit log.
  await session(story, times.billingAsked - 60_000, (context) =>
    billingChatEndedByARestart(context, holding),
  );
  await session(story, times.toolRunnerVersion4, async ({ host }) =>
    saveToolRunnerVersion(host, version4),
  );
  await session(story, history.sayHelloGoal - 60_000, october30);
  await session(story, times.sayHello, async (context) => {
    await scratchChatDeleted(context);
    await sayHelloChat(context);
    await november1Afternoon(context);
  });
  // Daily summary, on a clock set back to Oct 28 (`sample-world-history.ts` says why).
  await session(story, history.dailySummaryCreated - 60_000, october28);
  await session(story, history.dailySummaryRan - 30_000, october29DailySummary);
  await writeFinalWorkflowFiles(home);

  const host = await startAt(story, times.serverStarted, options.host);
  try {
    const context = { host, runtime, director: story.director };
    return { host, runtime, ...(await monday(context)) };
  } catch (error) {
    await host.close();
    throw error;
  }
}
