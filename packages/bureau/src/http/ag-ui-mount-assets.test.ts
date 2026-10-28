/**
 * COR-1547 — multimodal content over the AG-UI mount. A user message may carry a managed asset as
 * a `file` part from the provider `bureau`; an agent's generated assets reach the stream as
 * `bureau.asset-part` `CUSTOM` events, in order, inside the message that holds them; a reloaded
 * thread's snapshot holds both; and a model that does not take a kind of media is refused before
 * it is called, with `UNSUPPORTED_MEDIA_TYPE`.
 */
import { EventType, type Event } from '@ag-ui/core';
import {
  createModelCatalog,
  type BackendDescriptor,
  waitForCondition,
} from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { base64Of, pngBytes, wavBytes } from '../testing/asset-fixtures.test-support.ts';
import {
  as,
  authentication,
  type Harness,
  openHarness,
  runAgentInput,
  startRequest,
} from './ag-ui-fixtures.test-support.ts';
import { bureauMetadata, readAgUiStream, typesOf } from './ag-ui-stream.test-support.ts';
import { listHeldTasks } from '../test';

const LOCAL = 'anonymous:local';

const anthropic = createModelCatalog().descriptors.filter(
  (descriptor) => descriptor.provider === 'anthropic',
);
/** A model that takes images and documents in and, unlike any catalog row, puts images out. */
const imageOutput: readonly BackendDescriptor[] = anthropic.slice(0, 1).map((descriptor) => ({
  ...descriptor,
  modalities: {
    ...descriptor.modalities,
    image: { ...descriptor.modalities.image, output: true },
  },
}));

async function withHarness<T>(
  options: Parameters<typeof openHarness>[0],
  body: (harness: Harness) => Promise<T>,
): Promise<T> {
  const harness = await openHarness(options);
  try {
    return await body(harness);
  } finally {
    await harness.dispose();
  }
}

const say = (content: string) => ({
  kind: 'respond' as const,
  response: { content, toolCalls: [] },
});

const generatedImage = (padding: number) => ({
  type: 'image' as const,
  mimeType: 'image/png',
  source: {
    kind: 'inline' as const,
    data: base64Of(pngBytes(4, 3, padding)),
    encoding: 'base64' as const,
  },
});

/** Admits `bytes` as `owner` and waits for it to settle; returns the asset's id. */
async function admit(harness: Harness, bytes: Uint8Array, owner = LOCAL, declared?: string) {
  const admission = await harness.bureau.assets!.admit(
    {
      source: { kind: 'inline', bytes },
      ...(declared === undefined ? {} : { declaredMediaType: declared }),
    },
    { id: owner },
  );
  await admission.work.result();
  return admission.assetId;
}

const attachment = (assetId: string, mimeType?: string) => ({
  type: 'image' as const,
  source: {
    type: 'file' as const,
    value: assetId,
    provider: 'bureau',
    ...(mimeType === undefined ? {} : { mimeType }),
  },
});

const userInput = (parts: unknown[], overrides: Record<string, unknown> = {}) =>
  runAgentInput({
    messages: [{ id: 'user-1', role: 'user', content: parts as never }],
    ...overrides,
  });

const messagesRequest = (threadId: string, headers: Record<string, string> = {}) =>
  new Request(`http://localhost/ag-ui/threads/${encodeURIComponent(threadId)}/messages`, {
    headers,
  });

type SnapshotMessage = {
  id: string;
  role: string;
  content?: string | Array<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
};

async function messagesOf(
  harness: Harness,
  headers: Record<string, string> = {},
): Promise<SnapshotMessage[]> {
  const response = await harness.handler(messagesRequest('thread-1', headers));
  expect(response.status).toBe(200);
  return ((await response.json()) as { messages: SnapshotMessage[] }).messages;
}

