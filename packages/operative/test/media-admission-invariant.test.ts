/**
 * COR-716 — the admission invariant. Every `GenerateContext` handed to the
 * run's `generate` carries a `resolvedSources` derived by admission from that
 * context's own conversation, immediately before the call, against the backends
 * the call can reach. It holds whatever changed the conversation last: a
 * `prepareStep` hook, a `beforeGenerate` handler, a retry mutator, or the
 * `onMaximumSteps` tail. Dispatch among backends is limited to those that admit
 * the whole request.
 */
import { HookRegistry } from '@lostgradient/lifecycle';
import { Engine, MemoryStorage, textValueStore } from '@lostgradient/weft';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import type { MediaContent } from 'conversationalist';
import { Conversation, createConversationHistory } from 'conversationalist';

import type { MediaCostEstimator } from '../src/context/types';
import { createEarlyStoppingHandler } from '../src/create-early-stopping-handler';
import { createActiveRun } from '../src/create-run';
import { createCheckpointStore } from '../src/durable/checkpoint-store';
import { createRunWorkflow } from '../src/durable/run-workflow';
import { createStorageActivities } from '../src/durable/storage-activities';
import type { DurableRunDeps } from '../src/durable/types';
import { MediaAdmissionError } from '../src/errors';
import { createFallbackGenerate } from '../src/generate-middleware';
import type { OperativeHookMap } from '../src/hooks';
import { withBackendDescriptors } from '../src/providers/backend-descriptor-attachment';
import { createFalloverGenerate } from '../src/providers/fallover/create-fallover-generate';
import type { BackendDescriptor } from '../src/providers/model-catalog';
import { createModelCatalog } from '../src/providers/model-catalog';
import { createRoutingGenerate } from '../src/providers/routing/create-routing-generate';
import type { ContentSourceResolver, GenerateContext, GenerateFunction } from '../src/types';

const BYTES = 'QUJDREVGRw==';

const estimate: MediaCostEstimator = (part, position) => ({
  ...position,
  modality: part.type,
  outcome: 'estimated',
  tokens: 10,
  basis: 'catalog-estimate',
});

function managed(assetId: string): MediaContent {
  return { type: 'image', mimeType: 'image/png', source: { kind: 'managed-asset', assetId } };
}

/** Resolves every asset; an asset whose id starts with `flagged` carries a flagged verdict. */
const resolver: ContentSourceResolver = async (part) => ({
  outcome: 'resolved',
  source: { kind: 'inline', data: BYTES, encoding: 'base64' },
  byteLength: 7,
  safety:
    part.source.kind === 'managed-asset' && part.source.assetId.startsWith('flagged')
      ? 'flagged'
      : 'clean',
});

function recording(seen: GenerateContext[], content = 'ok'): GenerateFunction {
  return async (context) => {
    seen.push(context);
    return { content, toolCalls: [] };
  };
}

function lastUserId(context: GenerateContext): string {
  const user = context.conversation.getMessages().findLast((message) => message.role === 'user');
  if (user === undefined) throw new Error('no user message');
  return user.id;
}

