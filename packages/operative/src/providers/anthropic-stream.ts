import type { ToolCallInput } from 'armorer/protocol';
import {
  type BlockAccumulatorState,
  createStreamingAccumulator,
  finalizeBlockState,
  type JSONValue,
  type MultiModalContent,
  toAnthropicMessages,
} from 'conversationalist';

import { concatenateTextParts } from '../response-parts.ts';
import type { PartDelta } from '../streaming/types.ts';
import { ANTHROPIC_CONTROL_EVENT_TYPES, anthropicOpeningState } from './anthropic-blocks.ts';
import { createAnthropicSdkClient, isAnthropicStreamingClient } from './anthropic-sdk.ts';
import {
  anthropicDescriptorsFor,
  assertDisabledThinkingSupported,
  assertManualThinkingSupported,
  assertSamplingParametersSupported,
  assertThinkingBudgetBelowMaximum,
  assertThinkingBudgetMeetsMinimum,
  assertThinkingParametersCompatible,
  assertToolChoiceSupported,
  buildAnthropicMessageRequest,
} from './anthropic-shared.ts';
import type { AnthropicProviderOptions, AnthropicStreamingClient } from './anthropic-types.ts';
import { withBackendDescriptors } from './backend-descriptor-attachment.ts';
import { ProviderContractError, ProviderError, ToolCallParseError } from './errors.ts';
import { createCacheAwareAssembly } from './shared/cache-aware-assembly.ts';
import { resolveAnthropicEffort } from './shared/effort.ts';
import { withInputLineage } from './shared/input-lineage.ts';
import { resolveAnthropicModel } from './shared/model-registry.ts';
import { resolveCommonParameters } from './shared/resolve-common-parameters.ts';
import type {
  GenerateContext,
  GenerateResponse,
  StreamingGenerateFunction,
  StreamingHandle,
} from './types.ts';

/**
 * Creates a StreamingGenerateFunction backed by the Anthropic Messages API.
 *
 * Streams events from the API, progressively calling `streaming.update`
 * with accumulated text and collecting tool call fragments into complete
 * ToolCallInput objects.
 *
 * When no `client` is provided, lazily loads `@anthropic-ai/sdk` in Bun or Node.js
 * and constructs one using `apiKey` or the `ANTHROPIC_API_KEY` env var.
 */
export function createAnthropicProviderStream(
  options: Omit<AnthropicProviderOptions, 'client'> & {
    client?: AnthropicStreamingClient | undefined;
  },
): StreamingGenerateFunction {
  const { maximumTokens = 4096 } = options;
  const resolvedModel = resolveAnthropicModel(options.model);
  const resolvedEffort = options.effort
    ? resolveAnthropicEffort(options.effort, resolvedModel)
    : undefined;
  const common = resolveCommonParameters(options);
  assertSamplingParametersSupported(resolvedModel, common);
  assertDisabledThinkingSupported(resolvedModel, options.thinking, resolvedEffort);
  assertManualThinkingSupported(resolvedModel, options.thinking);
  assertToolChoiceSupported(resolvedModel, options.toolChoice);
  assertThinkingBudgetMeetsMinimum(options.thinking);
  assertThinkingParametersCompatible(options.thinking, options.toolChoice, common);
  let clientPromise: Promise<AnthropicStreamingClient> | undefined;
  const cacheAwareAssembly =
    options.assembler && options.contextBudget
      ? createCacheAwareAssembly(
          options.assembler,
          options.contextBudget,
          options.pinnedMessages,
          anthropicDescriptorsFor(resolvedModel),
        )
      : undefined;

  function getClient(): Promise<AnthropicStreamingClient> {
    if (options.client) return Promise.resolve(options.client);
    if (!clientPromise) {
      clientPromise = Promise.resolve().then(() => {
        const clientOptions: Record<string, unknown> = { apiKey: options.apiKey };
        if (options.baseURL) clientOptions['baseURL'] = options.baseURL;
        return createAnthropicSdkClient<AnthropicStreamingClient>(
          clientOptions,
          isAnthropicStreamingClient,
        );
      });
    }
    return clientPromise;
  }

  const generate: StreamingGenerateFunction = async (
    context: GenerateContext & { streaming: StreamingHandle },
  ): Promise<GenerateResponse> => {
    const effectiveMaximumTokens = context.maximumTokens ?? maximumTokens;
    assertThinkingBudgetBelowMaximum(options.thinking, effectiveMaximumTokens);
    const client = await getClient();
    const { streaming } = context;
    const conversationForRequest = cacheAwareAssembly
      ? cacheAwareAssembly(context)
      : context.conversation.current;
    const { system, messages, lineage } = toAnthropicMessages(conversationForRequest, {
      ...(options.extendedCacheTtl ? { extendedCacheTtl: true } : {}),
      sources: context.resolvedSources,
    });
    const tools = await context.toolbox.toAnthropicTools();
    const params = buildAnthropicMessageRequest({
      model: resolvedModel,
      messages,
      maxTokens: effectiveMaximumTokens,
      system,
      stream: true,
      effort: resolvedEffort,
      thinking: options.thinking,
      metadata: options.requestMetadata,
      tools,
      toolChoice: options.toolChoice,
      common,
    });

    const requestOptions = context.signal ? { signal: context.signal } : undefined;

    try {
      // Await handles both sync (mock) and async (real SDK APIPromise) returns
      const stream = await Promise.resolve(client.messages.create(params, requestOptions));

      return withInputLineage(
        await consumeAnthropicStream(
          stream,
          streaming,
          context.signal,
          resolvedModel,
          resolvedEffort,
        ),
        lineage,
      );
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError({ provider: 'anthropic', cause: error });
    }
  };

  return withBackendDescriptors(generate, anthropicDescriptorsFor(resolvedModel));
}

