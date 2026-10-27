/**
 * COR-716: every Agent start path either delivers the caller's ordered media
 * parts to the provider boundary losslessly, or fails with a typed error before
 * generation. Each row ends in a no-silent-loss assertion: the parts reach
 * `generate` equal to what went in, in order, or a typed error names why not.
 */
import { HookRegistry } from '@lostgradient/lifecycle';
import { MemoryStorage, textValueStore } from '@lostgradient/weft';
import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import type {
  ContentSource,
  ConversationHistory,
  MediaContent,
  Message,
  MultiModalContent,
} from 'conversationalist';
import {
  Conversation,
  toAnthropicMessages,
  toGeminiMessages,
  toOpenAIMessages,
  UnsupportedContentError,
} from 'conversationalist';

import { z } from 'zod';
import { noToolCalls } from '../src/conditions/predicates';
import { createSlidingWindowStrategy } from '../src/context/compaction-strategies';
import { prepareSubagentContext } from '../src/context/subagent-context';
import { createTokenBudget } from '../src/context/token-budget';
import type { MediaCostEstimator } from '../src/context/types';
import { createAgent } from '../src/create-agent';
import { createContextCompactor } from '../src/create-context-compactor';
import { createLazyAgent } from '../src/create-lazy-agent';
import { createActiveRun } from '../src/create-run';
import { createSubagentTool } from '../src/create-subagent-tool';
import type { UserAdmissibleContent } from '../src/durable/types';
import { AgentContractError, MediaAdmissionError, SelectionRevalidationError } from '../src/errors';
import type { OperativeHookMap } from '../src/hooks';
import { createAnthropicProvider } from '../src/providers/anthropic.ts';
import { withBackendDescriptors } from '../src/providers/backend-descriptor-attachment';
import { createGeminiProvider } from '../src/providers/gemini.ts';
import type { BackendDescriptor } from '../src/providers/model-catalog';
import { createModelCatalog } from '../src/providers/model-catalog';
import { createOpenAIProvider } from '../src/providers/openai.ts';
import {
  anthropicTextResponse,
  anthropicToolUseResponse,
  geminiFunctionCallResponse,
  geminiTextResponse,
  openAITextResponse,
  openAIToolCallResponse,
} from '../src/providers/test/fixtures.ts';
import {
  createMockAnthropicClient,
  createMockGeminiModel,
  createMockOpenAIClient,
} from '../src/providers/test/mock-clients.ts';
import { createSelectionGate } from '../src/selection-gate';
import { createSessionStore } from '../src/session/create-session-store';
import { createSessionHandle } from '../src/session/session-handle';
import { drainMicrotasks } from '../src/testing/drain-microtasks.test-support.ts';
import { rejectionOf } from '../src/testing/promise-outcome.test-support.ts';
import type {
  ContentSourceResolver,
  GenerateContext,
  GenerateFunction,
  RunOptionsBase,
} from '../src/types';

const BYTES = 'QUJDREVGRw=='; // base64 of "ABCDEFG"

/** Prices every part, standing in for a backend whose descriptors a test does not need. */
const estimate: MediaCostEstimator = (part, position) => ({
  ...position,
  modality: part.type,
  outcome: 'estimated',
  tokens: 10,
  basis: 'catalog-estimate',
});

function image(url = 'https://example.com/a.png'): MediaContent {
  return { type: 'image', source: { kind: 'remote-url', url }, mimeType: 'image/png', alt: 'a' };
}

/** The same parts as a conversation holds them, for seeding and comparing history. */
function conversationParts(): MultiModalContent[] {
  return parts().map((part): MultiModalContent =>
    part.type === 'text' ? { type: 'text', text: part.text } : part,
  );
}

function parts(): UserAdmissibleContent[] {
  return [
    { type: 'text', text: 'first' },
    image(),
    {
      type: 'document',
      name: 'spec.pdf',
      mimeType: 'application/pdf',
      source: { kind: 'inline', data: BYTES, encoding: 'base64' },
      metadata: { owner: { id: 7 } },
    },
    { type: 'text', text: 'last' },
  ];
}

interface Recorder {
  readonly generate: GenerateFunction;
  readonly contexts: GenerateContext[];
  readonly histories: ConversationHistory[];
}

function recorder(content = 'done'): Recorder {
  const contexts: GenerateContext[] = [];
  const histories: ConversationHistory[] = [];
  const generate: GenerateFunction = async (context) => {
    contexts.push(context);
    histories.push(structuredClone(context.conversation.current));
    return { content, toolCalls: [] };
  };
  return { generate, contexts, histories };
}

/** The user messages the provider boundary saw, content only. */
function userContents(history: ConversationHistory | undefined): unknown[] {
  if (history === undefined) throw new Error('generate was never called');
  return history.ids
    .map((id) => history.messages[id])
    .filter((message): message is Message => message?.role === 'user')
    .map((message) => message.content);
}