describe('admission runs on the conversation generate receives (COR-716)', () => {
  it('a managed asset a prepareStep hook appends reaches generate resolved', async () => {
    const seen: GenerateContext[] = [];
    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('prepareStep', async (context) => {
      context.conversation.appendUserMessage([managed('late')]);
    });
    const conversation = new Conversation();
    conversation.appendUserMessage('hello');

    const result = await createActiveRun({
      generate: recording(seen),
      toolbox: createToolbox([]),
      conversation,
      stopWhen: () => true,
      mediaCostEstimator: estimate,
      contentSourceResolver: resolver,
      hooks,
    }).result;

    expect(result.finishReason).toBe('stop-condition');
    expect(seen).toHaveLength(1);
    const resolved = seen[0]!.resolvedSources?.get(`${lastUserId(seen[0]!)}:0`);
    expect(resolved).toMatchObject({ outcome: 'resolved', source: { kind: 'inline' } });
  });

  it('a flagged asset a prepareStep hook appends is refused before generate', async () => {
    const seen: GenerateContext[] = [];
    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('prepareStep', async (context) => {
      context.conversation.appendUserMessage([managed('flagged-late')]);
    });
    const conversation = new Conversation();
    conversation.appendUserMessage('hello');

    const result = await createActiveRun({
      generate: recording(seen),
      toolbox: createToolbox([]),
      conversation,
      stopWhen: () => true,
      mediaCostEstimator: estimate,
      contentSourceResolver: resolver,
      hooks,
    }).result;

    expect(seen).toHaveLength(0);
    expect(result.finishReason).toBe('error');
    expect(result.error).toBeInstanceOf(MediaAdmissionError);
    expect((result.error as MediaAdmissionError).outcomes[0]).toMatchObject({
      reason: 'asset-flagged',
    });
  });

  it('a retry mutator that rebuilds the context without resolvedSources still sends resolved media', async () => {
    const seen: GenerateContext[] = [];
    let calls = 0;
    const generate: GenerateFunction = async (context) => {
      seen.push(context);
      calls += 1;
      if (calls === 1) throw new Error('transient');
      return { content: 'ok', toolCalls: [] };
    };
    const conversation = new Conversation();
    conversation.appendUserMessage([managed('clean')]);

    const result = await createActiveRun({
      generate,
      toolbox: createToolbox([]),
      conversation,
      stopWhen: () => true,
      mediaCostEstimator: estimate,
      contentSourceResolver: resolver,
      retry: {
        attempts: 2,
        mutate: (context) => ({
          conversation: context.conversation,
          step: context.step,
          toolbox: context.toolbox,
        }),
      },
    }).result;

    expect(result.finishReason).toBe('stop-condition');
    expect(seen).toHaveLength(2);
    const key = `${lastUserId(seen[1]!)}:0`;
    expect(seen[1]!.resolvedSources?.get(key)).toMatchObject({ outcome: 'resolved' });
  });

  it('a retry mutator that adds a flagged asset is refused before the retry is issued', async () => {
    const seen: GenerateContext[] = [];
    let calls = 0;
    const generate: GenerateFunction = async (context) => {
      seen.push(context);
      calls += 1;
      if (calls === 1) throw new Error('transient');
      return { content: 'ok', toolCalls: [] };
    };
    const conversation = new Conversation();
    conversation.appendUserMessage([managed('clean')]);

    const result = await createActiveRun({
      generate,
      toolbox: createToolbox([]),
      conversation,
      stopWhen: () => true,
      mediaCostEstimator: estimate,
      contentSourceResolver: resolver,
      retry: {
        attempts: 2,
        mutate: (context) => {
          context.conversation.appendUserMessage([managed('flagged-retry')]);
          return { ...context };
        },
      },
    }).result;

    expect(seen).toHaveLength(1);
    expect(result.finishReason).toBe('error');
    expect(result.error).toBeInstanceOf(MediaAdmissionError);
    expect((result.error as MediaAdmissionError).outcomes[0]).toMatchObject({
      reason: 'asset-flagged',
    });
  });

  it('the onMaximumSteps tail hands the early-stopping call the resolved media', async () => {
    const summaries: GenerateContext[] = [];
    const conversation = new Conversation();
    conversation.appendUserMessage([managed('clean')]);

    const result = await createActiveRun({
      generate: recording([], 'still working'),
      toolbox: createToolbox([]),
      conversation,
      stopWhen: () => false,
      maximumSteps: 1,
      mediaCostEstimator: estimate,
      contentSourceResolver: resolver,
      onMaximumSteps: createEarlyStoppingHandler(recording(summaries, 'summary')),
    }).result;

    expect(result.finishReason).toBe('maximum-steps');
    expect(result.content).toBe('summary');
    expect(summaries).toHaveLength(1);
    const assetMessage = summaries[0]!.conversation
      .getMessages()
      .find((message) => message.role === 'user' && typeof message.content !== 'string');
    expect(summaries[0]!.resolvedSources?.get(`${assetMessage!.id}:0`)).toMatchObject({
      outcome: 'resolved',
    });
  });

  it('the onMaximumSteps tail refuses a flagged asset instead of sending it', async () => {
    const summaries: GenerateContext[] = [];
    const conversation = new Conversation();
    conversation.appendUserMessage('hello');
    let flagged = false;
    const flagThisTurn: ContentSourceResolver = async (part, position) => {
      // Clean while the steps ran; flagged by the time the run ends.
      const verdict = await resolver(part, position);
      return verdict.outcome === 'resolved' && flagged
        ? { ...verdict, safety: 'flagged' }
        : verdict;
    };
    const loop: GenerateFunction = async (context) => {
      context.conversation.appendUserMessage([managed('later-flagged')]);
      return { content: 'still working', toolCalls: [] };
    };

    const result = await createActiveRun({
      generate: loop,
      toolbox: createToolbox([]),
      conversation,
      stopWhen: () => {
        flagged = true;
        return false;
      },
      maximumSteps: 1,
      mediaCostEstimator: estimate,
      contentSourceResolver: flagThisTurn,
      onMaximumSteps: createEarlyStoppingHandler(recording(summaries, 'summary')),
    }).result;

    expect(summaries).toHaveLength(0);
    expect(result.finishReason).toBe('error');
    expect(result.error).toBeInstanceOf(MediaAdmissionError);
  });

  it('a managed asset is unavailable at admission when the run has no resolver, whatever the estimator says', async () => {
    const seen: GenerateContext[] = [];
    const conversation = new Conversation();
    conversation.appendUserMessage([managed('orphan')]);

    const result = await createActiveRun({
      generate: recording(seen),
      toolbox: createToolbox([]),
      conversation,
      stopWhen: () => true,
      mediaCostEstimator: estimate,
    }).result;

    expect(seen).toHaveLength(0);
    expect(result.finishReason).toBe('error');
    expect((result.error as MediaAdmissionError).outcomes[0]).toMatchObject({
      reason: 'source-form-not-accepted',
    });
  });
});

