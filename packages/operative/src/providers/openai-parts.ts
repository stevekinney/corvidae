import type { JSONValue, MultiModalContent } from 'conversationalist';

import { ProviderContractError } from './errors.ts';
import type { GenerateResponse } from './types.ts';

/** Message fields the OpenAI Chat Completions mapping table lists. Anything else is an extension. */
const KNOWN_MESSAGE_FIELDS: ReadonlySet<string> = new Set([
  'content',
  'role',
  'tool_calls',
  'refusal',
  'annotations',
  'audio',
  'function_call',
]);

/** Fields whose presence is output the adapter cannot map; the request never asks for either. */
const UNMAPPED_MESSAGE_FIELDS = ['audio', 'function_call'] as const;

export interface OpenAIMessageMapping {
  readonly parts: MultiModalContent[];
  /** The refusal, annotations and unmodeled fields the message carried; `undefined` when none. */
  readonly metadata: Record<string, JSONValue> | undefined;
}

function jsonSafe(value: unknown): JSONValue | undefined {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? undefined : (JSON.parse(serialized) as JSONValue);
  } catch {
    return undefined;
  }
}

/**
 * Maps one OpenAI assistant message (a whole completion's, or a stream's accumulation of deltas) to
 * ordered parts and metadata. Every field lands somewhere or fails loudly:
 *
 * - `content` becomes one text part (none when empty or `null`); tool calls are the caller's.
 * - `refusal` and `annotations` are model output that used to vanish; they go to `metadata`.
 *   Annotations are not text-part `citations`: that field is Anthropic's replay format, and it
 *   would be replayed to Anthropic on a fallover.
 * - `audio` and `function_call` throw a {@link ProviderContractError}: audio output is unadvertised
 *   and the factory never asks for it, and the deprecated function call has no mapping.
 * - A field the SDK does not declare (`reasoning_content` on DeepSeek, Groq, LM Studio, and others
 *   `baseURL` documents) is kept in `metadata.providerExtensions` when it is JSON-safe.
 */
export function mapOpenAIMessage(
  message: Record<string, unknown>,
  usage: GenerateResponse['usage'],
): OpenAIMessageMapping {
  for (const field of UNMAPPED_MESSAGE_FIELDS) {
    const value = message[field];
    if (value !== undefined && value !== null) {
      throw new ProviderContractError({
        provider: 'openai',
        reason: 'unlisted-block',
        blockType: field,
        partIndex: 0,
        usage,
      });
    }
  }

  const parts: MultiModalContent[] = [];
  const content = message['content'];
  if (typeof content === 'string' && content !== '') parts.push({ type: 'text', text: content });

  const metadata: Record<string, JSONValue> = {};
  const refusal = message['refusal'];
  if (typeof refusal === 'string' && refusal !== '') metadata['refusal'] = refusal;
  const annotations = message['annotations'];
  if (annotations !== undefined && annotations !== null) {
    const safe = jsonSafe(annotations);
    if (safe !== undefined) metadata['annotations'] = safe;
  }

  const extensions: Record<string, JSONValue> = {};
  for (const [field, value] of Object.entries(message)) {
    if (KNOWN_MESSAGE_FIELDS.has(field) || value === undefined || value === null) continue;
    const safe = jsonSafe(value);
    if (safe !== undefined) extensions[field] = safe;
  }
  if (Object.keys(extensions).length > 0) metadata['providerExtensions'] = extensions;

  return { parts, metadata: Object.keys(metadata).length > 0 ? metadata : undefined };
}