describe('Agent.run: ordered parts as input', () => {
  it('delivers the parts to generate as exactly one user message, in order, unchanged', async () => {
    const { generate, histories } = recorder();
    const agent = createAgent({ generate, mediaCostEstimator: estimate });

    const result = await agent.run(parts()).result();

    expect(result.finishReason).not.toBe('error');
    expect(userContents(histories[0])).toEqual([parts()]);
  });

  it('puts instructions first without disturbing the parts', async () => {
    const { generate, histories } = recorder();
    const agent = createAgent({
      generate,
      instructions: 'Be brief.',
      mediaCostEstimator: estimate,
    });

    await agent.run(parts()).result();

    const history = histories[0]!;
    expect(history.messages[history.ids[0]!]?.role).toBe('system');
    expect(userContents(history)).toEqual([parts()]);
  });

  it('snapshots the caller’s array so later mutation cannot reach the run', async () => {
    const { generate, histories } = recorder();
    const agent = createAgent({ generate, mediaCostEstimator: estimate });
    const input = parts();

    const run = agent.run(input);
    input.length = 0;
    input.push({ type: 'text', text: 'mutated' });
    await run.result();

    expect(userContents(histories[0])).toEqual([parts()]);
  });

  it('rejects an empty part list synchronously with a typed error, never as an empty string', () => {
    const { generate, contexts } = recorder();
    const agent = createAgent({ generate, mediaCostEstimator: estimate });

    expect(() => agent.run([])).toThrow(AgentContractError);
    expect(contexts).toHaveLength(0);
  });

  it('rejects provider-generated blocks and cited text as input', () => {
    const { generate, contexts } = recorder();
    const agent = createAgent({ generate, mediaCostEstimator: estimate });

    expect(() => agent.run([{ type: 'thinking', thinking: 'x', signature: 's' }] as never)).toThrow(
      AgentContractError,
    );
    expect(() => agent.run([{ type: 'text', text: 'x', citations: [] }] as never)).toThrow(
      AgentContractError,
    );
    expect(() => agent.run([{ type: 'image', url: 'https://example.com/a.png' }] as never)).toThrow(
      AgentContractError,
    );
    expect(contexts).toHaveLength(0);
  });

  it('rejects a { conversation } input whose conversation is not a ConversationHistory', () => {
    const { generate, contexts } = recorder();
    const agent = createAgent({ generate });

    for (const conversation of [undefined, null, 'x', 7, []]) {
      expect(() => agent.run({ conversation } as never)).toThrow(AgentContractError);
    }
    expect(contexts).toHaveLength(0);
  });

  it('keeps the string shorthand and the { conversation } form working', async () => {
    const { generate, histories } = recorder();
    const agent = createAgent({ generate, mediaCostEstimator: estimate });
    await agent.run('hello').result();
    expect(userContents(histories[0])).toEqual(['hello']);

    const seed = new Conversation();
    seed.appendUserMessage(conversationParts());
    await agent.run({ conversation: seed.current }).result();
    expect(userContents(histories[1])).toEqual([parts()]);
  });
});

describe('createLazyAgent.run: ordered parts as input', () => {
  it('snapshots at run() and delivers the same parts after the load completes', async () => {
    const { generate, histories } = recorder();
    const lazy = createLazyAgent(async () =>
      createAgent({ generate, mediaCostEstimator: estimate }),
    );
    const input = parts();

    const run = lazy.run(input);
    input.length = 0;
    await run.result();

    expect(userContents(histories[0])).toEqual([parts()]);
  });

  it('rejects an empty list before loading anything', () => {
    let loaded = false;
    const lazy = createLazyAgent(async () => {
      loaded = true;
      return createAgent({ generate: recorder().generate });
    });
    expect(() => lazy.run([])).toThrow(AgentContractError);
    expect(loaded).toBe(false);
  });
});

describe('SessionHandle.run: ordered parts as input', () => {
  it('appends one user message holding the parts and persists them unchanged', async () => {
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    const { generate, histories } = recorder();
    const handle = createSessionHandle('session-parts', {
      store,
      agentName: 'agent',
      runOptions: {
        generate,
        toolbox: createToolbox([]),
        stopWhen: () => true,
        mediaCostEstimator: estimate,
      },
    });

    await handle.run(parts()).result();

    expect(userContents(histories[0])).toEqual([parts()]);
    const stored = await store.load('session-parts');
    const persisted = stored?.conversationHistory;
    expect(userContents(persisted)).toEqual([parts()]);
  });

  it('snapshots the caller’s array before the reservation, so later mutation cannot reach the run', async () => {
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    const { generate, histories } = recorder();
    const handle = createSessionHandle('session-snapshot', {
      store,
      agentName: 'agent',
      runOptions: {
        generate,
        toolbox: createToolbox([]),
        stopWhen: () => true,
        mediaCostEstimator: estimate,
      },
    });
    const input = parts();

    const run = handle.run(input);
    input.length = 0;
    input.push({ type: 'text', text: 'mutated' });
    await run.result();

    expect(userContents(histories[0])).toEqual([parts()]);
    const stored = await store.load('session-snapshot');
    const persisted = stored?.conversationHistory;
    expect(userContents(persisted)).toEqual([parts()]);
  });

  it('rejects a { conversation } input from an untyped caller with the typed contract error, before reserving a run', async () => {
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    const handle = createSessionHandle('session-conversation-input', {
      store,
      agentName: 'agent',
      runOptions: {
        generate: recorder().generate,
        toolbox: createToolbox([]),
        stopWhen: () => true,
      },
    });

    let thrown: unknown;
    try {
      handle.run({ conversation: new Conversation().current } as never);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AgentContractError);
    expect(await store.load('session-conversation-input')).toBeUndefined();
  });

  it('rejects an empty list before reserving a run', async () => {
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    const handle = createSessionHandle('session-empty', {
      store,
      agentName: 'agent',
      runOptions: {
        generate: recorder().generate,
        toolbox: createToolbox([]),
        stopWhen: () => true,
      },
    });
    expect(() => handle.run([])).toThrow(AgentContractError);
    expect(await store.load('session-empty')).toBeUndefined();
  });
});