describe('a user message carrying a managed asset', () => {
  it('becomes a managed-asset part, the run is generated with the resolved asset, and the snapshot returns the part unchanged', async () => {
    await withHarness(
      { script: [say('A small image.')], backends: anthropic.slice(0, 1) },
      async (harness) => {
        const assetId = await admit(harness, pngBytes(4, 3, 64));
        const part = attachment(assetId, 'image/png');

        const frames = await readAgUiStream(
          await harness.handler(
            startRequest(userInput([{ type: 'text', text: 'What is this?' }, part])),
          ),
        );

        expect(frames.at(-1)?.event.type).toBe(EventType.RUN_FINISHED);
        const session = await harness.bureau.contexts.get('thread-1');
        const row = session!.conversationHistory.messages['user-1']!;
        expect(row.content).toEqual([
          { type: 'text', text: 'What is this?' },
          { type: 'image', mimeType: 'image/png', source: { kind: 'managed-asset', assetId } },
        ]);
        // The model was handed the asset's bytes, resolved as the run's owner.
        const [call] = harness.generate.calls;
        const resolved = call!.context.resolvedSources?.get('user-1:1');
        expect(resolved?.source).toMatchObject({ kind: 'inline', encoding: 'base64' });
        expect(resolved?.mimeType).toBe('image/png');

        const messages = await messagesOf(harness);
        const user = messages.find((message) => message.id === 'user-1')!;
        expect(user.content).toEqual([{ type: 'text', text: 'What is this?' }, part]);
      },
    );
  });

  it('needs no mimeType: the asset’s detected media type is the one the model is given', async () => {
    await withHarness(
      { script: [say('Seen.')], backends: anthropic.slice(0, 1) },
      async (harness) => {
        const assetId = await admit(harness, pngBytes(4, 3, 64));

        const frames = await readAgUiStream(
          await harness.handler(startRequest(userInput([attachment(assetId)]))),
        );

        expect(frames.at(-1)?.event.type).toBe(EventType.RUN_FINISHED);
        const resolved = harness.generate.calls[0]!.context.resolvedSources?.get('user-1:0');
        expect(resolved?.mimeType).toBe('image/png');
      },
    );
  });

  it('is refused at the door, with the refusal of a missing asset, when another owner holds the asset', async () => {
    await withHarness(
      { script: [say('Seen.')], backends: anthropic.slice(0, 1), authentication },
      async (harness) => {
        const assetId = await admit(harness, pngBytes(4, 3, 64), 'api-key:alice');

        const stranger = await readAgUiStream(
          await harness.handler(startRequest(userInput([attachment(assetId)]), as('bob-key'))),
        );
        const missing = await readAgUiStream(
          await harness.handler(
            startRequest(
              userInput([attachment('asset-never-admitted')], { threadId: 'thread-2' }),
              as('bob-key'),
            ),
          ),
        );

        for (const frames of [stranger, missing]) {
          expect(typesOf(frames)).toEqual([EventType.RUN_ERROR]);
          expect(frames[0]!.event).toMatchObject({ code: 'INVALID_INPUT' });
        }
        const text = (frames: typeof stranger) => (frames[0]!.event as { message: string }).message;
        expect(text(stranger).replaceAll(assetId, '<id>')).toBe(
          text(missing).replaceAll('asset-never-admitted', '<id>'),
        );
        // No run started and nothing was added to the thread.
        expect(harness.generate.callCount).toBe(0);
        expect(await harness.bureau.contexts.get('thread-1')).toBeUndefined();
        // The owner's own use of it still works.
        const own = await readAgUiStream(
          await harness.handler(
            startRequest(userInput([attachment(assetId)]), as('alice-assets-key')),
          ),
        );
        expect(own.at(-1)?.event.type).toBe(EventType.RUN_FINISHED);
      },
    );
  });
});

describe('an asset reference and the asset scope', () => {
  it('needs bureau.assets:read, and a credential without it is answered as for a missing asset', async () => {
    await withHarness(
      { script: [say('Seen.')], backends: anthropic.slice(0, 1), authentication },
      async (harness) => {
        const assets = harness.bureau.assets!;
        const available = await admit(harness, pngBytes(4, 3, 64), 'api-key:alice');
        const deleted = await admit(harness, pngBytes(5, 3, 64), 'api-key:alice');
        await assets.delete(deleted, { id: 'api-key:alice' }).result();

        const frames = async (assetId: string, threadId: string) =>
          readAgUiStream(
            await harness.handler(
              startRequest(userInput([attachment(assetId)], { threadId }), as('alice-key')),
            ),
          );
        const unscopedAvailable = await frames(available, 'thread-available');
        const unscopedDeleted = await frames(deleted, 'thread-deleted');
        const unscopedMissing = await frames('asset-never-admitted', 'thread-missing');

        // The same owner without the scope is told neither that the asset exists nor its state.
        const text = (found: typeof unscopedAvailable) =>
          (found[0]!.event as { message: string }).message;
        for (const [found, assetId] of [
          [unscopedAvailable, available],
          [unscopedDeleted, deleted],
          [unscopedMissing, 'asset-never-admitted'],
        ] as const) {
          expect(typesOf(found)).toEqual([EventType.RUN_ERROR]);
          expect(found[0]!.event).toMatchObject({ code: 'INVALID_INPUT' });
          expect(text(found)).toBe(`Asset "${assetId}" was not found`);
        }
        expect(harness.generate.callCount).toBe(0);
        expect(await harness.bureau.contexts.get('thread-available')).toBeUndefined();

        // The credential that holds the scope starts the run on the same asset.
        const scoped = await readAgUiStream(
          await harness.handler(
            startRequest(
              userInput([attachment(available)], { threadId: 'thread-scoped' }),
              as('alice-assets-key'),
            ),
          ),
        );
        expect(scoped.at(-1)?.event.type).toBe(EventType.RUN_FINISHED);
      },
    );
  });

  it('is held by the local caller, which names no credential', async () => {
    await withHarness(
      { script: [say('Seen.')], backends: anthropic.slice(0, 1) },
      async (harness) => {
        const assetId = await admit(harness, pngBytes(4, 3, 64));

        const frames = await readAgUiStream(
          await harness.handler(startRequest(userInput([attachment(assetId)]))),
        );

        expect(frames.at(-1)?.event.type).toBe(EventType.RUN_FINISHED);
      },
    );
  });
});