async function consumeAnthropicStream(
  stream: AsyncIterable<import('./anthropic-types.ts').AnthropicStreamEvent>,
  streaming: StreamingHandle,
  signal: AbortSignal | undefined,
  model: string,
  effort: string | undefined,
): Promise<GenerateResponse> {
  const state: StreamState = {
    accumulatedText: '',
    inputTokens: undefined,
    outputTokens: undefined,
    cacheCreationTokens: undefined,
    cacheReadTokens: undefined,
    pendingToolCalls: new Map(),
    accumulator: createStreamingAccumulator(),
    parts: new Map(),
    nextPartIndex: 0,
    sequences: new Map(),
    violation: undefined,
    openBlocks: new Map(),
  };
  for await (const event of stream) {
    if (signal?.aborted) break;
    handleAnthropicStreamEvent(event, state, streaming);
  }
  const usage = buildStreamUsage(state);
  // An unlisted block or delta is the model's output the adapter cannot map. It fails the response
  // after the stream has drained, carrying the usage the stream reported, so the loop accounts it.
  if (state.violation !== undefined) {
    throw new ProviderContractError({
      provider: 'anthropic',
      reason: 'unlisted-block',
      blockType: state.violation.blockType,
      partIndex: state.violation.position,
      usage,
    });
  }
  // A stream that ends before a block it opened has stopped was cut off. The half block is never
  // finalized into a part and the response never completes empty: it fails typed, and is never
  // retried (a contract error). An abort ends the loop early on purpose and is not truncation.
  const truncated = signal?.aborted ? undefined : [...state.openBlocks.entries()][0];
  if (truncated !== undefined) {
    throw new ProviderContractError({
      provider: 'anthropic',
      reason: 'truncated-stream',
      blockType: truncated[1],
      partIndex: truncated[0],
      usage,
    });
  }
  const toolCalls = completeAnthropicToolCalls(state.pendingToolCalls, signal?.aborted);
  const parts = [...state.parts.values()]
    .filter((entry) => entry.partIndex !== undefined)
    .toSorted((left, right) => left.partIndex! - right.partIndex!)
    .map((entry) => entry.part)
    .filter((part): part is MultiModalContent => part !== undefined);
  return {
    content: concatenateTextParts(parts),
    parts,
    toolCalls,
    usage,
    metadata: { effectiveModel: model, effectiveEffort: effort ?? 'none' },
  };
}

type PendingToolCall = {
  id: string | undefined;
  name: string;
  partialJson: string;
  blockId: string | undefined;
};
type StreamState = {
  accumulatedText: string;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  cacheCreationTokens: number | null | undefined;
  cacheReadTokens: number | null | undefined;
  pendingToolCalls: Map<number, PendingToolCall>;
  /** Accumulates every content block (not the client `tool_use`, which `pendingToolCalls` owns). */
  accumulator: ReturnType<typeof createStreamingAccumulator>;
  /** Provider block index to the part it became, and the part once its block stopped. */
  parts: Map<number, { partIndex: number | undefined; part: MultiModalContent | undefined }>;
  /** Parts count only content blocks, so a `tool_use` between two text blocks does not take an index. */
  nextPartIndex: number;
  /** The last delta sequence reported per part index. */
  sequences: Map<number, number>;
  /** The first block or delta outside the mapping table, in the provider's own sequence. */
  violation: { blockType: string; position: number } | undefined;
  /** Provider block index to type, for every block that has started and not yet stopped. */
  openBlocks: Map<number, string>;
};