describe('SessionHandle.fork: media survives a fork (COR-716)', () => {
  function forkable(sessionId: string) {
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    const { generate, histories } = recorder();
    const handle = createSessionHandle(sessionId, {
      store,
      agentName: 'agent',
      runOptions: {
        generate,
        toolbox: createToolbox([]),
        stopWhen: () => true,
        mediaCostEstimator: estimate,
      },
    });
    return { store, handle, histories };
  }

  it('copies the history with every part unchanged, and the fork runs on with them intact', async () => {
    const { handle, histories } = forkable('fork-media-source');
    await handle.run(parts()).result();
    await drainMicrotasks();

    const forked = await handle.fork();
    const forkedSession = await forked.getSession();

    expect(userContents(forkedSession.conversationHistory)).toEqual([parts()]);

    // A new turn on the fork still shows the model the original parts.
    await forked.run('and now?').result();
    expect(userContents(histories.at(-1))).toEqual([parts(), 'and now?']);
  });

  it('forks at a run boundary with the media of the runs up to it', async () => {
    const { handle } = forkable('fork-media-boundary');
    await handle.run(parts()).result();
    await drainMicrotasks();
    await handle.run('second').result();
    await drainMicrotasks();

    const forked = await handle.fork({ throughRun: 0 });
    const forkedSession = await forked.getSession();

    expect(userContents(forkedSession.conversationHistory)).toEqual([parts()]);
  });
});

describe('child runs: toAgentInput and child context', () => {
  it('forwards parts a toAgentInput projection returns, unchanged and in order', async () => {
    const { generate, histories } = recorder('child answer');
    const child = createAgent({ generate, mediaCostEstimator: estimate });
    const tool = createSubagentTool({
      name: 'inspect',
      description: 'Inspect a document.',
      input: z.object({ question: z.string() }),
      agent: child,
      agentName: 'inspector',
      toAgentInput: ({ question }) => [{ type: 'text', text: question }, image()],
    });

    await (
      tool as unknown as { rawExecute: (p: unknown, c: unknown) => Promise<unknown> }
    ).rawExecute({ question: 'what is this?' }, {});

    expect(userContents(histories[0])).toEqual([
      [{ type: 'text', text: 'what is this?' }, image()],
    ]);
  });

  it('prepareSubagentContext carries text and media parts, not an empty string or marker prose', () => {
    const parent = new Conversation();
    parent.appendSystemMessage('System rules.');
    parent.appendUserMessage(conversationParts());
    parent.appendAssistantMessage([
      { type: 'thinking', thinking: 'private', signature: 'sig' },
      { type: 'text', text: 'reply' },
    ]);

    const child = prepareSubagentContext(parent, {
      instructions: 'Child rules.',
      recentParentMessageCount: 2,
    });

    const contents = child.getMessages().map((message) => [message.role, message.content]);
    expect(contents).toEqual([
      ['system', 'System rules.'],
      ['system', 'Child rules.'],
      ['user', conversationParts()],
      // Provider-private reasoning is not replayed into a child; the text is.
      ['assistant', [{ type: 'text', text: 'reply' }]],
    ]);
  });
});

describe('compaction and retry preserve media', () => {
  it('createContextCompactor keeps a media-bearing message verbatim instead of summarizing it', async () => {
    const conversation = new Conversation();
    conversation.appendUserMessage(conversationParts());
    for (let index = 0; index < 8; index++) {
      conversation.appendUserMessage(`filler ${index}`);
      conversation.appendAssistantMessage(`reply ${index}`);
    }
    const summarized: string[] = [];
    const compact = createContextCompactor({
      summarize: async (messages) => {
        for (const message of messages) {
          summarized.push(JSON.stringify(message.content));
        }
        return 'summary';
      },
      retainRecentMessages: 2,
    });

    await compact(conversation, {} as never);

    const survivors = conversation.getMessages().map((message) => message.content);
    expect(survivors).toContainEqual(conversationParts());
    expect(summarized.some((content) => content.includes('spec.pdf'))).toBe(false);
  });

  it('the sliding-window strategy keeps media-bearing messages outside the window', async () => {
    const conversation = new Conversation();
    conversation.appendUserMessage(conversationParts());
    for (let index = 0; index < 8; index++) conversation.appendUserMessage(`filler ${index}`);

    await createSlidingWindowStrategy()(conversation, createTokenBudget({ maxTokens: 1000 }), {
      retainRecentMessages: 2,
    });

    expect(conversation.getMessages().map((message) => message.content)).toContainEqual(
      conversationParts(),
    );
  });
});

