import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { createOperationHandler, principalFromApiKey } from '@lostgradient/weft';
import {
  createAgentRunEventFeed,
  createAgentRunEventRegistry,
  RunStartedEvent,
  runEventsSubscriptionOperation,
  StepStartedEvent,
} from '@lostgradient/operative';
import { Conversation, createConversationHistory } from 'conversationalist';
import { describe, expect, it } from 'bun:test';

import { type BureauEventEnvelope, createBureauEventFeed } from './bureau-event-feed.ts';
import {
  bureauEventEnvelopeSchema,
  type BureauEventsOperationHost,
  bureauEventsSubscriptionOperation,
  createBureauEventRegistry,
} from './bureau-events-operation.ts';
import { BureauDisposedEvent, RunRegisteredEvent, RunRemovedEvent } from './events.ts';
import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';

function invoke(
  input: { bureauId: string; fromCursor?: string; kinds?: string | string[] },
  host: BureauEventsOperationHost,
) {
  const definition = bureauEventsSubscriptionOperation as unknown as {
    invoke: (args: { input: typeof input; host: unknown }) => Promise<{
      envelope: { subscriptionId: string; cursor: string };
      iterable: AsyncIterable<BureauEventEnvelope> & { close(): Promise<void> };
      close(): Promise<void>;
    }>;
  };
  return definition.invoke({ input, host });
}

describe('the bureau.events subscription', () => {
  it('declares itself on the WebSocket and HTTP transports only', () => {
    const declaration = bureauEventsSubscriptionOperation as unknown as {
      name: string;
      kind: string;
      transports: Record<string, boolean>;
    };
    expect(declaration.name).toBe('bureau.events');
    expect(declaration.kind).toBe('subscription');
    expect(declaration.transports).toMatchObject({
      http: true,
      jsonRpcHttp: false,
      jsonRpcWebSocket: true,
      jsonRpcStdio: false,
    });
  });

  it('refuses a bureau the registry does not know', async () => {
    expect(
      await throwingRejectionOf(
        invoke({ bureauId: 'missing' }, { bureauFeeds: createBureauEventRegistry() }),
      ),
    ).toThrow(/Unknown bureau "missing"/);
  });

  it('delivers only the kinds a subscriber asked for', async () => {
    const registry = createBureauEventRegistry();
    const bureauFeed = createBureauEventFeed({ bureauId: 'bureau-1' });
    registry.set('bureau-1', bureauFeed);
    bureauFeed.publish(new RunRegisteredEvent('run-1'));
    bureauFeed.publish(new RunRemovedEvent('run-1'));
    bureauFeed.publish(new BureauDisposedEvent());

    const subscription = await invoke(
      { bureauId: 'bureau-1', kinds: ['run.removed', 'bureau.disposed'] },
      { bureauFeeds: registry },
    );
    const seen: BureauEventEnvelope[] = [];
    for await (const envelope of subscription.iterable) {
      seen.push(envelope);
      if (seen.length >= 2) break;
    }

    expect(seen.map((envelope) => envelope.kind)).toEqual(['run.removed', 'bureau.disposed']);
    // Sequences are over the unfiltered stream, so the skipped event's number
    // is absent rather than renumbered.
    expect(seen.map((envelope) => envelope.sequence)).toEqual([1, 2]);
    await subscription.close();
    bureauFeed.dispose();
  });

  it('accepts a bare kind as well as a list', async () => {
    const registry = createBureauEventRegistry();
    const bureauFeed = createBureauEventFeed({ bureauId: 'bureau-1' });
    registry.set('bureau-1', bureauFeed);
    bureauFeed.publish(new RunRegisteredEvent('run-1'));
    bureauFeed.publish(new RunRemovedEvent('run-1'));

    const subscription = await invoke(
      { bureauId: 'bureau-1', kinds: 'run.removed' },
      { bureauFeeds: registry },
    );
    const seen: BureauEventEnvelope[] = [];
    for await (const envelope of subscription.iterable) {
      seen.push(envelope);
      break;
    }

    expect(seen.map((envelope) => envelope.kind)).toEqual(['run.removed']);
    await subscription.close();
    bureauFeed.dispose();
  });

  it('resumes from a cursor', async () => {
    const registry = createBureauEventRegistry();
    const bureauFeed = createBureauEventFeed({ bureauId: 'bureau-1' });
    registry.set('bureau-1', bureauFeed);
    const first = bureauFeed.publish(new RunRegisteredEvent('run-1'));
    bureauFeed.publish(new RunRemovedEvent('run-1'));
    if (first === undefined) throw new Error('the first event must have been published');

    const resumed: BureauEventEnvelope[] = [];
    for await (const envelope of bureauFeed.feed.replay({ fromCursor: first.cursor })) {
      resumed.push(envelope);
    }

    expect(resumed.map((envelope) => envelope.sequence)).toEqual([1]);
    bureauFeed.dispose();
  });

  it('validates published envelopes against its declared event schema', () => {
    const bureauFeed = createBureauEventFeed({ bureauId: 'bureau-1' });
    const envelope = bureauFeed.publish(new RunRegisteredEvent('run-1'));

    expect(bureauEventEnvelopeSchema.safeParse(envelope).success).toBe(true);
    bureauFeed.dispose();
  });

  it('mints the subscription id through the injected runtime', async () => {
    const registry = createBureauEventRegistry();
    const bureauFeed = createBureauEventFeed({ bureauId: 'bureau-1' });
    registry.set('bureau-1', bureauFeed);
    const runtime = createManualRuntimeServices({ identifierSeed: 'bureau-events-operation' });
    const reference = createManualRuntimeServices({ identifierSeed: 'bureau-events-operation' });

    const first = await invoke({ bureauId: 'bureau-1' }, { bureauFeeds: registry, runtime });
    const second = await invoke({ bureauId: 'bureau-1' }, { bureauFeeds: registry, runtime });

    expect(first.envelope.subscriptionId).toBe(
      `sub_${reference.identifiers.next('bureau-subscription')}`,
    );
    expect(second.envelope.subscriptionId).toBe(
      `sub_${reference.identifiers.next('bureau-subscription')}`,
    );
    expect(second.envelope.subscriptionId).not.toBe(first.envelope.subscriptionId);
    await first.close();
    await second.close();
    bureauFeed.dispose();
  });

  it('falls back to a default runtime when none is supplied', async () => {
    const registry = createBureauEventRegistry();
    const bureauFeed = createBureauEventFeed({ bureauId: 'bureau-1' });
    registry.set('bureau-1', bureauFeed);

    const first = await invoke({ bureauId: 'bureau-1' }, { bureauFeeds: registry });
    const second = await invoke({ bureauId: 'bureau-1' }, { bureauFeeds: registry });

    // A fresh default runtime is created per invocation, so its per-kind
    // counter is always at 1; the trailing UUID is what keeps the ids unique.
    const defaultRuntimeIdentifier =
      /^sub_bureau-subscription-1-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    expect(first.envelope.subscriptionId).toMatch(defaultRuntimeIdentifier);
    expect(second.envelope.subscriptionId).toMatch(defaultRuntimeIdentifier);
    expect(second.envelope.subscriptionId).not.toBe(first.envelope.subscriptionId);
    await first.close();
    await second.close();
    bureauFeed.dispose();
  });
});

