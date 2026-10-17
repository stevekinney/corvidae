import {
  createAgentSession,
  createSessionInputDeliveryStore,
  createSessionStore,
} from '@lostgradient/operative';
import { type ApplicationCommandClaim, resolveStorage, textValueStore } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';
import { createConversationHistory } from 'conversationalist';

import {
  admitSessionInput,
  createSessionInputMailbox,
  SESSION_INPUT_COMMAND_TIMEOUT_MS,
  SESSION_INPUT_DELIVERY_RETENTION_MS,
} from './session-input-durability';
import {
  createSessionInputDeliveryGate,
  decodeSessionInputCommand,
} from './session-input-delivery';

/**
 * COR-1476 — the Bureau half of session-input delivery: what a stored command
 * must look like to be delivered, that an input does not silently expire while a
 * run is parked, and that a recreated session never inherits a deleted one's
 * input.
 */

const SESSION_ID = 'gate-session';
const INCARNATION = 'incarnation-1';
const HOUR_MS = 3_600_000;
const START = Date.parse('2026-01-01T00:00:00.000Z');

function claimWith(value: unknown, kind = 'session-input:steer'): ApplicationCommandClaim {
  return {
    receipt: { kind, commandId: 'command-1', idempotencyKey: 'input-1' },
    payload: { form: 'inline', value, digest: 'digest', verified: true },
    attemptToken: 'token',
  } as unknown as ApplicationCommandClaim;
}

describe('decodeSessionInputCommand (COR-1476)', () => {
  it('reads a well-formed stored input', () => {
    expect(
      decodeSessionInputCommand(
        claimWith({ incarnation: INCARNATION, payload: 'hello' }),
        INCARNATION,
      ),
    ).toEqual({ payload: 'hello', deliveryMode: 'steer' });
    expect(
      decodeSessionInputCommand(
        claimWith(
          {
            incarnation: INCARNATION,
            expiresAt: '2030-01-01T00:00:00.000Z',
            payload: [
              { type: 'text', text: 'look' },
              { type: 'image', url: 'https://example.invalid/a.png', mimeType: 'image/png' },
              {
                type: 'document',
                name: 'q3.pdf',
                mimeType: 'application/pdf',
                source: { kind: 'reference', uri: 'file:///q3.pdf' },
              },
            ],
          },
          'session-input:queue',
        ),
        INCARNATION,
      ),
    ).toEqual({
      deliveryMode: 'queue',
      payload: [
        { type: 'text', text: 'look' },
        { type: 'image', url: 'https://example.invalid/a.png', mimeType: 'image/png' },
        {
          type: 'document',
          name: 'q3.pdf',
          mimeType: 'application/pdf',
          source: { kind: 'reference', uri: 'file:///q3.pdf' },
        },
      ],
    });
  });

  it.each([
    ['a non-object value', 'just a string'],
    ['an array value', []],
    ['a missing incarnation', { payload: 'hello' }],
    ['a numeric payload', { incarnation: INCARNATION, payload: 42 }],
    ['a missing payload', { incarnation: INCARNATION }],
    ['an object payload', { incarnation: INCARNATION, payload: { text: 'hello' } }],
    ['a null part', { incarnation: INCARNATION, payload: [null] }],
    ['a part with no type', { incarnation: INCARNATION, payload: [{ text: 'hello' }] }],
    [
      'a provider-generated part',
      { incarnation: INCARNATION, payload: [{ type: 'thinking', thinking: 'x', signature: 's' }] },
    ],
    ['a text part with no text', { incarnation: INCARNATION, payload: [{ type: 'text' }] }],
    [
      'a text part carrying citations',
      { incarnation: INCARNATION, payload: [{ type: 'text', text: 'x', citations: null }] },
    ],
    ['an image with no url', { incarnation: INCARNATION, payload: [{ type: 'image' }] }],
    [
      'a document with a bad source',
      {
        incarnation: INCARNATION,
        payload: [
          { type: 'document', name: 'n', mimeType: 'm', source: { kind: 'ftp', host: 'x' } },
        ],
      },
    ],
    ['a non-string expiresAt', { incarnation: INCARNATION, payload: 'x', expiresAt: 5 }],
    ['another incarnation', { incarnation: 'incarnation-0', payload: 'hello' }],
  ])('refuses %s', (_name, value) => {
    expect(() => decodeSessionInputCommand(claimWith(value), INCARNATION)).toThrow();
  });

  it('refuses a kind it never produced', () => {
    expect(() =>
      decodeSessionInputCommand(
        claimWith({ incarnation: INCARNATION, payload: 'x' }, 'session-input:other'),
        INCARNATION,
      ),
    ).toThrow();
  });
});

