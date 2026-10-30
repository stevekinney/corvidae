/**
 * COR-1934 — the class test. A chat that uses every content-bearing feature, each with a sentinel
 * of its own, is deleted; a scan of EVERY key and value in the SQLite store then finds none of its
 * sentinels, audit entries included, and every sentinel of a second chat is still there.
 *
 * `chat-delete-purge.test.ts` covers the ordering and failure matrix with an answer and an input
 * only. This test exists because a purge list tested with a chat that uses nothing else passes
 * vacuously: the feature a list forgets is the feature the test chat never used.
 */
import { generateEncryptionKey } from '@lostgradient/cryptography';
import { createTool, createToolbox, type Toolbox } from 'armorer';
import {
  createAgent,
  createModelCatalog,
  stopWhen,
  withBackendDescriptors,
  type GenerateFunction,
} from '@lostgradient/operative';
import type { AgentDefinitions } from './agent-catalog';
import { createBureau } from './create-bureau';
import { createMemoryAssetStorage } from './assets/storage';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createBureauHandler } from './http/create-bureau-handler.ts';
import { message, type Json } from './http/a2a-mount.test-support.ts';
import { authentication } from './http/management/management-fixtures.test-support.ts';
import { waitForCondition } from './test';
import { createSqliteStorageFixture, type BureauStorageFixture } from './test/storage-fixtures';
import { base64Of, pngBytes } from './testing/asset-fixtures.test-support.ts';
import type { Bureau } from './types';
import { INTERACTIVE_SURFACE_CONTRACT_VERSION } from './interactive-surface/types';
import {
  BUREAU_RESERVED_KEY_FAMILIES,
  type ReservedKeyFamily,
  SHARED_KEY_FAMILIES_OF_A_CHAT,
} from './reserved-key-prefixes';

/** What each content-bearing feature of a chat holds, by name; every chat has values of its own. */
type Sentinels = Readonly<Record<string, string>>;

/** The kind of chat: one that uses tools and reviews a tool's approval, or one that asks a person. */
type ChatKind = 'approval' | 'question';

function sentinelsOf(tag: string, kind: ChatKind): Sentinels {
  const common = {
    a2aMessage: `A2AMESSAGE${tag}`,
    a2aFollowUp: `A2AFOLLOWUP${tag}`,
    /** The name of a file sent inline with the follow-up, which the send's receipt keeps. */
    fileName: `FILENAME${tag}`,
    input: `SESSIONINPUT${tag}`,
    surfaceSummary: `SURFACESUMMARY${tag}`,
    surfaceData: `SURFACEDATA${tag}`,
    answer: `FINALANSWER${tag}`,
  };
  return kind === 'approval'
    ? {
        ...common,
        toolParameters: `TOOLPARAMETERS${tag}`,
        toolResult: `TOOLRESULT${tag}`,
        approvalAsked: `APPROVALASKED${tag}`,
        approvalArguments: `APPROVALARGUMENTS${tag}`,
        approvalReason: `APPROVALREASON${tag}`,
        approvalFinalReason: `APPROVALFINALREASON${tag}`,
      }
    : {
        ...common,
        humanPrompt: `HUMANPROMPT${tag}`,
        humanPayload: `HUMANPAYLOAD${tag}`,
        childInput: `CHILDINPUT${tag}`,
        childOutcome: `CHILDOUTCOME${tag}`,
      };
}

/** The plaintext of a question chat's secret field, which must never be stored in clear. */
const secretOf = (tag: string) => `PLAINTEXT-PASSWORD-${tag}`;

const ALICE = 'api-key:alice';
const OPERATOR = 'api-key:operator';
const disposables: Bureau[] = [];
const fixtures: BureauStorageFixture[] = [];

