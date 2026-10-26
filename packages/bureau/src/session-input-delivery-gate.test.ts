import {
  createAgentSession,
  createSessionInputDeliveryStore,
  createSessionStore,
  type SessionInputPayload,
} from '@lostgradient/operative';
import { type ApplicationCommandClaim, resolveStorage, textValueStore } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';
import { CURRENT_SCHEMA_VERSION, createConversationHistory } from 'conversationalist';

import {
  admitSessionInput,
  createSessionInputMailbox,
  SESSION_INPUT_COMMAND_TIMEOUT_MS,
  SESSION_INPUT_DELIVERY_RETENTION_MS,
  SESSION_INPUT_EXPIRED_MESSAGE,
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
const SCHEMA_VERSION = CURRENT_SCHEMA_VERSION;

const MEDIA_PAYLOAD: SessionInputPayload = [
  { type: 'text', text: 'look' },
  {
    type: 'image',
    mimeType: 'image/png',
    source: { kind: 'remote-url', url: 'https://example.invalid/a.png' },
  },
  {
    type: 'document',
    name: 'q3.pdf',
    mimeType: 'application/pdf',
    source: { kind: 'managed-asset', assetId: 'asset-1', revision: 2 },
  },
  { type: 'audio', source: { kind: 'inline', data: 'QUJD', encoding: 'base64' } },
];

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
        claimWith({ schemaVersion: SCHEMA_VERSION, incarnation: INCARNATION, payload: 'hello' }),
        INCARNATION,
      ),
    ).toEqual({ payload: 'hello', deliveryMode: 'steer' });
    expect(
      decodeSessionInputCommand(
        claimWith(
          {
            schemaVersion: SCHEMA_VERSION,
            incarnation: INCARNATION,
            expiresAt: '2030-01-01T00:00:00.000Z',
            payload: MEDIA_PAYLOAD,
          },
          'session-input:queue',
        ),
        INCARNATION,
      ),
    ).toEqual({ deliveryMode: 'queue', payload: MEDIA_PAYLOAD });
  });

  it.each([
    ['a non-object value', 'just a string', /must be stored as an object/],
    ['an array value', [], /must be stored as an object/],
    [
      'a missing incarnation',
      { schemaVersion: SCHEMA_VERSION, payload: 'hello' },
      /must record the session incarnation/,
    ],
    [
      'a numeric payload',
      { schemaVersion: SCHEMA_VERSION, incarnation: INCARNATION, payload: 42 },
      /must be a string or an array of content parts/,
    ],
    [
      'a missing payload',
      { schemaVersion: SCHEMA_VERSION, incarnation: INCARNATION },
      /must be a string or an array of content parts/,
    ],
    [
      'an object payload',
      { schemaVersion: SCHEMA_VERSION, incarnation: INCARNATION, payload: { text: 'hello' } },
      /must be a string or an array of content parts/,
    ],
    [
      'a null part',
      { schemaVersion: SCHEMA_VERSION, incarnation: INCARNATION, payload: [null] },
      /part 0 is not valid content/,
    ],
    [
      'a part with no type',
      { schemaVersion: SCHEMA_VERSION, incarnation: INCARNATION, payload: [{ text: 'hello' }] },
      /part 0 is not valid content/,
    ],
    [
      'a provider-generated part',
      {
        schemaVersion: SCHEMA_VERSION,
        incarnation: INCARNATION,
        payload: [{ type: 'thinking', thinking: 'x', signature: 's' }],
      },
      /part 0 has an unsupported type/,
    ],
    [
      'a text part with no text',
      { schemaVersion: SCHEMA_VERSION, incarnation: INCARNATION, payload: [{ type: 'text' }] },
      /part 0 is not valid content/,
    ],
    [
      'a text part carrying citations',
      {
        schemaVersion: SCHEMA_VERSION,
        incarnation: INCARNATION,
        payload: [{ type: 'text', text: 'x', citations: null }],
      },
      /part 0 has an unsupported type/,
    ],
    [
      'an image with no source',
      { schemaVersion: SCHEMA_VERSION, incarnation: INCARNATION, payload: [{ type: 'image' }] },
      /part 0 is not valid content/,
    ],
    [
      'an image in the shape before the media schema',
      {
        schemaVersion: SCHEMA_VERSION,
        incarnation: INCARNATION,
        payload: [{ type: 'image', url: 'https://example.invalid/a.png', mimeType: 'image/png' }],
      },
      /part 0 is not valid content/,
    ],
    [
      'an image whose remote-url is not http',
      {
        schemaVersion: SCHEMA_VERSION,
        incarnation: INCARNATION,
        payload: [{ type: 'image', source: { kind: 'remote-url', url: 's3://bucket/a.png' } }],
      },
      /part 0 is not valid content/,
    ],
    [
      'an empty part list',
      { schemaVersion: SCHEMA_VERSION, incarnation: INCARNATION, payload: [] },
      /must not be an empty list/,
    ],
    [
      'a missing schema version',
      { incarnation: INCARNATION, payload: 'hello' },
      /unsupported schema version/,
    ],
    [
      'a schema version from before this build',
      { schemaVersion: SCHEMA_VERSION - 1, incarnation: INCARNATION, payload: 'hello' },
      /unsupported schema version/,
    ],
    [
      'a schema version from after this build',
      { schemaVersion: SCHEMA_VERSION + 1, incarnation: INCARNATION, payload: 'hello' },
      /unsupported schema version/,
    ],
    [
      'a schema version that is not a number',
      { schemaVersion: String(SCHEMA_VERSION), incarnation: INCARNATION, payload: 'hello' },
      /unsupported schema version/,
    ],
    [
      'a document with a bad source',
      {
        schemaVersion: SCHEMA_VERSION,
        incarnation: INCARNATION,
        payload: [
          { type: 'document', name: 'n', mimeType: 'm', source: { kind: 'ftp', host: 'x' } },
        ],
      },
      /part 0 is not valid content/,
    ],
    [
      'a non-string expiresAt',
      { schemaVersion: SCHEMA_VERSION, incarnation: INCARNATION, payload: 'x', expiresAt: 5 },
      /expiresAt must be a string/,
    ],
    [
      'another incarnation',
      { schemaVersion: SCHEMA_VERSION, incarnation: 'incarnation-0', payload: 'hello' },
      /earlier incarnation/,
    ],
  ])('refuses %s', (_name, value, error) => {
    expect(() => decodeSessionInputCommand(claimWith(value), INCARNATION)).toThrow(error);
  });

  it('refuses a stored input whose expiresAt has passed, with the message its receipt reads as expired', () => {
    const value = {
      schemaVersion: SCHEMA_VERSION,
      incarnation: INCARNATION,
      payload: 'late',
      expiresAt: '2030-01-01T00:00:00.000Z',
    };

    expect(() =>
      decodeSessionInputCommand(
        claimWith(value),
        INCARNATION,
        Date.parse('2030-01-01T00:00:00.000Z'),
      ),
    ).toThrow(SESSION_INPUT_EXPIRED_MESSAGE);
    expect(
      decodeSessionInputCommand(
        claimWith(value),
        INCARNATION,
        Date.parse('2029-12-31T23:59:59.999Z'),
      ),
    ).toMatchObject({ payload: 'late' });
  });

  it('refuses a kind it never produced', () => {
    expect(() =>
      decodeSessionInputCommand(
        claimWith(
          { schemaVersion: SCHEMA_VERSION, incarnation: INCARNATION, payload: 'x' },
          'session-input:other',
        ),
        INCARNATION,
      ),
    ).toThrow(/Unrecognized session-input mailbox command kind/);
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
      incarnation: fixture.incarnation,
      id,
      principal: 'alice',
      deliveryMode: 'steer',
      payload: { schemaVersion: SCHEMA_VERSION, incarnation, payload: `text of ${id}` },
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
    const mailbox = createSessionInputMailbox(
      fixture.storage,
      SESSION_ID,
      fixture.incarnation,
      100,
      () => now,
    );
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
    const mailbox = createSessionInputMailbox(
      fixture.storage,
      SESSION_ID,
      fixture.incarnation,
      100,
      () => now,
    );
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
    const mailbox = createSessionInputMailbox(
      fixture.storage,
      SESSION_ID,
      fixture.incarnation,
      100,
      () => now,
    );
    await admitAs(fixture, mailbox, 'stale', now, 'incarnation-of-a-deleted-session');
    await admitAs(fixture, mailbox, 'fresh', now);

    const delivered = await gateFor(fixture, mailbox).claimPending();
    expect(delivered.map(({ id }) => id)).toEqual(['fresh']);
    const rejected = await mailbox.list({ states: ['rejected'], limit: 10 });
    expect(rejected.map(({ idempotencyKey }) => idempotencyKey)).toEqual(['stale']);
  });
});
