/**
 * COR-2009 — the sample world's seed, part A, asserted against the host it leaves running: the
 * chats with their titles, times and states, the two reviews waiting on you, Tool runner's Versions
 * 1 to 4, the four memories the Memory page lists (and the correction's history), and the audit
 * entries the story leaves, each at the moment the story gives it. The story's clock runs on in real
 * time between the moments the seed sets, so a time is asserted as the moment it was set to, plus at
 * most {@link SLACK}.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Host } from '../src/host/host.ts';
import { SHOWCASE_ASSISTANT_REPLY, SHOWCASE_HUMAN_INPUT } from '../src/host/showcase-agents.ts';
import {
  REFUND_4471_ASK_DELAY_MILLISECONDS,
  SAMPLE_WORLD_CHATS,
  SAMPLE_WORLD_TIMES,
  seedSampleWorld,
  TOOL_RUNNER_CORRECTION,
  TOOL_RUNNER_HOW_TOS,
  type SampleWorld,
} from './sample-world-seed.ts';

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
  test('holds the four chats, each with its title, agent, time and state', async () => {
    const { contexts } = await call<{ contexts: ContextRow[] }>('bureau.contexts.list', {});
    const byId = new Map(contexts.map((context) => [context.id, context]));
    expect(contexts.map((context) => context.id)).toEqual([
      SAMPLE_WORLD_CHATS.refund.threadId,
      SAMPLE_WORLD_CHATS.release.threadId,
      SAMPLE_WORLD_CHATS.sayHello.threadId,
      SAMPLE_WORLD_CHATS.billing.threadId,
    ]);

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
