import {
  assertToolResultParts,
  isToolContent,
  type JSONValue,
  type ToolResultPart,
} from '../protocol';

/**
 * How Armorer's provider formatters (`formatOpenAIToolResults`,
 * `formatAnthropicToolResults`, `formatGeminiToolResults`) and the OpenAI
 * Agents adapter carry a result's ordered `parts` (COR-792). A part a provider
 * cannot carry is refused with an error naming it; it is never turned into JSON
 * text and never dropped.
 */

/**
 * The parts a formatter sends: a result's `parts` (validated, since a
 * `ToolResultInput` types them loosely), or those of a `toolContent` raw value.
 */
export function toolResultParts(result: {
  readonly parts?: unknown;
  readonly result?: unknown;
}): readonly ToolResultPart[] | undefined {
  if (result.parts !== undefined) {
    assertToolResultParts(result.parts);
    return result.parts;
  }
  return isToolContent(result.result) ? result.result.parts : undefined;
}

function refuse(provider: string, part: ToolResultPart, index: number, reason: string): never {
  const kind = part.type === 'text' ? '' : ` (${part.source.kind} source)`;
  throw new Error(
    `${provider} cannot carry tool-result part ${index}, a ${part.type} part${kind}: ${reason}.`,
  );
}

/** Text parts as one string, in order; a media part is refused. */
export function textOfToolResultParts(provider: string, parts: readonly ToolResultPart[]): string {
  return parts
    .map((part, index) =>
      part.type === 'text'
        ? part.text
        : refuse(provider, part, index, 'its tool results carry text only'),
    )
    .join('\n\n');
}

/** An Anthropic `tool_result` content block a part becomes. */
export type AnthropicToolResultContentBlock =
  | { type: 'text'; text: string; citations?: JSONValue }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string } };

/** Text, inline base64 images, and inline base64 PDFs as Anthropic blocks; anything else refused. */
export function anthropicToolResultBlocks(
  parts: readonly ToolResultPart[],
): AnthropicToolResultContentBlock[] {
  return parts.map((part, index): AnthropicToolResultContentBlock => {
    if (part.type === 'text') {
      return {
        type: 'text',
        text: part.text,
        ...(part.citations !== undefined ? { citations: part.citations } : {}),
      };
    }
    const { source } = part;
    if (source.kind !== 'inline' || source.encoding !== 'base64' || part.mimeType === undefined) {
      return refuse('Anthropic', part, index, 'only inline base64 media with a MIME type is sent');
    }
    if (part.type === 'image') {
      return {
        type: 'image',
        source: { type: 'base64', media_type: part.mimeType, data: source.data },
      };
    }
    if (part.type === 'document' && part.mimeType === 'application/pdf') {
      return {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: source.data },
      };
    }
    return refuse('Anthropic', part, index, 'a tool_result holds text, images, and PDFs only');
  });
}

/**
 * A Gemini function response for parts: media as inline `parts` named by
 * `displayName`, and `output` listing every part in order, a text part as its
 * string and a media part as `{ $ref: displayName }`.
 */
export function geminiToolResultParts(parts: readonly ToolResultPart[]): {
  output: Array<string | { $ref: string }>;
  parts: Array<{ inlineData: { mimeType: string; data: string; displayName: string } }>;
} {
  const media: Array<{ inlineData: { mimeType: string; data: string; displayName: string } }> = [];
  const output = parts.map((part, index) => {
    if (part.type === 'text') return part.text;
    const { source } = part;
    if (source.kind !== 'inline' || source.encoding !== 'base64' || part.mimeType === undefined) {
      return refuse('Gemini', part, index, 'only inline base64 media with a MIME type is sent');
    }
    const displayName = `part-${index}`;
    media.push({ inlineData: { mimeType: part.mimeType, data: source.data, displayName } });
    return { $ref: displayName };
  });
  return { output, parts: media };
}
