/**
 * COR-716: every Agent start path either delivers the caller's ordered media
 * parts to the provider boundary losslessly, or fails with a typed error before
 * generation. Each row ends in a no-silent-loss assertion: the parts reach
 * `generate` equal to what went in, in order, or a typed error names why not.
 */
import { MemoryStorage, textValueStore, yieldToPortableEventLoop } from '@lostgradient/weft';
import { createToolbox } from 'armorer';
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
import { AgentContractError, MediaAdmissionError } from '../src/errors';
import { createAnthropicProvider } from '../src/providers/anthropic.ts';
import { withBackendDescriptors } from '../src/providers/backend-descriptor-attachment';
import { createGeminiProvider } from '../src/providers/gemini.ts';
import type { BackendDescriptor } from '../src/providers/model-catalog';
import { createModelCatalog } from '../src/providers/model-catalog';
import { createOpenAIProvider } from '../src/providers/openai.ts';
import {
  anthropicTextResponse,
  geminiTextResponse,
  openAITextResponse,
} from '../src/providers/test/fixtures.ts';
import {
  createMockAnthropicClient,
  createMockGeminiModel,
  createMockOpenAIClient,
} from '../src/providers/test/mock-clients.ts';
import { createSessionStore } from '../src/session/create-session-store';
import { createSessionHandle } from '../src/session/session-handle';
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
    await yieldToPortableEventLoop();
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
    const { seen, result } = run([image()], { mediaCostEstimator: undefined });
    const outcome = await result;
    expect((outcome.error as MediaAdmissionError).outcomes[0]).toMatchObject({
      outcome: 'unbounded',
      reason: 'size-unknown',
    });
    expect(seen.contexts).toHaveLength(0);
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