describe('an asset that is not available', () => {
  /** An owned asset in `state`, as the owner's own start sees it. */
  async function assetIn(harness: Harness, state: 'deleted' | 'rejected'): Promise<string> {
    const assets = harness.bureau.assets!;
    const admission = await assets.admit(
      {
        source: { kind: 'inline', bytes: pngBytes(4, 3, 64) },
        // The bytes are a PNG, so a declared PDF is refused at admission.
        ...(state === 'rejected' ? { declaredMediaType: 'application/pdf' } : {}),
      },
      { id: LOCAL },
    );
    await admission.work.result();
    if (state === 'deleted') await assets.delete(admission.assetId, { id: LOCAL }).result();
    const descriptor = await assets.inspect(admission.assetId, { id: LOCAL });
    expect(descriptor.state).toBe(state);
    return admission.assetId;
  }

  it.each(['deleted', 'rejected'] as const)(
    'is refused at the door when %s, commits no row, and leaves the thread usable',
    async (state) => {
      await withHarness(
        { script: [say('Fine.')], backends: anthropic.slice(0, 1) },
        async (harness) => {
          const assetId = await assetIn(harness, state);

          const refused = await readAgUiStream(
            await harness.handler(
              startRequest(userInput([{ type: 'text', text: 'Look.' }, attachment(assetId)])),
            ),
          );

          expect(typesOf(refused)).toEqual([EventType.RUN_ERROR]);
          expect(refused[0]!.event).toMatchObject({
            code: 'INVALID_INPUT',
            message: `Asset "${assetId}" is ${state}`,
          });
          // Nothing was committed: no run, no thread, no row for a later turn to trip over.
          expect(harness.generate.callCount).toBe(0);
          expect(await harness.bureau.contexts.get('thread-1')).toBeUndefined();

          // A later turn on the same thread, with text only, runs.
          const later = await readAgUiStream(
            await harness.handler(
              startRequest(
                runAgentInput({
                  runId: 'client-run-2',
                  messages: [{ id: 'user-2', role: 'user', content: 'Just text.' }],
                }),
              ),
            ),
          );
          expect(later.at(-1)?.event.type).toBe(EventType.RUN_FINISHED);
          expect(harness.generate.callCount).toBe(1);
        },
      );
    },
  );

  it('names a missing asset and another owner’s asset alike, and as missing rather than by state', async () => {
    await withHarness(
      { script: [say('Fine.')], backends: anthropic.slice(0, 1), authentication },
      async (harness) => {
        const assetId = await admit(harness, pngBytes(4, 3, 64), 'api-key:alice');
        await harness.bureau.assets!.delete(assetId, { id: 'api-key:alice' }).result();

        const stranger = await readAgUiStream(
          await harness.handler(startRequest(userInput([attachment(assetId)]), as('bob-key'))),
        );

        // Bob learns nothing of the state of an asset he cannot read.
        expect(stranger[0]!.event).toMatchObject({
          code: 'INVALID_INPUT',
          message: `Asset "${assetId}" was not found`,
        });
      },
    );
  });
});