function handleAnthropicStreamEvent(
  event: import('./anthropic-types.ts').AnthropicStreamEvent,
  state: StreamState,
  streaming: StreamingHandle,
): void {
  if (event.type === 'message_start') return handleAnthropicMessageStart(event, state);
  if (event.type === 'content_block_start')
    return handleAnthropicBlockStart(event, state, streaming);
  if (event.type === 'content_block_delta')
    return handleAnthropicBlockDelta(event, state, streaming);
  if (event.type === 'content_block_stop') return handleAnthropicBlockStop(event, state, streaming);
  if (event.type === 'message_delta') {
    state.outputTokens = event.usage?.output_tokens;
    return;
  }
  // `message_stop` and `ping` carry no output; any other event type is outside the table.
  if (!ANTHROPIC_CONTROL_EVENT_TYPES.has(event.type)) {
    state.violation ??= { blockType: event.type, position: event.index ?? state.nextPartIndex };
  }
}

function handleAnthropicMessageStart(
  event: import('./anthropic-types.ts').AnthropicStreamEvent,
  state: StreamState,
): void {
  state.inputTokens = event.message?.usage?.input_tokens;
  state.cacheCreationTokens = event.message?.usage?.cache_creation_input_tokens;
  state.cacheReadTokens = event.message?.usage?.cache_read_input_tokens;
}

function partKindOf(blockState: BlockAccumulatorState): MultiModalContent['type'] {
  return blockState.type === 'tool_use' ? 'text' : blockState.type;
}

function handleAnthropicBlockStart(
  event: import('./anthropic-types.ts').AnthropicStreamEvent,
  state: StreamState,
  streaming: StreamingHandle,
): void {
  const block = event.content_block;
  if (block === undefined || event.index === undefined) return;
  state.openBlocks.set(event.index, block.type);
  if (block.type === 'tool_use') {
    const blockId = block.id;
    const pending = { id: blockId, name: block.name!, partialJson: '', blockId };
    state.pendingToolCalls.set(event.index, pending);
    if (blockId !== undefined)
      streaming.report?.({ type: 'stream:tool-call-start', toolName: pending.name, blockId });
    return;
  }
  const opening = anthropicOpeningState(block);
  if (opening === undefined) {
    state.violation ??= { blockType: block.type, position: event.index };
    return;
  }
  const entry: { partIndex: number | undefined; part: MultiModalContent | undefined } = {
    partIndex: undefined,
    part: undefined,
  };
  state.parts.set(event.index, entry);
  state.accumulator.openBlock(event.index, opening);
  // A text block takes its part index with its first non-empty text, so an empty one (which the
  // mapping table skips, as Anthropic rejects it on replay) leaves no hole in the indexes and no
  // part; every other block is a part from its start.
  if (opening.type !== 'text') {
    ensurePart(state, streaming, entry, partKindOf(opening));
    return;
  }
  // Text that arrives with the start event (a hand-built stream) is a delta like any other.
  if (opening.buffer !== '') {
    const partIndex = ensurePart(state, streaming, entry, 'text');
    reportDelta(state, streaming, partIndex, { kind: 'text', text: opening.buffer });
    state.accumulatedText += opening.buffer;
    if (streaming.reportPart === undefined) streaming.update(state.accumulatedText);
  }
}

/** Gives a block its part index and announces the part, once. */
function ensurePart(
  state: StreamState,
  streaming: StreamingHandle,
  entry: { partIndex: number | undefined },
  kind: MultiModalContent['type'],
): number {
  if (entry.partIndex === undefined) {
    entry.partIndex = state.nextPartIndex++;
    streaming.reportPart?.({ type: 'start', partIndex: entry.partIndex, kind });
  }
  return entry.partIndex;
}

function reportDelta(
  state: StreamState,
  streaming: StreamingHandle,
  partIndex: number,
  delta: PartDelta,
): void {
  const sequence = (state.sequences.get(partIndex) ?? 0) + 1;
  state.sequences.set(partIndex, sequence);
  streaming.reportPart?.({ type: 'delta', partIndex, sequence, delta });
}