/**
 * The proof that a fetch handler serves both event operations with no Weft
 * `Engine`: nothing in this file constructs one, and the only Weft values it
 * imports are the handler and a principal.
 */
describe('bureau.events through createOperationHandler with no Engine', () => {
  /** Read SSE frames, skipping the keepalive and replay-complete pings. */
  async function readEventFrames(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    count: number,
  ): Promise<string[]> {
    const decoder = new TextDecoder();
    const frames: string[] = [];
    let buffer = '';
    while (frames.length < count) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        if (!frame.startsWith('event: ping')) frames.push(frame);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');
      }
    }
    return frames;
  }

  const authenticate = async () => ({
    method: 'api-key' as const,
    principal: principalFromApiKey({ subject: 'reader', scopes: ['events:read'] }),
  });
  const request = (path: string, headers: Record<string, string> = {}) =>
    new Request(`http://localhost${path}`, {
      headers: { Accept: 'text/event-stream', ...headers },
    });

  function frameField(frame: string, field: string): string | undefined {
    return frame
      .split('\n')
      .find((line) => line.startsWith(`${field}: `))
      ?.slice(field.length + 2);
  }

  function serve(
    bureauFeeds = createBureauEventRegistry(),
    runFeeds = createAgentRunEventRegistry(),
  ) {
    return createOperationHandler({
      operations: [bureauEventsSubscriptionOperation, runEventsSubscriptionOperation],
      host: { bureauFeeds, runFeeds },
      authenticate,
    });
  }

  it('replays and follows a bureau feed over Server-Sent Events with no Engine constructed', async () => {
    const bureauFeeds = createBureauEventRegistry();
    const bureauFeed = createBureauEventFeed({ bureauId: 'bureau-1' });
    bureauFeeds.set('bureau-1', bureauFeed);
    bureauFeed.publish(new RunRegisteredEvent('run-1'));
    const handler = serve(bureauFeeds);

    const response = await handler(request('/v1/subscriptions/bureau.events?bureauId=bureau-1'));
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const [replayed] = await readEventFrames(reader, 1);
    bureauFeed.publish(new RunRemovedEvent('run-1'));
    const [live] = await readEventFrames(reader, 1);
    await reader.cancel();

    expect(frameField(replayed ?? '', 'event')).toBe('run.registered');
    expect(frameField(live ?? '', 'event')).toBe('run.removed');

    const resumed = await handler(
      request('/v1/subscriptions/bureau.events?bureauId=bureau-1', {
        'Last-Event-ID': frameField(replayed ?? '', 'id') ?? '',
      }),
    );
    const resumedReader = resumed.body!.getReader();
    const [first] = await readEventFrames(resumedReader, 1);
    await resumedReader.cancel();
    expect(frameField(first ?? '', 'event')).toBe('run.removed');
    bureauFeed.dispose();
  });

  it('marks the end of the replay with a ping that carries no cursor', async () => {
    const bureauFeeds = createBureauEventRegistry();
    const bureauFeed = createBureauEventFeed({ bureauId: 'bureau-1' });
    bureauFeeds.set('bureau-1', bureauFeed);
    bureauFeed.publish(new RunRegisteredEvent('run-1'));
    const handler = serve(bureauFeeds);

    const response = await handler(request('/v1/subscriptions/bureau.events?bureauId=bureau-1'));
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('replayComplete')) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    await reader.cancel();

    const ping = text.split('\n\n').find((frame) => frame.includes('replayComplete')) ?? '';
    expect(ping).toStartWith('event: ping');
    expect(ping).not.toContain('id:');
    bureauFeed.dispose();
  });

  it('replays, follows, and resumes a run feed over Server-Sent Events with no Engine constructed', async () => {
    const runFeeds = createAgentRunEventRegistry();
    const runFeed = createAgentRunEventFeed({ runId: 'run-1' });
    runFeeds.set('run-1', runFeed);
    const conversation = new Conversation(createConversationHistory());
    runFeed.publish(new RunStartedEvent(conversation));
    const handler = serve(createBureauEventRegistry(), runFeeds);

    const response = await handler(request('/v1/subscriptions/operative.runs.events?runId=run-1'));
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const [replayed] = await readEventFrames(reader, 1);
    runFeed.publish(new StepStartedEvent(conversation, 0));
    const [live] = await readEventFrames(reader, 1);
    await reader.cancel();

    expect(frameField(replayed ?? '', 'event')).toBe('run.started');
    expect(frameField(live ?? '', 'event')).toBe('step.started');

    const resumed = await handler(
      request('/v1/subscriptions/operative.runs.events?runId=run-1', {
        'Last-Event-ID': frameField(replayed ?? '', 'id') ?? '',
      }),
    );
    const resumedReader = resumed.body!.getReader();
    const [first] = await readEventFrames(resumedReader, 1);
    await resumedReader.cancel();
    expect(frameField(first ?? '', 'event')).toBe('step.started');
    runFeed.dispose();
  });

  it('answers 404, not 500, for a bureau or run that does not exist', async () => {
    const handler = serve();

    const bureau = await handler(request('/v1/subscriptions/bureau.events?bureauId=missing'));
    const run = await handler(request('/v1/subscriptions/operative.runs.events?runId=missing'));

    expect(bureau.status).toBe(404);
    expect(run.status).toBe(404);
  });

  it('answers 400, not 500, for a malformed cursor in Last-Event-ID or fromCursor', async () => {
    const bureauFeeds = createBureauEventRegistry();
    bureauFeeds.set('bureau-1', createBureauEventFeed({ bureauId: 'bureau-1' }));
    const runFeeds = createAgentRunEventRegistry();
    runFeeds.set('run-1', createAgentRunEventFeed({ runId: 'run-1' }));
    const handler = serve(bureauFeeds, runFeeds);
    const bureauPath = '/v1/subscriptions/bureau.events?bureauId=bureau-1';
    const runPath = '/v1/subscriptions/operative.runs.events?runId=run-1';

    const statuses = await Promise.all([
      handler(request(bureauPath, { 'Last-Event-ID': 'not-a-cursor' })),
      handler(request(runPath, { 'Last-Event-ID': 'not-a-cursor' })),
      handler(request(`${bureauPath}&fromCursor=nope`)),
      handler(request(`${runPath}&fromCursor=nope`)),
    ]).then((responses) => responses.map((response) => response.status));

    expect(statuses).toEqual([400, 400, 400, 400]);
  });

  it('lists both operations in the AsyncAPI, OpenRPC, and OpenAPI documents it serves', async () => {
    const handler = createOperationHandler({
      operations: [bureauEventsSubscriptionOperation, runEventsSubscriptionOperation],
      host: { bureauFeeds: createBureauEventRegistry(), runFeeds: createAgentRunEventRegistry() },
    });
    const read = async (path: string) => {
      const response = await handler(new Request(`http://localhost${path}`));
      return (await response.json()) as Record<string, unknown>;
    };

    const asyncApi = await read('/asyncapi.json');
    const openRpc = await read('/openrpc.json');
    const openApi = await read('/openapi.json');

    const channels = asyncApi['channels'] as Record<string, { address: string }>;
    expect(Object.values(channels).map((channel) => channel.address)).toEqual([
      '/v1/subscriptions/bureau.events',
      '/v1/subscriptions/operative.runs.events',
    ]);
    expect((openRpc['methods'] as { name: string }[]).map((method) => method.name)).toEqual([
      'bureau.events',
      'operative.runs.events',
      'rpc.discover',
    ]);
    expect(Object.keys(openApi['paths'] as object).toSorted()).toEqual([
      '/asyncapi.json',
      '/openapi.json',
      '/openrpc.json',
      '/v1/health',
    ]);
  });
});