describe('the assets an agent generates', () => {
  const twoImages = {
    kind: 'respond' as const,
    response: {
      content: 'Here they are.',
      parts: [
        { type: 'text' as const, text: 'Here they are.' },
        generatedImage(16),
        generatedImage(32),
      ],
      toolCalls: [],
    },
  };

  /** The events that make up the one assistant message, in the order they were sent. */
  const messageEvents = (events: readonly Event[]) =>
    events.filter(
      (event) =>
        event.type === EventType.TEXT_MESSAGE_START ||
        event.type === EventType.TEXT_MESSAGE_CONTENT ||
        event.type === EventType.TEXT_MESSAGE_END ||
        event.type === EventType.CUSTOM,
    );

  it('reach the stream as bureau.asset-part events, in ascending index, inside the message', async () => {
    await withHarness({ script: [twoImages], backends: imageOutput }, async (harness) => {
      const frames = await readAgUiStream(await harness.handler(startRequest(runAgentInput())));
      const events = frames.map((frame) => frame.event);

      expect(typesOf(frames).at(-1)).toBe(EventType.RUN_FINISHED);
      expect(messageEvents(events).map((event) => event.type)).toEqual([
        EventType.TEXT_MESSAGE_START,
        EventType.TEXT_MESSAGE_CONTENT,
        EventType.CUSTOM,
        EventType.CUSTOM,
        EventType.TEXT_MESSAGE_END,
      ]);
      const runId = bureauMetadata(events[0]!)['runId'] as string;
      const parts = events.filter((event) => event.type === EventType.CUSTOM);
      const assetIds = parts.map(
        (event) => (event as { value: { assetId: string } }).value.assetId,
      );
      expect(parts).toMatchObject([
        {
          name: 'bureau.asset-part',
          value: {
            messageId: `${runId}:step:0`,
            index: 1,
            assetId: assetIds[0],
            mediaType: 'image/png',
          },
        },
        {
          name: 'bureau.asset-part',
          value: {
            messageId: `${runId}:step:0`,
            index: 2,
            assetId: assetIds[1],
            mediaType: 'image/png',
          },
        },
      ]);
      expect(new Set(assetIds).size).toBe(2);
      // The events name assets the run's owner can read, and carry no bytes.
      for (const assetId of assetIds) {
        expect(await harness.bureau.assets!.inspect(assetId, { id: LOCAL })).toMatchObject({
          state: 'available',
        });
      }
      expect(JSON.stringify(frames.map((frame) => frame.event))).not.toContain(
        base64Of(pngBytes(4, 3, 16)),
      );
    });
  });

  it('are wrapped in a message of their own when a step has assets and no text', async () => {
    await withHarness(
      {
        script: [
          {
            kind: 'respond',
            response: { content: '', parts: [generatedImage(16)], toolCalls: [] },
          },
        ],
        backends: imageOutput,
      },
      async (harness) => {
        const frames = await readAgUiStream(await harness.handler(startRequest(runAgentInput())));
        const events = frames.map((frame) => frame.event);

        expect(messageEvents(events).map((event) => event.type)).toEqual([
          EventType.TEXT_MESSAGE_START,
          EventType.CUSTOM,
          EventType.TEXT_MESSAGE_END,
        ]);
        const [start, custom, end] = messageEvents(events) as Array<Record<string, unknown>>;
        const messageId = start!['messageId'];
        expect(end!['messageId']).toBe(messageId);
        expect(custom).toMatchObject({
          name: 'bureau.asset-part',
          value: { messageId, index: 0, mediaType: 'image/png' },
        });
      },
    );
  });

  it('are in the snapshot of a reloaded thread, beside the user’s attachment', async () => {
    await withHarness({ script: [twoImages], backends: imageOutput }, async (harness) => {
      const userAsset = await admit(harness, pngBytes(4, 3, 64));
      const part = attachment(userAsset, 'image/png');
      const frames = await readAgUiStream(
        await harness.handler(startRequest(userInput([{ type: 'text', text: 'Draw two.' }, part]))),
      );
      const generated = frames
        .map((frame) => frame.event)
        .filter((event) => event.type === EventType.CUSTOM)
        .map((event) => (event as { value: { assetId: string } }).value.assetId);

      const messages = await messagesOf(harness);

      const user = messages.find((message) => message.role === 'user')!;
      expect(user.content).toEqual([{ type: 'text', text: 'Draw two.' }, part]);
      const assistant = messages.find((message) => message.role === 'assistant')!;
      expect(assistant.content).toBe('Here they are.');
      expect(assistant.metadata?.['bureau:assetParts']).toEqual([
        { index: 1, assetId: generated[0], mediaType: 'image/png' },
        { index: 2, assetId: generated[1], mediaType: 'image/png' },
      ]);
    });
  });
});

