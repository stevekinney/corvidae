/**
 * COR-1581 — a run with no session holds nothing else on the managed assets its input references,
 * so the media port is told about the seeded input row before the run's first step, on both seeding
 * paths: the in-process loop and the durable workflow.
 */
import { MemoryStorage, textValueStore } from '@lostgradient/weft';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation, createConversationHistory, type MultiModalContent } from 'conversationalist';

import { stopWhen } from './conditions/index';
import { startDurableRunResult } from './durable/active-run-result-entrypoints';
import { createCheckpointStore } from './durable/checkpoint-store';
import { createRunEngine } from './durable/create-run-engine';
import { createRunWorkflow } from './durable/run-workflow';
import { executeLoop } from './loop';
import { createModelCatalog, withBackendDescriptors } from './providers/index';
import { createScriptedMediaAdmitter } from './testing/generated-media.test-support';
import type { ContentSourceResolver, GenerateContext, RunOptions } from './types';

const suppliedImage: MultiModalContent = {
  type: 'image',
  mimeType: 'image/png',
  source: { kind: 'managed-asset', assetId: 'supplied-asset' },
};

const resolver: ContentSourceResolver = async () => ({
  outcome: 'resolved',
  source: { kind: 'remote-url', url: 'https://cdn.example/supplied.png' },
  mimeType: 'image/png',
  byteLength: 4096,
  safety: 'clean',
});

/** A backend whose descriptors admit image input, which a plain `generate` does not advertise. */
const imageInputDescriptors = createModelCatalog().descriptors.filter(
  (descriptor) => descriptor.provider === 'anthropic',
);

function optionsWith(
  port: ReturnType<typeof createScriptedMediaAdmitter>['port'],
  generate: RunOptions['generate'],
  conversation = createConversationHistory(),
): RunOptions {
  return {
    generate: withBackendDescriptors(generate, imageInputDescriptors),
    toolbox: createToolbox([]),
    conversation,
    stopWhen: stopWhen.noToolCalls(),
    runId: 'run-1',
    contentSourceResolver: resolver,
    generatedMediaAdmitter: port,
  };
}

function conversationEndingWith(content: string | MultiModalContent[]) {
  const conversation = new Conversation(createConversationHistory());
  conversation.appendUserMessage(content);
  return conversation;
}

describe('the in-process loop', () => {
  it('tells the port about the input row, with its managed-asset parts, before the first step', async () => {
    const scripted = createScriptedMediaAdmitter({ retention: 'record' });
    const conversation = conversationEndingWith([{ type: 'text', text: 'Look' }, suppliedImage]);
    const row = conversation.getMessages().at(-1)!;
    const seen: number[] = [];

    const result = await executeLoop(
      optionsWith(
        scripted.port,
        async (_context: GenerateContext) => {
          seen.push(scripted.retainedInput.length);
          return { content: 'ok', toolCalls: [] };
        },
        conversation.current,
      ),
    );

    expect(result.finishReason).toBe('stop-condition');
    expect(scripted.retainedInput).toEqual([
      { runId: 'run-1', messageId: row.id, parts: [suppliedImage] },
    ]);
    expect(seen).toEqual([1]);
  });

  it('leaves a text-only input row alone', async () => {
    const scripted = createScriptedMediaAdmitter({ retention: 'record' });

    await executeLoop(
      optionsWith(
        scripted.port,
        async () => ({ content: 'ok', toolCalls: [] }),
        conversationEndingWith('Hello').current,
      ),
    );

    expect(scripted.retainedInput).toEqual([]);
  });

  it('ends the run as an error, before any step, when the port rejects the claim', async () => {
    const scripted = createScriptedMediaAdmitter({ retention: 'fail' });
    let generated = 0;

    const result = await executeLoop(
      optionsWith(
        scripted.port,
        async () => {
          generated += 1;
          return { content: 'ok', toolCalls: [] };
        },
        conversationEndingWith([suppliedImage]).current,
      ),
    );

    expect(result.finishReason).toBe('error');
    expect(generated).toBe(0);
  });
});

describe('the durable workflow', () => {
  async function durableContext() {
    const storage = new MemoryStorage();
    const checkpointStore = createCheckpointStore(
      textValueStore(storage, { disposeUnderlyingStorage: false }),
    );
    const { engine } = await createRunEngine({
      storage,
      runWorkflow: createRunWorkflow(checkpointStore),
      recover: false,
    });
    return { engine, checkpointStore };
  }

  it('tells the port about the seeded input row before the first step', async () => {
    const context = await durableContext();
    try {
      const scripted = createScriptedMediaAdmitter({ retention: 'record' });
      const seen: number[] = [];

      const result = await startDurableRunResult(context, {
        runId: 'run-1',
        sessionId: 'run-1',
        options: optionsWith(scripted.port, async () => {
          seen.push(scripted.retainedInput.length);
          return { content: 'ok', toolCalls: [] };
        }),
        prompt: [{ type: 'text', text: 'Look' }, suppliedImage],
      });

      expect(result.finishReason).toBe('stop-condition');
      expect(scripted.retainedInput).toHaveLength(1);
      expect(scripted.retainedInput[0]).toMatchObject({ runId: 'run-1', parts: [suppliedImage] });
      expect(seen).toEqual([1]);
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  it('leaves a text-only prompt alone', async () => {
    const context = await durableContext();
    try {
      const scripted = createScriptedMediaAdmitter({ retention: 'record' });

      await startDurableRunResult(context, {
        runId: 'run-1',
        sessionId: 'run-1',
        options: optionsWith(scripted.port, async () => ({ content: 'ok', toolCalls: [] })),
        prompt: 'Hello',
      });

      expect(scripted.retainedInput).toEqual([]);
    } finally {
      context.engine[Symbol.dispose]();
    }
  });

  it('fails the run, before any step, when the port rejects the claim', async () => {
    const context = await durableContext();
    try {
      const scripted = createScriptedMediaAdmitter({ retention: 'fail' });
      let generated = 0;

      const outcome = await startDurableRunResult(context, {
        runId: 'run-1',
        sessionId: 'run-1',
        options: optionsWith(scripted.port, async () => {
          generated += 1;
          return { content: 'ok', toolCalls: [] };
        }),
        prompt: [suppliedImage],
      }).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(outcome).toBeInstanceOf(Error);
      expect(generated).toBe(0);
    } finally {
      context.engine[Symbol.dispose]();
    }
  });
});