describe('dispatch is limited to the backends that admit the whole request (COR-716)', () => {
  const catalog = createModelCatalog();
  const anthropic = catalog.descriptors.find(
    (row) =>
      row.provider === 'anthropic' &&
      row.mediaCounts.some((count) => count.modality === 'image' && count.maxPerRequest === 100),
  )!;
  const openai = catalog.descriptors.find(
    (row) => row.provider === 'openai' && row.model === 'gpt-4o',
  )!;
  /** One more image than Anthropic's per-request cap, well under OpenAI's. */
  const images: MediaContent[] = Array.from({ length: 101 }, () => ({
    type: 'image',
    mimeType: 'image/png',
    source: { kind: 'inline', data: 'QUJD', encoding: 'base64' },
  }));

  function backend(name: string, descriptor: BackendDescriptor, calls: string[]) {
    return withBackendDescriptors(async () => {
      calls.push(name);
      return { content: `${name}-response`, toolCalls: [] };
    }, [descriptor]);
  }

  async function runThrough(generate: GenerateFunction) {
    const conversation = new Conversation();
    conversation.appendUserMessage(images);
    return createActiveRun({
      generate,
      toolbox: createToolbox([]),
      conversation,
      stopWhen: () => true,
    }).result;
  }

  it('routing: admitted when one route takes every part, and dispatched to that route', async () => {
    const calls: string[] = [];
    const generate = createRoutingGenerate({
      routes: [
        { name: 'anthropic', generate: backend('anthropic', anthropic, calls) },
        { name: 'openai', generate: backend('openai', openai, calls) },
      ],
      strategy: () => ({ route: 'anthropic', reason: 'preferred' }),
      fallback: 'anthropic',
    });

    const result = await runThrough(generate);

    expect(result.error).toBeUndefined();
    expect(calls).toEqual(['openai']);
  });

  it('fallover: a provider that cannot take the request is skipped, never called', async () => {
    const calls: string[] = [];
    const generate = createFalloverGenerate({
      providers: [
        { name: 'anthropic', generate: backend('anthropic', anthropic, calls) },
        { name: 'openai', generate: backend('openai', openai, calls) },
      ],
    });

    const result = await runThrough(generate);

    expect(result.error).toBeUndefined();
    expect(calls).toEqual(['openai']);
  });

  it('fallback: a provider that cannot take the request is skipped, never called', async () => {
    const calls: string[] = [];
    const generate = createFallbackGenerate({
      providers: [backend('anthropic', anthropic, calls), backend('openai', openai, calls)],
    });

    const result = await runThrough(generate);

    expect(result.error).toBeUndefined();
    expect(calls).toEqual(['openai']);
  });

  it('refuses, typed, when no backend takes every part, naming the parts past the cap', async () => {
    const calls: string[] = [];
    const result = await runThrough(backend('anthropic', anthropic, calls));

    expect(calls).toEqual([]);
    expect(result.error).toBeInstanceOf(MediaAdmissionError);
    expect((result.error as MediaAdmissionError).outcomes).toEqual([
      expect.objectContaining({ reason: 'media-count-exceeded', partIndex: 100 }),
    ]);
  });

  it('refuses with no-backend-admits-media when the parts fit each backend alone but no backend takes the set', async () => {
    const calls: string[] = [];
    // Audio only Gemini takes, beside an image only Anthropic can hold (this
    // Gemini row caps an image at four bytes): each part fits one backend alone,
    // and no single backend takes both.
    const gemini = catalog.descriptors.find((row) => row.provider === 'gemini')!;
    const tinyImages: BackendDescriptor = {
      ...gemini,
      mediaLimits: [{ scope: 'per-part', modality: 'image', maxBytes: 4 }],
    };
    const conversation = new Conversation();
    conversation.appendUserMessage([
      {
        type: 'audio',
        mimeType: 'audio/mpeg',
        source: { kind: 'inline', data: 'QUJD', encoding: 'base64' },
      },
      {
        type: 'image',
        mimeType: 'image/png',
        source: { kind: 'inline', data: BYTES, encoding: 'base64' },
      },
    ]);
    const generate = createFallbackGenerate({
      providers: [backend('anthropic', anthropic, calls), backend('gemini', tinyImages, calls)],
    });
    const result = await createActiveRun({
      generate,
      toolbox: createToolbox([]),
      conversation,
      stopWhen: () => true,
      mediaCostEstimator: estimate,
    }).result;

    expect(calls).toEqual([]);
    expect(result.error).toBeInstanceOf(MediaAdmissionError);
    expect((result.error as MediaAdmissionError).outcomes.map((outcome) => outcome.reason)).toEqual(
      ['no-backend-admits-media', 'no-backend-admits-media'],
    );
  });
});