describe('media the model does not take', () => {
  it('fails before generation with UNSUPPORTED_MEDIA_TYPE, as one RUN_ERROR and no generate.started', async () => {
    await withHarness(
      { script: [say('Heard.')], backends: anthropic.slice(0, 1) },
      async (harness) => {
        const audio = await admit(harness, wavBytes());
        const part = { type: 'audio' as const, source: attachment(audio).source };

        const frames = await readAgUiStream(await harness.handler(startRequest(userInput([part]))));

        const errors = frames.filter((frame) => frame.event.type === EventType.RUN_ERROR);
        expect(errors).toHaveLength(1);
        expect(errors[0]!.event).toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' });
        expect(frames.at(-1)).toBe(errors[0]);
        expect(harness.generate.callCount).toBe(0);
        const runId = bureauMetadata(frames[0]!.event)['runId'] as string;
        const events = harness.bureau.tasks.detail(runId)?.events ?? [];
        expect(events.map((event) => event.event)).not.toContain('generate.started');
      },
    );
  });

  it('is UNSUPPORTED_MEDIA_TYPE on a later turn, though the thread admitted an image earlier', async () => {
    await withHarness(
      { script: [say('Seen.'), say('Heard.')], backends: anthropic.slice(0, 1) },
      async (harness) => {
        const image = await admit(harness, pngBytes(4, 3, 64));
        const audio = await admit(harness, wavBytes());
        const first = await readAgUiStream(
          await harness.handler(startRequest(userInput([attachment(image)]))),
        );
        expect(first.at(-1)?.event.type).toBe(EventType.RUN_FINISHED);
        await waitForCondition(
          () => listHeldTasks(harness.bureau).every((run) => run.status !== 'running'),
          'the first turn did not settle',
        );

        // The image the thread admitted in its first message says nothing about this one.
        const part = { type: 'audio' as const, source: attachment(audio).source };
        const second = await readAgUiStream(
          await harness.handler(
            startRequest(
              runAgentInput({
                runId: 'client-run-2',
                messages: [{ id: 'user-2', role: 'user', content: [part] as never }],
              }),
            ),
          ),
        );
        const errors = second.filter((frame) => frame.event.type === EventType.RUN_ERROR);
        expect(errors).toHaveLength(1);
        expect(errors[0]!.event).toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' });
        expect(harness.generate.callCount).toBe(1);
      },
    );
  });
});

describe('the code of a media refusal on the wire', () => {
  type Reason = 'modality-not-accepted' | 'asset-flagged';

  /** A start with two images, each costed as `reasons[position]` by the agent's own estimator. */
  async function refusal(reasons: readonly (Reason | 'estimated')[]) {
    return withHarness(
      {
        script: [say('Seen.')],
        backends: anthropic.slice(0, 1),
        mediaCostEstimator: (part, position) => {
          const reason = reasons[position.partIndex]!;
          return reason === 'estimated'
            ? {
                ...position,
                modality: part.type,
                outcome: 'estimated',
                tokens: 10,
                basis: 'catalog-estimate',
              }
            : { ...position, modality: part.type, outcome: 'unsupported', reason };
        },
      },
      async (harness) => {
        const ids = [
          await admit(harness, pngBytes(4, 3, 16)),
          await admit(harness, pngBytes(4, 3, 32)),
        ];
        const frames = await readAgUiStream(
          await harness.handler(startRequest(userInput(ids.map((id) => attachment(id))))),
        );
        const errors = frames.filter((frame) => frame.event.type === EventType.RUN_ERROR);
        expect(errors).toHaveLength(1);
        expect(harness.generate.callCount).toBe(0);
        return errors[0]!.event as { code: string };
      },
    );
  }

  it('is UNSUPPORTED_MEDIA_TYPE when an agent’s estimator says the model takes none of the parts', async () => {
    expect(await refusal(['modality-not-accepted', 'modality-not-accepted'])).toMatchObject({
      code: 'UNSUPPORTED_MEDIA_TYPE',
    });
  });

  it('is MEDIA_NOT_ADMITTED when a part is refused for another reason', async () => {
    expect(await refusal(['asset-flagged', 'asset-flagged'])).toMatchObject({
      code: 'MEDIA_NOT_ADMITTED',
    });
  });

  it('is MEDIA_NOT_ADMITTED when one part is admitted and another is not accepted', async () => {
    expect(await refusal(['estimated', 'modality-not-accepted'])).toMatchObject({
      code: 'MEDIA_NOT_ADMITTED',
    });
  });
});