afterEach(async () => {
  for (const bureau of disposables.splice(0)) await bureau.dispose();
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

/** Every key of the store with its value read as text, so a sentinel is found anywhere. */
async function scan(fixture: BureauStorageFixture): Promise<Map<string, string>> {
  const entries = new Map<string, string>();
  for await (const [key, value] of fixture.storage.scan('')) {
    entries.set(key, Buffer.from(value).toString('latin1'));
  }
  return entries;
}

function holding(entries: Map<string, string>, needle: string): string[] {
  return [...entries]
    .filter(([key, value]) => key.includes(needle) || value.includes(needle))
    .map(([key]) => key);
}

/** The key prefix of each family, so a failure names the family that kept a sentinel. */
function familiesHolding(entries: Map<string, string>, needle: string): string[] {
  return [...new Set(holding(entries, needle).map((key) => key.split(':')[0]!))].toSorted();
}

const FAMILIES: readonly ReservedKeyFamily[] = [
  ...BUREAU_RESERVED_KEY_FAMILIES,
  ...SHARED_KEY_FAMILIES_OF_A_CHAT,
];

/** The family a key belongs to, by its longest matching prefix, or `undefined` for none. */
function familyOf(key: string): ReservedKeyFamily | undefined {
  let found: ReservedKeyFamily | undefined;
  for (const family of FAMILIES) {
    if (
      key.startsWith(family.prefix) &&
      (found === undefined || family.prefix.length > found.prefix.length)
    ) {
      found = family;
    }
  }
  return found;
}

/** The ids a deleted chat is known by: its context and every run of it, children included. */
interface ChatIds {
  readonly contextId: string;
  readonly runIds: readonly string[];
}

/** Whether a key is the `session.deleted` record of the event history, its index entry or its dedupe marker. */
function isDeletionMarker(entries: Map<string, string>, key: string, value: string): boolean {
  if (key.startsWith('fleet-event:')) return value.includes('session.deleted');
  if (key.startsWith('fleet-event-by-workflow:')) {
    const event = entries.get(`fleet-event:${key.slice(key.lastIndexOf(':') + 1)}`);
    return event !== undefined && event.includes('session.deleted');
  }
  return key.startsWith('outbox-dedupe:') && key.includes(':session.deleted:');
}

/**
 * Holds every key of the store to its family's classification (COR-1934): a key no family covers
 * is a family nobody classified; a key of a `purged` family may not name a deleted chat or one of
 * its runs, in its key or its value. The one exception is the `session.deleted` record of the
 * event history, which is how a deleted chat's history is told from one that never existed.
 */
function classificationFindings(
  entries: Map<string, string>,
  deleted: readonly ChatIds[],
): string[] {
  const ids = deleted.flatMap((chat) => [chat.contextId, ...chat.runIds]);
  const findings: string[] = [];
  for (const [key, value] of entries) {
    const family = familyOf(key);
    if (family === undefined) {
      findings.push(`unclassified family: ${key}`);
      continue;
    }
    if (family.onChatDelete !== 'purged') continue;
    if (isDeletionMarker(entries, key, value)) continue;
    const named = ids.find((id) => key.includes(id) || value.includes(id));
    if (named !== undefined) findings.push(`${family.prefix} still names ${named}: ${key}`);
  }
  return findings;
}

interface World {
  readonly bureau: Bureau;
  readonly fixture: BureauStorageFixture;
  /** Which chat the scripted models are serving now. */
  readonly plan: { current: Sentinels };
  handle(request: Request): Promise<Response>;
}

/** A Bureau over SQLite with two agents: one calls tools and is gated by approvals, one asks a person. */
async function openWorld(): Promise<World> {
  const fixture = createSqliteStorageFixture();
  fixtures.push(fixture);
  const plan = { current: sentinelsOf('start', 'approval') };
  const lookup = createTool({
    name: 'lookup-order',
    version: '1.0.0',
    description: 'Look an order up',
    input: z.object({ orderId: z.string() }),
    metadata: { readOnly: true },
    execute: async () => ({ status: plan.current['toolResult'] }),
  });
  const refund = createTool({
    name: 'issue-refund',
    version: '1.0.0',
    description: 'Refund an order',
    input: z.object({ orderId: z.string() }),
    metadata: { mutates: true },
    execute: async ({ orderId }) => ({ refunded: orderId }),
  });
  /** Each chat's model calls, counted from the chat's own answer sentinel. */
  const calls = new Map<string, number>();
  const nextCall = () => {
    const key = plan.current['answer']!;
    calls.set(key, (calls.get(key) ?? 0) + 1);
    return calls.get(key)!;
  };
  const toolCall = (id: string, name: string, args: object): ReturnType<GenerateFunction> =>
    Promise.resolve({ content: '', toolCalls: [{ id, name, arguments: args }] });
  const answer = (): ReturnType<GenerateFunction> =>
    Promise.resolve({ content: plan.current['answer']!, toolCalls: [] });
  const helper: GenerateFunction = async () => {
    const call = nextCall();
    if (call === 1)
      return toolCall('call-1', 'lookup-order', { orderId: plan.current['toolParameters'] });
    if (call === 2)
      return toolCall('call-2', 'issue-refund', { orderId: plan.current['approvalAsked'] });
    return answer();
  };
  const asker: GenerateFunction = async () =>
    nextCall() === 1
      ? toolCall('ask-1', 'requestHumanInput', {
          signalName: 'human-response',
          prompt: plan.current['humanPrompt'],
        })
      : answer();
  // The agents take an image, so a message's inline file is admitted as an asset.
  const vision = createModelCatalog()
    .descriptors.filter((descriptor) => descriptor.provider === 'anthropic')
    .slice(0, 1);
  const bureau = await createBureau<AgentDefinitions>({
    id: 'chat-purge-content',
    agents: {
      helper: createAgent({
        generate: withBackendDescriptors(helper, vision),
        toolbox: createToolbox([lookup, refund], {
          approvalSecret: 'chat-purge-secret',
          approvalPolicy: { mode: 'on-mutation' },
        }) as unknown as Toolbox,
        stopWhen: stopWhen.some(stopWhen.toolOutcome('action_required'), stopWhen.noToolCalls()),
      }),
      // A plain toolbox: the question tool is only offered where no approval policy needs a
      // versioned definition of it.
      asker: createAgent({
        generate: withBackendDescriptors(asker, vision),
        stopWhen: stopWhen.noToolCalls(),
      }),
      // The agent a chat delegates to.
      worker: createAgent({
        generate: async () => ({ content: plan.current['childOutcome'] ?? '', toolCalls: [] }),
        stopWhen: stopWhen.noToolCalls(),
      }),
    },
    storage: fixture.storage,
    durable: true,
    durableOwnership: { ownership: 'none' },
    // The answer to the question has a field the person must not see echoed back: it is stored
    // sealed, apart from the answer.
    answerEncryption: { current: await generateEncryptionKey() },
    humanInput: {
      inputSchemas: {
        'human-response': {
          type: 'object',
          properties: {
            note: { type: 'string' },
            password: { type: 'string', writeOnly: true, 'x-secret': true, minLength: 8 },
          },
          required: ['note', 'password'],
          additionalProperties: false,
        },
      },
    },
    assets: { storage: createMemoryAssetStorage() },
  });
  disposables.push(bureau);
  const handle = createBureauHandler(bureau, {
    authentication,
    a2aAgents: ['helper', 'asker'],
    publicUrl: 'http://localhost',
  });
  return { bureau, fixture, plan, handle };
}

async function a2aSend(
  world: World,
  agent: string,
  text: string,
  extra: Json = {},
): Promise<{ id: string; contextId: string }> {
  const response = await world.handle(
    new Request(`http://localhost/a2a/${agent}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'A2A-Version': '1.0',
        'X-API-Key': 'alice-assets-key',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'SendMessage',
        params: { message: message(text, extra) },
      }),
    }),
  );
  const body: Json = await response.json();
  if (body.result === undefined) throw new Error(JSON.stringify(body.error));
  return body.result.task as { id: string; contextId: string };
}

/** Opens a surface on the run and fills it, so both its summary and its data are stored. */
async function useSurface(world: World, task: { id: string }, sentinels: Sentinels) {
  const { bureau } = world;
  const record = await bureau.internals.taskRegistry.record(task.id);
  if (record === undefined) throw new Error('the task has a record');
  const surfaces = bureau.surfaces!;
  const created = await surfaces.create(
    {
      type: 'surface.create',
      contractVersion: INTERACTIVE_SURFACE_CONTRACT_VERSION,
      commandId: `create-${task.id}`,
      taskId: task.id,
      surfaceId: 'confirm',
      summary: sentinels['surfaceSummary']!,
      representation: {
        kind: 'input-form',
        schema: { type: 'object', properties: { window: { type: 'string' } } },
      },
      actions: [
        {
          name: 'submit',
          intent: 'submit',
          continuation: { type: 'signal', sessionId: record.contextId, signalName: 'window' },
        },
      ],
    },
    { principal: ALICE },
  );
  expect(created).toMatchObject({ outcome: 'accepted' });
  const updated = await surfaces.update(
    {
      type: 'surface.update',
      contractVersion: INTERACTIVE_SURFACE_CONTRACT_VERSION,
      commandId: `update-${task.id}`,
      taskId: task.id,
      surfaceId: 'confirm',
      baseRevision: 1,
      data: { window: sentinels['surfaceData']! },
    },
    { principal: ALICE },
  );
  expect(updated).toMatchObject({ outcome: 'accepted' });
}

async function sendInput(world: World, task: { id: string; contextId: string }, text: string) {
  const outcome = await world.bureau.contexts.input(task.contextId, {
    id: `input-${task.id}`,
    principal: ALICE,
    deliveryMode: 'steer',
    payload: text,
  });
  expect(['admitted', 'replayed']).toContain(outcome.outcome);
}

/** The chat's run hands work to another agent, whose input and outcome are the chat's words. */
async function delegate(world: World, task: { id: string }, sentinels: Sentinels): Promise<string> {
  const dispatched = await world.bureau.children.dispatch({
    parentRunId: task.id,
    agentName: 'worker',
    input: sentinels['childInput']!,
  });
  if (dispatched.outcome !== 'started')
    throw new Error(`Expected a started child, got ${JSON.stringify(dispatched)}.`);
  const settled = await world.bureau.children.wait({
    parentRunId: task.id,
    childRunId: dispatched.child.childRunId,
  });
  expect(settled).toMatchObject({ outcome: 'settled' });
  return dispatched.child.childRunId;
}

async function completed(world: World, runId: string) {
  await waitForCondition(
    () => world.bureau.tasks.detail(runId)?.status === 'completed',
    `run ${runId} never completed`,
  );
}

/**
 * Drives one chat through every content-bearing feature its kind has: an A2A message starts it,
 * the agent reads through a tool or asks a person, a human decides with other arguments, a reason
 * and an answer, a person's input reaches it, an interactive surface is opened on it, and the chat
 * goes on with a second message that the agent answers.
 */
async function useEveryFeature(world: World, kind: ChatKind, tag: string) {
  const { bureau } = world;
  const sentinels = sentinelsOf(tag, kind);
  world.plan.current = sentinels;
  const agent = kind === 'approval' ? 'helper' : 'asker';
  const task = await a2aSend(world, agent, sentinels['a2aMessage']!);
  const reviewsOf = (runId: string) =>
    bureau.reviews.list().filter((entry) => entry.runId === runId);
  await waitForCondition(() => reviewsOf(task.id).length === 1, `chat ${tag} never parked`);
  const [review] = reviewsOf(task.id);
  await useSurface(world, task, sentinels);
  await sendInput(world, task, sentinels['input']!);
  const runIds = [task.id];

  if (kind === 'approval') {
    if (review?.kind !== 'tool-approval') throw new Error('Expected a tool approval.');
    // The first approval carries other arguments, which the policy gates again; the second is final.
    const first = await bureau.reviews.resolve({
      id: review.id,
      decision: 'approve',
      principal: OPERATOR,
      arguments: { orderId: sentinels['approvalArguments'] },
      reason: sentinels['approvalReason']!,
    });
    expect(first.superseded).toBe(true);
    await bureau.reviews.resolve({
      id: review.id,
      decision: 'approve',
      principal: OPERATOR,
      reason: sentinels['approvalFinalReason']!,
    });
  } else {
    if (review?.kind !== 'human-wait') throw new Error('Expected a question to a person.');
    // The run waits for the person, so it can hand work on.
    runIds.push(await delegate(world, task, sentinels));
    // Answered as a command with a structured answer: its receipt keeps the answer it admitted
    // (`TasksRespondClaim.submission`), in the `tasks.respond` ledger.
    // The secret field's plaintext is never stored in clear: it is sealed apart from the answer.
    const answered = await bureau.tasks.respond({
      taskId: task.id,
      messageId: `respond-${task.id}`,
      data: { note: sentinels['humanPayload'], password: secretOf(tag) },
      principal: OPERATOR,
      operator: true,
    });
    expect(answered.receipt).toBe('applied');
  }
  await completed(world, task.id);
  // The chat goes on: a second message in it, which the agent answers.
  // The follow-up carries a file inline: its bytes become an asset, and the send's receipt keeps
  // the file's projection (name included) for a retry.
  const followUp = await a2aSend(world, agent, sentinels['a2aFollowUp']!, {
    contextId: task.contextId,
    parts: [
      { text: sentinels['a2aFollowUp'] },
      {
        raw: base64Of(pngBytes(8, 8)),
        filename: `${sentinels['fileName']}.png`,
        mediaType: 'image/png',
      },
    ],
  });
  expect(followUp.contextId).toBe(task.contextId);
  runIds.push(followUp.id);
  await completed(world, followUp.id);
  await bureau.maintain();
  const ids: ChatIds = { contextId: task.contextId, runIds };
  return { task, sentinels, ids };
}

function allSentinels(...chats: Sentinels[]): [name: string, value: string][] {
  return chats.flatMap((sentinels) => Object.entries(sentinels));
}

describe('contexts.delete purges every content-bearing feature of a chat (COR-1934)', () => {
  it('leaves none of the deleted chats’ sentinels anywhere in the store, and every one of another chat’s', async () => {
    const world = await openWorld();
    const doomed = [
      await useEveryFeature(world, 'approval', 'DoomedA'),
      await useEveryFeature(world, 'question', 'DoomedQ'),
    ];
    const kept = [
      await useEveryFeature(world, 'approval', 'KeptA'),
      await useEveryFeature(world, 'question', 'KeptQ'),
    ];

    const before = await scan(world.fixture);
    // The test chats really used every feature: each sentinel is stored, for every chat.
    const unstored = allSentinels(...[...doomed, ...kept].map((chat) => chat.sentinels))
      .filter(([, value]) => holding(before, value).length === 0)
      .map(([name, value]) => `${name}:${value}`);
    expect(unstored).toEqual([]);

    // The sealed answers of the two question chats are stored, one record each, and the plaintext
    // of neither is anywhere.
    const secretKeys = (entries: Map<string, string>) =>
      [...entries.keys()].filter((key) => key.startsWith('bureau-secret-answer:v1:'));
    expect(secretKeys(before)).toHaveLength(2);
    expect(holding(before, secretOf('DoomedQ'))).toEqual([]);
    expect(holding(before, secretOf('KeptQ'))).toEqual([]);

    for (const chat of doomed) await world.bureau.contexts.delete(chat.task.contextId);
    await world.bureau.maintain();

    const after = await scan(world.fixture);
    const surviving = Object.fromEntries(
      allSentinels(...doomed.map((chat) => chat.sentinels))
        .map(([name, value]) => [`${name}:${value}`, familiesHolding(after, value)] as const)
        .filter(([, families]) => families.length > 0),
    );
    expect(surviving).toEqual({});
    // Every family is classified, and a purged family names none of the deleted chats.
    expect(
      classificationFindings(
        after,
        doomed.map((chat) => chat.ids),
      ),
    ).toEqual([]);
    expect(secretKeys(after)).toHaveLength(1);
    const lost = allSentinels(...kept.map((chat) => chat.sentinels))
      .filter(([, value]) => holding(after, value).length === 0)
      .map(([name, value]) => `${name}:${value}`);
    expect(lost).toEqual([]);
  });
});