describe('an opaque candidate keeps the request reachable (COR-716)', () => {
  const catalog = createModelCatalog();
  const openai = catalog.descriptors.find(
    (row) => row.provider === 'openai' && row.model === 'gpt-4o',
  )!;
  const audio: MediaContent = {
    type: 'audio',
    mimeType: 'audio/mpeg',
    source: { kind: 'inline', data: 'QUJD', encoding: 'base64' },
  };

  function described(name: string, descriptor: BackendDescriptor, calls: string[]) {
    return withBackendDescriptors(async () => {
      calls.push(name);
      return { content: `${name}-response`, toolCalls: [] };
    }, [descriptor]);
  }

  /** A generator with no descriptors: nothing says it cannot take the audio. */
  function opaque(calls: string[]): GenerateFunction {
    return async () => {
      calls.push('opaque');
      return { content: 'opaque-response', toolCalls: [] };
    };
  }

  async function runAudio(generate: GenerateFunction) {
    const conversation = new Conversation();
    conversation.appendUserMessage([audio]);
    return createActiveRun({
      generate,
      toolbox: createToolbox([]),
      conversation,
      stopWhen: () => true,
      mediaCostEstimator: estimate,
    }).result;
  }

  it('routing: audio OpenAI cannot take reaches the opaque route', async () => {
    const calls: string[] = [];
    const result = await runAudio(
      createRoutingGenerate({
        routes: [
          { name: 'openai', generate: described('openai', openai, calls) },
          { name: 'opaque', generate: opaque(calls) },
        ],
        strategy: () => ({ route: 'openai', reason: 'preferred' }),
        fallback: 'opaque',
      }),
    );
    expect(result.error).toBeUndefined();
    expect(calls).toEqual(['opaque']);
  });

  it('fallover: audio OpenAI cannot take reaches the opaque provider', async () => {
    const calls: string[] = [];
    const result = await runAudio(
      createFalloverGenerate({
        providers: [
          { name: 'openai', generate: described('openai', openai, calls) },
          { name: 'opaque', generate: opaque(calls) },
        ],
      }),
    );
    expect(result.error).toBeUndefined();
    expect(calls).toEqual(['opaque']);
  });

  it('fallback: audio OpenAI cannot take reaches the opaque provider', async () => {
    const calls: string[] = [];
    const result = await runAudio(
      createFallbackGenerate({ providers: [described('openai', openai, calls), opaque(calls)] }),
    );
    expect(result.error).toBeUndefined();
    expect(calls).toEqual(['opaque']);
  });
});