describe('media admission: a part is delivered or refused before generation', () => {
  const catalog = createModelCatalog();
  const anthropicRow = catalog.descriptors.find((d) => d.provider === 'anthropic')!;
  const openAIRow = catalog.descriptors.find((d) => d.provider === 'openai')!;
  const managed: MediaContent = {
    type: 'document',
    source: { kind: 'managed-asset', assetId: 'asset-1', revision: 3 },
    mimeType: 'application/pdf',
  };

  function run(
    content: MultiModalContent[],
    overrides: Partial<RunOptionsBase> = {},
    descriptors: readonly BackendDescriptor[] = [anthropicRow],
  ) {
    const seen = recorder();
    const conversation = new Conversation();
    conversation.appendUserMessage(content);
    const result = createActiveRun({
      generate: withBackendDescriptors(seen.generate, descriptors),
      toolbox: createToolbox([]),
      conversation,
      stopWhen: () => true,
      ...overrides,
    }).result;
    return { seen, result };
  }

  it('refuses a managed asset when nothing can resolve it, and never calls generate', async () => {
    const { seen, result } = run([{ type: 'text', text: 'read' }, managed]);

    const outcome = await result;

    expect(outcome.finishReason).toBe('error');
    expect(outcome.error).toBeInstanceOf(MediaAdmissionError);
    expect((outcome.error as MediaAdmissionError).outcomes).toEqual([
      expect.objectContaining({
        outcome: 'unsupported',
        reason: 'source-form-not-accepted',
        partIndex: 1,
        modality: 'document',
      }),
    ]);
    expect(seen.contexts).toHaveLength(0);
  });

  it('hands generate the resolved source and leaves the stored identity and revision alone', async () => {
    const resolver: ContentSourceResolver = async (part, position) => {
      expect(part).toEqual(managed);
      expect(position.partIndex).toBe(1);
      return {
        outcome: 'resolved',
        source: { kind: 'inline', data: BYTES, encoding: 'base64' },
        byteLength: 7,
        safety: 'clean',
      };
    };
    const { seen, result } = run([{ type: 'text', text: 'read' }, managed], {
      contentSourceResolver: resolver,
    });

    const outcome = await result;

    expect(outcome.finishReason).toBe('stop-condition');
    const context = seen.contexts[0]!;
    const messageId = context.conversation.current.ids[0]!;
    expect(context.resolvedSources?.get(`${messageId}:1`)).toMatchObject({
      outcome: 'resolved',
      source: { kind: 'inline', encoding: 'base64' },
    });
    expect(userContents(seen.histories[0])).toEqual([[{ type: 'text', text: 'read' }, managed]]);
  });

  it('refuses a part the resolver reports unavailable instead of dropping it', async () => {
    const { seen, result } = run([managed], {
      contentSourceResolver: async () => ({ outcome: 'unavailable', reason: 'quarantined' }),
    });
    const outcome = await result;
    expect(outcome.error).toBeInstanceOf(MediaAdmissionError);
    expect(seen.contexts).toHaveLength(0);
  });

  it('refuses a modality the backend does not accept', async () => {
    const { seen, result } = run(
      [{ type: 'audio', source: { kind: 'inline', data: BYTES, encoding: 'base64' } }],
      {},
      [openAIRow],
    );
    const outcome = await result;
    expect(outcome.error).toBeInstanceOf(MediaAdmissionError);
    expect((outcome.error as MediaAdmissionError).outcomes[0]).toMatchObject({
      outcome: 'unsupported',
      reason: 'modality-not-accepted',
    });
    expect(seen.contexts).toHaveLength(0);
  });

  it('refuses a part whose size it cannot bound, rather than pricing it at zero', async () => {
    // OpenAI declares no per-image byte cap, so an unsized remote image has no bound.
    const { seen, result } = run([image()], {}, [openAIRow]);
    const outcome = await result;
    expect((outcome.error as MediaAdmissionError).outcomes[0]).toMatchObject({
      outcome: 'unbounded',
      reason: 'size-unknown',
    });
    expect(seen.contexts).toHaveLength(0);
  });

  it('costs an unsized remote image at the backend’s per-image cap, and admits it', async () => {
    const { seen, result } = run([image()], {});
    const finished = await result;
    expect(finished.finishReason).toBe('stop-condition');
    expect(seen.contexts).toHaveLength(1);
  });

  it('refuses every media part when the generate function carries no descriptors and no estimator', async () => {
    const { seen, result } = run(
      [{ type: 'image', source: { kind: 'inline', data: BYTES, encoding: 'base64' } }],
      {},
      [],
    );
    const outcome = await result;
    expect((outcome.error as MediaAdmissionError).outcomes[0]).toMatchObject({
      outcome: 'unbounded',
      reason: 'no-estimator',
    });
    expect(seen.contexts).toHaveLength(0);
  });

  it('admits a part a caller-supplied estimator prices, and delivers it', async () => {
    const { seen, result } = run(
      [{ type: 'image', source: { kind: 'remote-url', url: 'https://example.com/a.png' } }],
      {
        mediaCostEstimator: (part, position) => ({
          ...position,
          modality: part.type,
          outcome: 'estimated',
          tokens: 1200,
          basis: 'provider-count',
        }),
      },
      [],
    );
    const outcome = await result;
    expect(outcome.finishReason).toBe('stop-condition');
    expect(seen.contexts).toHaveLength(1);
  });

  it('refuses a request over a backend’s per-request media count, naming the parts past the cap', async () => {
    const haiku = catalog.descriptors.find((d) => d.model === 'claude-haiku-4-5')!;
    const inlineImage = (): MediaContent => ({
      type: 'image',
      mimeType: 'image/png',
      source: { kind: 'inline', data: BYTES, encoding: 'base64' },
    });
    const { seen, result } = run(Array.from({ length: 101 }, inlineImage), {}, [haiku]);
    const outcome = await result;
    expect((outcome.error as MediaAdmissionError).outcomes).toEqual([
      expect.objectContaining({
        outcome: 'unsupported',
        reason: 'media-count-exceeded',
        partIndex: 100,
        modality: 'image',
      }),
    ]);
    expect(seen.contexts).toHaveLength(0);

    // At the cap it is admitted; a 1M-token window allows 600.
    const atCap = run(Array.from({ length: 100 }, inlineImage), {}, [haiku]);
    const atCapOutcome = await atCap.result;
    expect(atCapOutcome.finishReason).toBe('stop-condition');
    const sonnet = catalog.descriptors.find((d) => d.model === 'claude-sonnet-5-5')!;
    const wide = run(Array.from({ length: 101 }, inlineImage), {}, [sonnet]);
    const wideOutcome = await wide.result;
    expect(wideOutcome.finishReason).toBe('stop-condition');
  });

  describe('the selection gate sees the step’s media (COR-716)', () => {
    function gateOver(descriptors: readonly BackendDescriptor[]) {
      return createSelectionGate({
        request: (context) => ({
          agentName: 'agent',
          catalogRevision: 1,
          policyRevision: 1,
          availabilitySnapshotRevision: 1,
          ...(context?.inputMedia === undefined ? {} : { inputMedia: context.inputMedia }),
        }),
        options: () => ({
          catalog: {
            revision: 1,
            descriptors,
            generatedAt: '2026-09-02T12:00:00.000Z',
            stale: false,
            projection: 'privileged',
          },
        }),
      });
    }

    it('fails a step whose media no candidate accepts with a typed policy error, before generate', async () => {
      // The generate function reports no backend, so admission has nothing to
      // judge reachability by and the gate's catalog is what refuses the audio.
      const { seen, result } = run(
        [{ type: 'audio', source: { kind: 'inline', data: BYTES, encoding: 'base64' } }],
        { selection: gateOver([anthropicRow]), mediaCostEstimator: estimate },
        [],
      );

      const outcome = await result;

      expect(outcome.finishReason).toBe('error');
      expect(outcome.error).toBeInstanceOf(SelectionRevalidationError);
      expect((outcome.error as SelectionRevalidationError).plan.candidates[0]?.exclusionCode).toBe(
        'incompatible-modality',
      );
      expect(seen.contexts).toHaveLength(0);
    });

    it('judges a managed asset by the form it resolves to, not the form it is stored as', async () => {
      const resolver: ContentSourceResolver = async () => ({
        outcome: 'resolved',
        source: { kind: 'inline', data: BYTES, encoding: 'base64' },
        mimeType: 'application/pdf',
        safety: 'clean',
      });
      // A managed-asset source is in no backend's accepted forms, so only the resolved
      // inline form can make the document eligible.
      const { seen, result } = run(
        [managed],
        { selection: gateOver([anthropicRow]), contentSourceResolver: resolver },
        [anthropicRow],
      );

      const outcome = await result;

      expect(outcome.finishReason).toBe('stop-condition');
      expect(seen.contexts).toHaveLength(1);
    });

    it('leaves a run with no media exactly as it was', async () => {
      const gate = gateOver([anthropicRow]);
      const { seen, result } = run([{ type: 'text', text: 'plain' }], { selection: gate }, [
        anthropicRow,
      ]);

      const finished = await result;
      expect(finished.finishReason).toBe('stop-condition');
      expect(seen.contexts).toHaveLength(1);
      expect(gate.getPlan()?.request.inputMedia).toBeUndefined();
    });
  });

  it('refuses a media type that does not fit the part, when it comes from a resolver or a data URL', async () => {
    const mismatchedResolver: ContentSourceResolver = async () => ({
      outcome: 'resolved',
      source: { kind: 'inline', data: BYTES, encoding: 'base64' },
      mimeType: 'application/pdf',
      safety: 'clean',
    });
    const fromResolver = run(
      [{ type: 'image', source: { kind: 'managed-asset', assetId: 'a' } }],
      { contentSourceResolver: mismatchedResolver },
      [anthropicRow],
    );
    const fromDataUrl = run(
      [{ type: 'image', source: { kind: 'data-url', url: 'data:application/pdf;base64,QUJD' } }],
      {},
      [anthropicRow],
    );

    for (const attempt of [fromResolver, fromDataUrl]) {
      const outcome = await attempt.result;
      expect((outcome.error as MediaAdmissionError).outcomes[0]).toMatchObject({
        outcome: 'unsupported',
        reason: 'mime-type-mismatch',
        modality: 'image',
      });
      expect(attempt.seen.contexts).toHaveLength(0);
    }
  });

  it('refuses the parts past a backend’s aggregate byte limit on a modality', async () => {
    const capped: BackendDescriptor = {
      ...anthropicRow,
      mediaLimits: [{ scope: 'aggregate', modality: 'image', maxBytes: 15 }],
    };
    const image = (): MediaContent => ({
      type: 'image',
      mimeType: 'image/png',
      source: { kind: 'inline', data: BYTES, encoding: 'base64' },
    });

    const over = run([image(), image(), image()], {}, [capped]);
    const outcome = await over.result;
    expect((outcome.error as MediaAdmissionError).outcomes).toEqual([
      expect.objectContaining({
        outcome: 'unbounded',
        reason: 'media-limit-exceeded',
        partIndex: 2,
        modality: 'image',
      }),
    ]);
    expect(over.seen.contexts).toHaveLength(0);

    const within = run([image(), image()], {}, [capped]);
    const withinOutcome = await within.result;
    expect(withinOutcome.finishReason).toBe('stop-condition');
  });

  describe('a beforeGenerate handler cannot add media past admission', () => {
    function withHook(
      handler: (context: GenerateContext) => GenerateContext | void,
      overrides: Partial<RunOptionsBase> = {},
    ) {
      const hooks = new HookRegistry<OperativeHookMap>();
      hooks.on('beforeGenerate', async (context) => handler(context));
      return run([{ type: 'text', text: 'plain' }], { hooks, ...overrides });
    }

    it('re-admits media a handler appended: an unresolvable asset fails the step before generate', async () => {
      const { seen, result } = withHook((context) => {
        context.conversation.appendUserMessage([managed]);
      });
      const outcome = await result;
      expect(outcome.error).toBeInstanceOf(MediaAdmissionError);
      expect(seen.contexts).toHaveLength(0);
    });

    it('re-admits a replaced conversation, costing its media against the backend', async () => {
      const { seen, result } = withHook((context) => {
        const replacement = new Conversation();
        replacement.appendUserMessage([
          { type: 'audio', source: { kind: 'inline', data: BYTES, encoding: 'base64' } },
        ]);
        return { ...context, conversation: replacement };
      }, {});
      const outcome = await result;
      expect(outcome.error).toBeInstanceOf(MediaAdmissionError);
      expect((outcome.error as MediaAdmissionError).outcomes[0]).toMatchObject({
        reason: 'modality-not-accepted',
      });
      expect(seen.contexts).toHaveLength(0);
    });

    it('refuses an appended asset the safety gate flagged', async () => {
      const { seen, result } = withHook(
        (context) => {
          context.conversation.appendUserMessage([managed]);
        },
        {
          contentSourceResolver: async () => ({
            outcome: 'resolved',
            source: { kind: 'inline', data: BYTES, encoding: 'base64' },
            byteLength: 7,
            safety: 'flagged',
          }),
        },
      );
      const outcome = await result;
      expect((outcome.error as MediaAdmissionError).outcomes[0]).toMatchObject({
        reason: 'asset-flagged',
      });
      expect(seen.contexts).toHaveLength(0);
    });

    const unverified = {
      contentSourceResolver: (async () => ({
        outcome: 'resolved',
        source: { kind: 'inline', data: BYTES, encoding: 'base64' },
        byteLength: 7,
        safety: 'unknown',
      })) as ContentSourceResolver,
    };

    it('applies the run’s unverified-asset policy to an asset a handler appended', async () => {
      const { seen, result } = withHook(
        (context) => {
          context.conversation.appendUserMessage([managed]);
        },
        { ...unverified, assetSafety: { unknown: 'block' } },
      );
      const outcome = await result;
      expect((outcome.error as MediaAdmissionError).outcomes[0]).toMatchObject({
        reason: 'asset-unverified',
      });
      expect(seen.contexts).toHaveLength(0);
    });

    it('lets an unverified appended asset through when the policy allows it, as it does by default', async () => {
      for (const assetSafety of [undefined, { unknown: 'allow' as const }]) {
        const { seen, result } = withHook(
          (context) => {
            context.conversation.appendUserMessage([managed]);
          },
          { ...unverified, ...(assetSafety === undefined ? {} : { assetSafety }) },
        );
        const finished = await result;
        expect(finished.finishReason).toBe('stop-condition');
        expect(seen.contexts).toHaveLength(1);
      }
    });

    it('takes the policy from the agent’s own input guardrail declaration', async () => {
      const seen = recorder();
      const agent = createAgent({
        generate: withBackendDescriptors(seen.generate, [anthropicRow]),
        guardrails: { input: { detectors: [], assetSafety: { unknown: 'block' } } },
        contentSourceResolver: unverified.contentSourceResolver,
        mediaCostEstimator: estimate,
        hooks: (() => {
          const registry = new HookRegistry<OperativeHookMap>();
          registry.on('beforeGenerate', async (context) => {
            context.conversation.appendUserMessage([managed]);
          });
          return registry;
        })(),
      });

      const outcome = await agent.run('plain').result();

      expect((outcome.error as MediaAdmissionError).outcomes[0]).toMatchObject({
        reason: 'asset-unverified',
      });
      expect(seen.contexts).toHaveLength(0);
    });

    it('hands generate the resolved sources of media a handler appended', async () => {
      const { seen, result } = withHook(
        (context) => {
          context.conversation.appendUserMessage([managed]);
        },
        {
          contentSourceResolver: async () => ({
            outcome: 'resolved',
            source: { kind: 'inline', data: BYTES, encoding: 'base64' },
            byteLength: 7,
            safety: 'clean',
          }),
        },
      );
      await result;
      const appended = seen.histories[0]!.ids.at(-1)!;
      expect(seen.contexts[0]?.resolvedSources?.get(`${appended}:0`)).toMatchObject({
        outcome: 'resolved',
      });
    });

    it('leaves a handler that changes no media alone', async () => {
      const { seen, result } = withHook(() => undefined);
      const finished = await result;
      expect(finished.finishReason).toBe('stop-condition');
      expect(seen.contexts).toHaveLength(1);
    });
  });

  it('counts media tokens toward the compaction threshold', async () => {
    let compacted = false;
    const { result } = run(
      [
        {
          type: 'image',
          source: { kind: 'inline', data: BYTES, encoding: 'base64' },
          mimeType: 'image/png',
        },
      ],
      {
        mediaCostEstimator: (part, position) => ({
          ...position,
          modality: part.type,
          outcome: 'estimated',
          tokens: 5000,
          basis: 'catalog-estimate',
        }),
        contextManagement: {
          maxTokens: 1000,
          tokenEstimator: () => 10,
          onCompact: async () => {
            compacted = true;
          },
        },
      },
    );
    await result;
    expect(compacted).toBe(true);
  });
});