async function createFixture() {
  const storage = await resolveStorage({ type: 'memory' });
  const sessionStore = createSessionStore(textValueStore(storage));
  const deliveryStore = createSessionInputDeliveryStore(textValueStore(storage), {
    retentionMs: SESSION_INPUT_DELIVERY_RETENTION_MS,
    nowMs: () => START,
  });
  const session = createAgentSession({
    id: SESSION_ID,
    agentName: 'agent',
    conversationHistory: createConversationHistory({ id: SESSION_ID }),
  });
  await sessionStore.save(session);
  const saved = await sessionStore.load(SESSION_ID);
  if (saved === undefined) throw new Error('fixture session missing');
  return { storage, sessionStore, deliveryStore, incarnation: saved.incarnation };
}

describe('session input delivery gate (COR-1476)', () => {
  async function admitAs(
    fixture: Awaited<ReturnType<typeof createFixture>>,
    mailbox: ReturnType<typeof createSessionInputMailbox>,
    id: string,
    now: number,
    incarnation = fixture.incarnation,
  ) {
    const outcome = await admitSessionInput({
      storage: fixture.storage,
      kv: textValueStore(fixture.storage),
      sessionMailbox: mailbox,
      sessionId: SESSION_ID,
      id,
      principal: 'alice',
      deliveryMode: 'steer',
      payload: { incarnation, payload: `text of ${id}` },
      principalBacklogLimit: 100,
      sessionBacklogLimitForCrossSessionRead: 100,
      nowMs: now,
    });
    expect(outcome.outcome).toBe('admitted');
  }

  function gateFor(
    fixture: Awaited<ReturnType<typeof createFixture>>,
    mailbox: ReturnType<typeof createSessionInputMailbox>,
    runId = 'run-1',
  ) {
    return createSessionInputDeliveryGate({
      sessionId: SESSION_ID,
      runId,
      incarnation: fixture.incarnation,
      mailbox,
      deliveryStore: fixture.deliveryStore,
      isOwnerLive: () => Promise.resolve(true),
      now: () => START,
    });
  }

  it('still delivers an input after the mailbox default of an hour, with its receipt unspent', async () => {
    const fixture = await createFixture();
    let now = START;
    const mailbox = createSessionInputMailbox(fixture.storage, SESSION_ID, 100, () => now);
    await admitAs(fixture, mailbox, 'input-a', now);

    // The run was parked on a human reviewer for two hours.
    now += 2 * HOUR_MS;
    const gate = gateFor(fixture, mailbox);
    const delivered = await gate.claimPending();
    expect(delivered.map(({ id, payload }) => [id, payload])).toEqual([
      ['input-a', 'text of input-a'],
    ]);

    await gate.settle(
      delivered.map(({ id, commandId }) => ({
        id,
        commandId,
        sessionId: SESSION_ID,
        deliveredAt: new Date(START).toISOString(),
        conversationMessageId: 'message-a',
        providerTurn: 4,
      })),
    );
    const capacity = await mailbox.capacity();
    expect(capacity.open).toBe(0);
  });

  it('closes an input nobody could deliver with an honest terminal receipt, not an eternal accepted', async () => {
    const fixture = await createFixture();
    let now = START;
    const mailbox = createSessionInputMailbox(fixture.storage, SESSION_ID, 100, () => now);
    await admitAs(fixture, mailbox, 'input-a', now);

    now += SESSION_INPUT_COMMAND_TIMEOUT_MS + HOUR_MS;
    expect(await gateFor(fixture, mailbox).claimPending()).toEqual([]);

    const [receipt] = await mailbox.list({ limit: 10 });
    expect(receipt?.state).toBe('dead-lettered');
    expect(receipt?.failure?.reason).toBe('deadline-exceeded');
  });

  it('refuses input admitted to an earlier incarnation of the session, without retry', async () => {
    const fixture = await createFixture();
    const now = START;
    const mailbox = createSessionInputMailbox(fixture.storage, SESSION_ID, 100, () => now);
    await admitAs(fixture, mailbox, 'stale', now, 'incarnation-of-a-deleted-session');
    await admitAs(fixture, mailbox, 'fresh', now);

    const delivered = await gateFor(fixture, mailbox).claimPending();
    expect(delivered.map(({ id }) => id)).toEqual(['fresh']);
    const rejected = await mailbox.list({ states: ['rejected'], limit: 10 });
    expect(rejected.map(({ idempotencyKey }) => idempotencyKey)).toEqual(['stale']);
  });
});