describe('the MIME family comes from the shared document table (COR-716)', () => {
  it('admits an application/json document on a backend that accepts documents', async () => {
    const anthropic = createModelCatalog().descriptors.find((row) => row.provider === 'anthropic')!;
    const calls: string[] = [];
    const conversation = new Conversation();
    conversation.appendUserMessage([
      {
        type: 'document',
        mimeType: 'application/json',
        source: { kind: 'inline', data: 'e30=', encoding: 'base64' },
      },
    ]);
    const result = await createActiveRun({
      generate: withBackendDescriptors(async () => {
        calls.push('anthropic');
        return { content: 'ok', toolCalls: [] };
      }, [anthropic]),
      toolbox: createToolbox([]),
      conversation,
      stopWhen: () => true,
    }).result;
    expect(result.error).toBeUndefined();
    expect(calls).toEqual(['anthropic']);
  });
});

describe('the durable onMaximumSteps tail derives the media it hands the handler (COR-716)', () => {
  async function runDurably(services: DurableRunDeps, prompt: MediaContent[]) {
    const storage = new MemoryStorage();
    const checkpointStore = createCheckpointStore(
      textValueStore(storage, { disposeUnderlyingStorage: false }),
    );
    const activities = createStorageActivities(checkpointStore);
    const engine = await Engine.create({
      storage,
      recover: false,
      workflows: { agentRun: createRunWorkflow(checkpointStore, {}) },
      activities: {
        saveCursor: activities.saveCursor,
        saveConversation: activities.saveConversation,
        recordStep: activities.recordStep,
      },
    });
    try {
      const handle = await engine.start(
        'agentRun',
        { runId: 'early-stop', sessionId: 'early-stop', agentName: '', prompt, maximumSteps: 1 },
        { id: 'early-stop', services },
      );
      return await handle.result();
    } finally {
      engine[Symbol.dispose]();
    }
  }

  it('hands the early-stopping call the resolved media under createRunWorkflow', async () => {
    const summaries: GenerateContext[] = [];
    const toolbox = createToolbox([]);
    const result = await runDurably(
      {
        toolbox,
        options: {
          generate: recording([], 'still working'),
          toolbox,
          conversation: createConversationHistory(),
          stopWhen: () => false,
          mediaCostEstimator: estimate,
          contentSourceResolver: resolver,
          onMaximumSteps: createEarlyStoppingHandler(recording(summaries, 'summary')),
        },
      },
      [managed('clean')],
    );

    expect(result.finishReason).toBe('maximum-steps');
    expect(result.content).toBe('summary');
    expect(summaries).toHaveLength(1);
    const assetMessage = summaries[0]!.conversation
      .getMessages()
      .find((message) => message.role === 'user' && typeof message.content !== 'string');
    expect(summaries[0]!.resolvedSources?.get(`${assetMessage!.id}:0`)).toMatchObject({
      outcome: 'resolved',
    });
  });

  it('refuses a flagged asset before the early-stopping call under createRunWorkflow', async () => {
    const summaries: GenerateContext[] = [];
    const toolbox = createToolbox([]);
    const result = await runDurably(
      {
        toolbox,
        options: {
          generate: recording([], 'still working'),
          toolbox,
          conversation: createConversationHistory(),
          stopWhen: () => false,
          mediaCostEstimator: estimate,
          // Clean while the step ran, flagged by the time the run ends.
          contentSourceResolver: (() => {
            let calls = 0;
            const verdictResolver: ContentSourceResolver = async (part, position) => {
              calls += 1;
              const verdict = await resolver(part, position);
              return verdict.outcome === 'resolved' && calls > 1
                ? { ...verdict, safety: 'flagged' }
                : verdict;
            };
            return verdictResolver;
          })(),
          onMaximumSteps: createEarlyStoppingHandler(recording(summaries, 'summary')),
        },
      },
      [managed('later-flagged')],
    );

    expect(summaries).toHaveLength(0);
    expect(result.finishReason).toBe('error');
    expect(result.errorMessage).toContain('cannot be admitted');
  });
});