describe('providers deliver every part or reject before the provider call', () => {
  function contextFor(
    content: MultiModalContent[],
    resolvedSources?: GenerateContext['resolvedSources'],
  ): GenerateContext {
    const conversation = new Conversation();
    conversation.appendUserMessage(content);
    return { conversation, step: 0, toolbox: createToolbox([]), resolvedSources };
  }

  const dataUrlImage: MediaContent = {
    type: 'image',
    source: { kind: 'data-url', url: `data:image/png;base64,${BYTES}` },
  };
  const inlinePdf: MediaContent = {
    type: 'document',
    name: 'spec.pdf',
    mimeType: 'application/pdf',
    source: { kind: 'inline', data: BYTES, encoding: 'base64' },
  };

  it('OpenAI: sends the image and the file part in order, and records both in the response lineage', async () => {
    const client = createMockOpenAIClient([openAITextResponse]);
    const generate = createOpenAIProvider({ model: 'gpt-4.1', client });

    const response = await generate(
      contextFor([{ type: 'text', text: 'look' }, dataUrlImage, inlinePdf]),
    );

    expect(client._calls[0]?.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${BYTES}` } },
          {
            type: 'file',
            file: { file_data: `data:application/pdf;base64,${BYTES}`, filename: 'spec.pdf' },
          },
        ],
      },
    ]);
    expect(response.metadata?.['inputLineage']).toEqual([
      expect.objectContaining({ partIndex: 1, modality: 'image', provider: 'openai' }),
      expect.objectContaining({ partIndex: 2, modality: 'document', transform: 'inline-base64' }),
    ]);
  });

  it('every provider records lineage on a response that only calls tools', async () => {
    const openai = await createOpenAIProvider({
      model: 'gpt-4.1',
      client: createMockOpenAIClient([openAIToolCallResponse]),
    })(contextFor([dataUrlImage]));
    const anthropic = await createAnthropicProvider({
      model: 'claude-sonnet-5-5',
      client: createMockAnthropicClient([anthropicToolUseResponse]),
    })(contextFor([dataUrlImage]));
    const gemini = await createGeminiProvider({
      model: 'gemini-2.5-flash',
      client: createMockGeminiModel([geminiFunctionCallResponse]),
    })(contextFor([dataUrlImage]));

    for (const response of [openai, anthropic, gemini]) {
      expect(response.toolCalls.length).toBeGreaterThan(0);
      expect(response.metadata?.['inputLineage']).toEqual([
        expect.objectContaining({ partIndex: 0, modality: 'image' }),
      ]);
    }
  });

  it('OpenAI: rejects audio before the client is called, with a typed error', async () => {
    const client = createMockOpenAIClient([openAITextResponse]);
    const generate = createOpenAIProvider({ model: 'gpt-4.1', client });

    const reason = await rejectionOf(
      generate(
        contextFor([
          { type: 'audio', source: { kind: 'inline', data: BYTES, encoding: 'base64' } },
        ]),
      ),
    );

    expect(reason).toBeInstanceOf(UnsupportedContentError);
    expect(client._calls).toHaveLength(0);
  });

  it('Anthropic: substitutes a resolved source at export time and records the original asset identity', async () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);
    const generate = createAnthropicProvider({ model: 'claude-sonnet-5-5', client });
    const managed: MediaContent = {
      type: 'document',
      name: 'contract.pdf',
      mimeType: 'application/pdf',
      source: { kind: 'managed-asset', assetId: 'asset-9', revision: 2 },
    };
    const context = contextFor([managed]);
    const messageId = context.conversation.current.ids[0]!;

    const response = await generate({
      ...context,
      resolvedSources: new Map([
        [
          `${messageId}:0`,
          {
            outcome: 'resolved',
            source: { kind: 'inline', data: BYTES, encoding: 'base64' },
            safety: 'clean',
          },
        ],
      ]),
    });

    expect(client._calls[0]?.messages).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'document',
            title: 'contract.pdf',
            source: { type: 'base64', media_type: 'application/pdf', data: BYTES },
          },
        ],
      },
    ]);
    expect(response.metadata?.['inputLineage']).toEqual([
      expect.objectContaining({
        from: 'managed-asset',
        to: 'inline',
        transform: 'resolved',
        assetId: 'asset-9',
        revision: 2,
      }),
    ]);
    // The stored message still names the asset and revision.
    expect(context.conversation.getMessages()[0]?.content).toEqual([managed]);
  });

  it('Anthropic: rejects an unresolved managed asset instead of dropping it', async () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);
    const generate = createAnthropicProvider({ model: 'claude-sonnet-5-5', client });

    const reason = await rejectionOf(
      generate(
        contextFor([
          {
            type: 'document',
            source: { kind: 'managed-asset', assetId: 'asset-9' },
            mimeType: 'application/pdf',
          },
        ]),
      ),
    );

    expect(reason).toBeInstanceOf(UnsupportedContentError);
    expect((reason as UnsupportedContentError).reason).toBe('source-form-not-accepted');
    expect(client._calls).toHaveLength(0);
  });

  it('Gemini: sends audio as inline data and a hosted video as file data', async () => {
    const client = createMockGeminiModel([geminiTextResponse]);
    const generate = createGeminiProvider({ model: 'gemini-2.5-flash', client });

    const response = await generate(
      contextFor([
        {
          type: 'audio',
          mimeType: 'audio/mpeg',
          source: { kind: 'inline', data: BYTES, encoding: 'base64' },
        },
        {
          type: 'video',
          mimeType: 'video/mp4',
          source: { kind: 'remote-url', url: 'https://example.com/v.mp4' },
        },
      ]),
    );

    expect(client._calls[0]?.contents).toEqual([
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'audio/mpeg', data: BYTES } },
          { fileData: { mimeType: 'video/mp4', fileUri: 'https://example.com/v.mp4' } },
        ],
      },
    ]);
    expect(response.metadata?.['inputLineage']).toEqual([
      expect.objectContaining({ modality: 'audio', transform: 'inline-base64' }),
      expect.objectContaining({ modality: 'video', transform: 'remote-url-delegated' }),
    ]);
  });
});

describe('the static catalog and the adapters agree on what each backend accepts', () => {
  const SOURCE_KINDS: ContentSource['kind'][] = [
    'inline',
    'data-url',
    'remote-url',
    'local-file',
    'upload',
    'provider-file',
    'mcp-resource',
    'a2a-reference',
    'managed-asset',
  ];
  const MIME: Record<MediaContent['type'], string> = {
    image: 'image/png',
    audio: 'audio/mpeg',
    video: 'video/mp4',
    document: 'application/pdf',
    file: 'application/zip',
  };

  function sourceFor(
    provider: 'openai' | 'anthropic' | 'gemini',
    kind: ContentSource['kind'],
    type: MediaContent['type'],
  ): ContentSource {
    switch (kind) {
      case 'inline':
        return { kind, data: BYTES, encoding: 'base64' };
      case 'data-url':
        return { kind, url: `data:${MIME[type]};base64,${BYTES}` };
      case 'remote-url':
        return { kind, url: 'https://example.com/probe.bin' };
      case 'local-file':
        return { kind, path: '/tmp/probe.bin' };
      case 'upload':
        return { kind, uploadId: 'upload-1' };
      case 'provider-file':
        return { kind, provider, providerFileId: 'file-1' };
      case 'mcp-resource':
        return { kind, serverId: 'server', uri: 'resource://probe' };
      case 'a2a-reference':
        return { kind, agentCardUrl: 'https://agent.example', taskId: 't', artifactId: 'a' };
      case 'managed-asset':
        return { kind, assetId: 'asset' };
    }
  }

  function adapterAccepts(
    provider: 'openai' | 'anthropic' | 'gemini',
    part: MediaContent,
  ): boolean {
    const history = new Conversation();
    history.appendUserMessage([part]);
    try {
      if (provider === 'openai') toOpenAIMessages(history.current);
      else if (provider === 'anthropic') toAnthropicMessages(history.current);
      else toGeminiMessages(history.current);
      return true;
    } catch (error) {
      if (error instanceof UnsupportedContentError) return false;
      throw error;
    }
  }

  const catalogByProvider = new Map(
    createModelCatalog().descriptors.map((descriptor) => [descriptor.provider, descriptor]),
  );

  for (const provider of ['openai', 'anthropic', 'gemini'] as const) {
    for (const type of ['image', 'audio', 'video', 'document', 'file'] as const) {
      it(`${provider} ${type}: adapter acceptance equals the descriptor's declaration`, () => {
        const descriptor = catalogByProvider.get(provider)!;
        const entry = descriptor.modalities[type];
        for (const kind of SOURCE_KINDS) {
          const declared = entry.input && entry.sourceForms.includes(kind);
          const part: MediaContent = {
            type,
            source: sourceFor(provider, kind, type),
            mimeType: MIME[type],
            name: 'probe',
          };
          expect([provider, type, kind, adapterAccepts(provider, part)]).toEqual([
            provider,
            type,
            kind,
            declared,
          ]);
        }
      });
    }
  }
});

