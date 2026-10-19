import { createStreamingAccumulator, finalizeBlockState, type JSONValue } from 'conversationalist';

import type { PartDelta, StreamBlock, StreamEvent, StreamState } from '../../streaming/types';
import { anthropicOpeningState } from '../anthropic-blocks';
import { ProviderContractError } from '../errors';
import type { AnthropicStreamEvent } from '../types';
import type { NormalizerState } from './stream-helpers';
import { buildState, findBlock } from './stream-helpers';

/**
 * Normalizes an Anthropic Messages API streaming response into a
 * provider-agnostic AsyncIterable of StreamEvents.
 *
 * Consumes `content_block_start`, `content_block_delta`, `content_block_stop`,
 * `message_start`, `message_delta`, and `message_stop` events and produces
 * the unified streaming pipeline events.
 */
export async function* normalizeAnthropicStream(
  stream: AsyncIterable<AnthropicStreamEvent>,
  options: { readonly messageId?: string } = {},
): AsyncIterable<StreamEvent> {
  const messageId = options.messageId ?? 'message';
  /** Accumulates content blocks, so each part completes with the signature and citations it earned. */
  const accumulator = createStreamingAccumulator();
  /** Provider block index to part index; client `tool_use` blocks are not parts. */
  const partIndexes = new Map<number, number>();
  const sequences = new Map<number, number>();
  let nextPartIndex = 0;
  /**
   * An unlisted block or delta is refused once, as a `stream:error`, and the stream ends there:
   * nothing follows an error, not even `stream:complete`.
   */
  let refused = false;
  const refuse = (blockType: string, position: number): StreamEvent | undefined => {
    if (refused) return undefined;
    refused = true;
    return {
      type: 'stream:error',
      error: new ProviderContractError({
        provider: 'anthropic',
        reason: 'unlisted-block',
        blockType,
        partIndex: position,
        usage: undefined,
      }),
    };
  };
  const partDelta = (providerIndex: number, delta: PartDelta): StreamEvent | undefined => {
    const partIndex = partIndexes.get(providerIndex);
    if (partIndex === undefined) return undefined;
    const sequence = (sequences.get(partIndex) ?? 0) + 1;
    sequences.set(partIndex, sequence);
    return { type: 'stream:part-delta', messageId, partIndex, sequence, delta };
  };
  const state: NormalizerState = {
    blocks: [],
    hasUsageData: false,
    promptTokens: undefined,
    completionTokens: undefined,
  };
  const { blocks } = state;
  /** Map from Anthropic index → our block id */
  const indexToBlockId = new Map<number, string>();
  /** Map from block id → tool name for tool-call blocks */
  const blockToolNames = new Map<string, string>();
  /** Accumulated text for stream:text-delta events */
  let accumulatedText = '';
  /** Whether stream:complete has already been emitted via message_stop */
  let completionEmitted = false;

  for await (const event of stream) {
    switch (event.type) {
      case 'message_start': {
        if (event.message?.usage) {
          state.hasUsageData = true;
          state.promptTokens = event.message.usage.input_tokens ?? 0;
          state.completionTokens = event.message.usage.output_tokens ?? 0;
          yield {
            type: 'stream:usage',
            usage: {
              prompt: state.promptTokens,
              completion: state.completionTokens,
              total: state.promptTokens + state.completionTokens,
            },
          };
        }
        break;
      }

      case 'content_block_start': {
        const index = event.index ?? blocks.length;
        const contentBlock = event.content_block;
        const blockId = contentBlock?.id ?? `block-${index}`;
        const rawType = contentBlock?.type ?? 'text';

        let blockType: StreamBlock['type'] = 'text';
        if (rawType === 'tool_use') blockType = 'tool-call';
        else if (rawType === 'thinking') blockType = 'thinking';
        else if (rawType !== 'text') blockType = 'metadata';

        const toolName = contentBlock?.name;

        const block: StreamBlock = {
          id: blockId,
          type: blockType,
          index: blocks.length,
          content: '',
          complete: false,
          toolName,
          partialArguments: blockType === 'tool-call' ? '' : undefined,
        };

        blocks.push(block);
        indexToBlockId.set(index, blockId);
        if (toolName) blockToolNames.set(blockId, toolName);

        yield { type: 'stream:block-start', block: { ...block } };

        if (blockType === 'tool-call' && toolName) {
          yield { type: 'stream:tool-call-start', toolName, blockId };
        }

        if (rawType !== 'tool_use' && contentBlock !== undefined) {
          const opening = anthropicOpeningState(contentBlock);
          if (opening === undefined) {
            const refusal = refuse(rawType, index);
            if (refusal) {
              yield refusal;
              return;
            }
          } else {
            accumulator.openBlock(index, opening);
            // A text block takes its part index with its first non-empty text; an empty one is
            // not a part (the mapping table skips it), and leaves no hole in the indexes.
            if (opening.type !== 'text') {
              const partIndex = nextPartIndex++;
              partIndexes.set(index, partIndex);
              yield {
                type: 'stream:part-start',
                messageId,
                partIndex,
                kind: opening.type === 'tool_use' ? 'text' : opening.type,
              };
            } else if (opening.buffer !== '') {
              const partIndex = nextPartIndex++;
              partIndexes.set(index, partIndex);
              yield { type: 'stream:part-start', messageId, partIndex, kind: 'text' };
              const emitted = partDelta(index, { kind: 'text', text: opening.buffer });
              if (emitted) yield emitted;
            }
          }
        }
        break;
      }

      case 'content_block_delta': {
        const index = event.index ?? 0;
        const blockId = indexToBlockId.get(index);
        if (!blockId) break;

        const block = findBlock(blocks, blockId);
        if (!block) break;

        const deltaType = event.delta?.type;
        const textDelta = event.delta?.text;
        const jsonDelta = event.delta?.partial_json;

        const partBlock = accumulator.getBlock(index);
        if (deltaType === 'text_delta' && textDelta) {
          partBlock?.appendTextDelta(textDelta);
          if (partBlock !== undefined && !partIndexes.has(index)) {
            const partIndex = nextPartIndex++;
            partIndexes.set(index, partIndex);
            yield { type: 'stream:part-start', messageId, partIndex, kind: 'text' };
          }
          const emitted = partDelta(index, { kind: 'text', text: textDelta });
          if (emitted) yield emitted;
          block.content += textDelta;
          accumulatedText += textDelta;

          yield {
            type: 'stream:block-delta',
            block: { ...block },
            delta: textDelta,
          };
          yield {
            type: 'stream:text-delta',
            content: textDelta,
            accumulated: accumulatedText,
          };
        } else if (deltaType === 'input_json_delta' && jsonDelta) {
          if (partBlock !== undefined) {
            partBlock.appendInputJsonDelta(jsonDelta);
            const emitted = partDelta(index, { kind: 'input-json', partialJson: jsonDelta });
            if (emitted) yield emitted;
          }
          block.content += jsonDelta;
          block.partialArguments = (block.partialArguments ?? '') + jsonDelta;

          const toolName = blockToolNames.get(blockId) ?? '';

          yield {
            type: 'stream:block-delta',
            block: { ...block },
            delta: jsonDelta,
          };
          yield {
            type: 'stream:tool-call-delta',
            toolName,
            blockId,
            partialArguments: block.partialArguments,
          };
        } else if (deltaType === 'input_json_delta') {
          // Anthropic opens every tool_use block with an empty `partial_json`: ordinary, not output.
        } else if (deltaType === 'signature_delta') {
          // Replay data: the completed part carries the whole signature, no live event.
          partBlock?.appendSignatureDelta(event.delta?.signature ?? '');
        } else if (deltaType === 'citations_delta') {
          partBlock?.appendCitationsDelta(event.delta?.citation as JSONValue);
          const emitted = partDelta(index, {
            kind: 'citation',
            citation: event.delta?.citation as JSONValue,
          });
          if (emitted) yield emitted;
        } else if (deltaType === 'thinking_delta') {
          const thinkingDelta = event.delta?.thinking ?? event.delta?.text ?? '';
          if (thinkingDelta) {
            partBlock?.appendThinkingDelta(thinkingDelta);
            const emitted = partDelta(index, { kind: 'thinking', thinking: thinkingDelta });
            if (emitted) yield emitted;
            block.content += thinkingDelta;

            yield {
              type: 'stream:block-delta',
              block: { ...block },
              delta: thinkingDelta,
            };
          }
        } else if (deltaType !== undefined && deltaType !== 'text_delta') {
          const refusal = refuse(deltaType, index);
          if (refusal) {
            yield refusal;
            return;
          }
        }
        break;
      }

      case 'content_block_stop': {
        const index = event.index ?? 0;
        const blockId = indexToBlockId.get(index);
        if (!blockId) break;

        const block = findBlock(blocks, blockId);
        if (!block) break;

        block.complete = true;

        yield { type: 'stream:block-complete', block: { ...block } };

        const stoppedPart = partIndexes.has(index)
          ? finalizeBlockState(accumulator.getBlock(index)!.state)
          : undefined;
        if (stoppedPart !== undefined) {
          yield {
            type: 'stream:part-complete',
            messageId,
            partIndex: partIndexes.get(index)!,
            part: stoppedPart as never,
          };
        }

        if (block.type === 'tool-call') {
          const toolName = blockToolNames.get(blockId) ?? '';
          const args = block.partialArguments ?? '';
          let parsedArgs: unknown = args;
          try {
            parsedArgs = JSON.parse(args);
          } catch {
            // Keep as string if not valid JSON
          }
          yield {
            type: 'stream:tool-call-complete',
            toolName,
            blockId,
            arguments: parsedArgs,
          };
        }
        break;
      }

      case 'message_delta': {
        if (event.usage?.output_tokens !== undefined) {
          state.hasUsageData = true;
          state.completionTokens = event.usage.output_tokens;
          yield {
            type: 'stream:usage',
            usage: {
              prompt: state.promptTokens ?? 0,
              completion: state.completionTokens,
              total: (state.promptTokens ?? 0) + state.completionTokens,
            },
          };
        }
        break;
      }

      case 'message_stop': {
        completionEmitted = true;
        const finalState: StreamState = {
          ...buildState(state),
          complete: true,
        };
        yield { type: 'stream:complete', state: finalState };
        break;
      }
    }
  }

  // A stream that ended before a block it opened had stopped was cut off: it fails typed and
  // nothing follows the error, instead of completing with a half block dropped.
  const unfinished = refused ? undefined : blocks.find((block) => !block.complete);
  if (unfinished !== undefined) {
    yield {
      type: 'stream:error',
      error: new ProviderContractError({
        provider: 'anthropic',
        reason: 'truncated-stream',
        blockType: unfinished.type,
        partIndex: unfinished.index,
        usage: undefined,
      }),
    };
    return;
  }

  // Guarantee stream:complete is always emitted, even if the stream was
  // truncated without a message_stop event (e.g., clean network close).
  if (!completionEmitted) {
    const finalState: StreamState = {
      ...buildState(state),
      complete: true,
    };
    yield { type: 'stream:complete', state: finalState };
  }
}