function handleAnthropicBlockDelta(
  event: import('./anthropic-types.ts').AnthropicStreamEvent,
  state: StreamState,
  streaming: StreamingHandle,
): void {
  const delta = event.delta;
  if (delta === undefined || event.index === undefined) return;
  const entry = state.parts.get(event.index);
  const block = entry === undefined ? undefined : state.accumulator.getBlock(event.index);

  if (delta.type === 'text_delta') {
    if (!delta.text) return;
    block?.appendTextDelta(delta.text);
    state.accumulatedText += delta.text;
    if (entry !== undefined) {
      const partIndex = ensurePart(state, streaming, entry, 'text');
      reportDelta(state, streaming, partIndex, { kind: 'text', text: delta.text });
    }
    if (streaming.reportPart === undefined) streaming.update(state.accumulatedText);
    return;
  }
  if (delta.type === 'thinking_delta') {
    const thinking = delta.thinking ?? '';
    if (thinking === '') return;
    block?.appendThinkingDelta(thinking);
    if (entry?.partIndex !== undefined)
      reportDelta(state, streaming, entry.partIndex, { kind: 'thinking', thinking });
    return;
  }
  if (delta.type === 'signature_delta') {
    // The signature is replay data with no live meaning: the completed part carries it whole.
    block?.appendSignatureDelta(delta.signature ?? '');
    return;
  }
  if (delta.type === 'citations_delta') {
    block?.appendCitationsDelta(delta.citation as JSONValue);
    if (entry?.partIndex !== undefined) {
      reportDelta(state, streaming, entry.partIndex, {
        kind: 'citation',
        citation: delta.citation as JSONValue,
      });
    }
    return;
  }
  if (delta.type === 'input_json_delta') {
    if (entry !== undefined) {
      // A server tool's input.
      block?.appendInputJsonDelta(delta.partial_json ?? '');
      if (entry.partIndex === undefined) return;
      reportDelta(state, streaming, entry.partIndex, {
        kind: 'input-json',
        partialJson: delta.partial_json ?? '',
      });
      return;
    }
    handleAnthropicJsonDelta(event, state, streaming);
    return;
  }
  state.violation ??= { blockType: delta.type ?? 'unknown_delta', position: event.index };
}

function handleAnthropicBlockStop(
  event: import('./anthropic-types.ts').AnthropicStreamEvent,
  state: StreamState,
  streaming: StreamingHandle,
): void {
  if (event.index === undefined) return;
  state.openBlocks.delete(event.index);
  const entry = state.parts.get(event.index);
  const block = entry === undefined ? undefined : state.accumulator.getBlock(event.index);
  if (entry === undefined || block === undefined) return;
  const part = finalizeBlockState(block.state);
  // A block that never took a part index (an empty text block) is not a part.
  if (part === undefined || entry.partIndex === undefined) return;
  entry.part = part;
  streaming.reportPart?.({ type: 'complete', partIndex: entry.partIndex, part });
}

function handleAnthropicJsonDelta(
  event: import('./anthropic-types.ts').AnthropicStreamEvent,
  state: StreamState,
  streaming: StreamingHandle,
): void {
  if (event.delta?.partial_json === undefined || event.index === undefined) return;
  const pending = state.pendingToolCalls.get(event.index);
  if (!pending) return;
  pending.partialJson += event.delta.partial_json;
  if (pending.blockId !== undefined) {
    streaming.report?.({
      type: 'stream:tool-call-delta',
      toolName: pending.name,
      blockId: pending.blockId,
      partialArguments: pending.partialJson,
    });
  }
}

function completeAnthropicToolCalls(
  pendingCalls: Map<number, PendingToolCall>,
  aborted: boolean | undefined,
): ToolCallInput[] {
  if (aborted) return [];
  return [...pendingCalls.values()].map((pending) => ({
    id: pending.id,
    name: pending.name,
    arguments: parseAnthropicToolArguments(pending),
  }));
}

function buildStreamUsage(state: StreamState): GenerateResponse['usage'] {
  if (state.inputTokens === undefined && state.outputTokens === undefined) return undefined;
  return {
    prompt: state.inputTokens ?? 0,
    completion: state.outputTokens ?? 0,
    total: (state.inputTokens ?? 0) + (state.outputTokens ?? 0),
    ...(state.cacheCreationTokens != null
      ? { cacheCreationTokens: state.cacheCreationTokens }
      : {}),
    ...(state.cacheReadTokens != null ? { cacheReadTokens: state.cacheReadTokens } : {}),
  };
}

function parseAnthropicToolArguments(pending: PendingToolCall): unknown {
  if (!pending.partialJson) return undefined;
  try {
    return JSON.parse(pending.partialJson) as unknown;
  } catch (cause) {
    throw new ToolCallParseError({
      provider: 'anthropic',
      toolName: pending.name,
      toolCallId: pending.id,
      rawArguments: pending.partialJson,
      cause,
    });
  }
}