describe('lineage reaches the transcript on a step that only calls tools', () => {
  it('stamps inputLineage on the first tool-call message when the response has no text', async () => {
    const lineage = [
      {
        messageId: 'm',
        partIndex: 1,
        modality: 'image',
        provider: 'openai',
        from: 'inline',
        to: 'data-url',
        transform: 'inline-base64',
      },
    ];
    let calls = 0;
    const generate: GenerateFunction = async () => {
      calls += 1;
      return calls === 1
        ? {
            content: '',
            toolCalls: [{ id: 'call-1', name: 'noop', arguments: {} }],
            metadata: { inputLineage: lineage },
          }
        : { content: 'done', toolCalls: [] };
    };
    const noop = createTool({
      name: 'noop',
      description: 'does nothing',
      input: z.object({}),
      async execute() {
        return 'ok';
      },
    });
    const conversation = new Conversation();
    conversation.appendUserMessage('go');

    await createActiveRun({
      generate,
      toolbox: createToolbox([noop]),
      conversation,
      stopWhen: noToolCalls(),
    }).result;

    const toolCall = conversation.getMessages().find((message) => message.role === 'tool-call');
    expect(toolCall?.metadata['inputLineage']).toEqual(lineage);
    // Later steps carry none: lineage belongs to the request that produced it.
    const second = conversation.getMessages().filter((m) => m.role === 'assistant');
    expect(second.every((message) => message.metadata['inputLineage'] === undefined)).toBe(true);
  });
});
