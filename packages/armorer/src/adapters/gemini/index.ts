import type { SerializedToolDefinition } from '../../core/serialization';
import type { AnyToolDefinition } from '../../core/tool-definition';
import type { ImportedToolConfiguration } from '../../toolbox-type-inference';
import { isAsyncIterable } from '../../type-guards';
import type { ToolCallInput, ToolResultLike } from '../../types';
import { importToolSchema } from '../imported-schema';
import { toProviderToolName } from '../provider-tool-names';
import { normalizeToSerializedDefinitions, type ToolRegistryLike } from '../shared';
import { geminiToolResultParts, toolResultParts } from '../tool-result-parts';
import type {
  GeminiFunctionDeclaration,
  GeminiFunctionResponsePart,
  GeminiPart,
  GeminiResponsePart,
  GeminiSchema,
  GeminiTool,
} from './types';

export type {
  GeminiFileDataPart,
  GeminiFunctionCallPart,
  GeminiFunctionDeclaration,
  GeminiFunctionResponsePart,
  GeminiInlineDataPart,
  GeminiPart,
  GeminiResponsePart,
  GeminiSchema,
  GeminiTextPart,
  GeminiTool,
} from './types';

// `GeminiPart` keeps a part literal such as `{ text }` free of excess-property
// errors; `GeminiResponsePart` admits the SDK's all-optional `Part`.
type GeminiResponseParts = readonly (GeminiPart | GeminiResponsePart)[] | undefined | null;

type GeminiToolCallSource =
  | readonly (GeminiPart | GeminiResponsePart)[]
  | { parts?: GeminiResponseParts }
  | { content?: { parts?: GeminiResponseParts } | undefined | null }
  | { contents?: ReadonlyArray<{ parts?: GeminiResponseParts }> | undefined }
  | undefined
  | null;

export interface GeminiFormatToolResultsOptions {
  /**
   * The function name to echo for a call id. A name found here wins over the result's own
   * `toolName`, so tools exported with `naming: 'safe-id'` can answer under the encoded name
   * Gemini was given (a result carries only the bare tool name).
   */
  toolNameByCallId?: Record<string, string> | ((callId: string) => string | undefined);
  defaultToolName?: string;
}

/** Options for {@link toGeminiTools}. */
export interface GeminiAdapterOptions {
  /**
   * Strategy for naming tools in Gemini format.
   * - 'default': Use the tool name (identity.name).
   * - 'safe-id': Use the tool ID (`namespace:name@version`) encoded as a legal provider name,
   *   which keeps same-named tools from different namespaces apart. Pass
   *   `createProviderToolNameMapper(tools)` to `parseGeminiToolCalls` to map a call back to the id.
   */
  naming?: 'default' | 'safe-id';
}

/**
 * Converts Toolbox tools to Google Gemini API format.
 *
 * @example
 * ```ts
 * import { GoogleGenAI } from '@google/genai';
 * import { toGeminiTools } from 'armorer';
 *
 * const client = new GoogleGenAI({ apiKey });
 * const response = await client.models.generateContent({
 *   model: 'gemini-pro',
 *   contents,
 *   config: { tools: toGeminiTools(toolbox) },
 * });
 * ```
 */
export function toGeminiTools(
  input:
    | SerializedToolDefinition
    | AnyToolDefinition
    | readonly (SerializedToolDefinition | AnyToolDefinition)[]
    | ToolRegistryLike,
  options?: GeminiAdapterOptions,
): GeminiTool[] {
  const definitions = normalizeToSerializedDefinitions(input);
  const converted = definitions.map((definition) =>
    convertToGeminiFunctionDeclaration(definition, options),
  );

  return converted.length === 0 ? [] : [{ functionDeclarations: converted }];
}

export function fromGeminiTools(
  input:
    | GeminiFunctionDeclaration
    | readonly GeminiFunctionDeclaration[]
    | GeminiTool
    | readonly GeminiTool[],
): ImportedToolConfiguration[] {
  const declarations = normalizeGeminiDeclarations(input);
  return declarations.map(convertFromGeminiDeclaration);
}

/**
 * Parses `functionCall` parts into tool calls, keeping the id Gemini issued (Gemini 3 always sends
 * one; earlier models may send none, and execution then generates it). The formatters echo that id
 * as `functionResponse.id` with no further wiring, so two calls to one function pair correctly.
 */
export function parseGeminiToolCalls(
  parts: GeminiToolCallSource,
  mapName?: (name: string) => string,
): ToolCallInput[] {
  const resolvedParts = extractGeminiParts(parts);
  if (!resolvedParts || !Array.isArray(resolvedParts)) {
    return [];
  }

  return resolvedParts.flatMap((part) => {
    const functionCall = 'functionCall' in part ? part.functionCall : undefined;
    return typeof functionCall?.name === 'string'
      ? [convertFunctionCall({ ...functionCall, name: functionCall.name }, mapName)]
      : [];
  });
}

export function formatGeminiToolResults(
  results: ToolResultLike | ToolResultLike[],
  options: GeminiFormatToolResultsOptions = {},
): GeminiFunctionResponsePart[] {
  const resultList = Array.isArray(results) ? results : [results];

  for (const result of resultList) {
    if (getStreamingPayload(result)) {
      throw new Error(
        'formatGeminiToolResults does not support streaming results. Persist or collect the stream before formatting Gemini tool results.',
      );
    }
  }

  return resultList.map((result) => toFunctionResponsePart(result, options));
}

export async function formatGeminiToolResultsAsync(
  results: ToolResultLike | ToolResultLike[],
  options: GeminiFormatToolResultsOptions = {},
): Promise<GeminiFunctionResponsePart[]> {
  const resultList = Array.isArray(results) ? results : [results];
  return Promise.all(
    resultList.map(async (result) => {
      const stream = getStreamingPayload(result) ?? null;
      // A settled result, parts included, formats exactly as the synchronous formatter does.
      if (stream === null) return toFunctionResponsePart(result, options);
      const content = normalizeAsyncContent(await collectAsyncIterable(stream));
      return {
        functionResponse: {
          ...geminiResponseId(result),
          name: resolveGeminiToolName(result, options),
          response: normalizeGeminiResponse({ ...result, content }),
        },
      };
    }),
  );
}

export const geminiToolAdapter = {
  export: toGeminiTools,
  import: fromGeminiTools,
  parseCalls: parseGeminiToolCalls,
  formatResults: formatGeminiToolResults,
  formatResultsAsync: formatGeminiToolResultsAsync,
} as const;

function convertToGeminiFunctionDeclaration(
  tool: SerializedToolDefinition,
  options?: GeminiAdapterOptions,
): GeminiFunctionDeclaration {
  return {
    name: options?.naming === 'safe-id' ? toProviderToolName(tool.id) : tool.identity.name,
    description: tool.display.description,
    parameters: transformToGeminiSchema(tool.input),
  };
}

function convertFromGeminiDeclaration(
  declaration: GeminiFunctionDeclaration,
): ImportedToolConfiguration {
  return {
    name: declaration.name,
    description: declaration.description,
    input: importToolSchema(declaration.parameters),
  };
}

/**
 * Transforms JSON Schema to Gemini-compatible schema format.
 * Gemini uses OpenAPI 3.0 style schemas.
 */
function transformToGeminiSchema(schema: Record<string, unknown>): GeminiSchema {
  // Remove $schema if present to keep Gemini schema clean.
  const { $schema, ...rest } = schema;

  return rest;
}

function convertFunctionCall(
  functionCall: NonNullable<GeminiResponsePart['functionCall']> & { name: string },
  mapName: ((name: string) => string) | undefined,
): ToolCallInput {
  return {
    ...(typeof functionCall.id === 'string'
      ? { id: functionCall.id, providerCallId: functionCall.id }
      : {}),
    name: mapName ? mapName(functionCall.name) : functionCall.name,
    arguments: functionCall.args ?? {},
  };
}

function toFunctionResponsePart(
  result: ToolResultLike,
  options: GeminiFormatToolResultsOptions,
): GeminiFunctionResponsePart {
  const name = resolveGeminiToolName(result, options);
  const id = geminiResponseId(result);
  const parts = toolResultParts(result);
  if (parts === undefined) {
    return { functionResponse: { ...id, name, response: normalizeGeminiResponse(result) } };
  }
  const { output, parts: media } = geminiToolResultParts(parts);
  const response =
    result.outcome === 'success'
      ? { output }
      : {
          output,
          outcome: result.outcome,
          ...(result.error ? { error: result.error } : {}),
          ...(result.action ? { action: result.action } : {}),
        };
  return { functionResponse: { ...id, name, response, parts: media } };
}

/** The `id` field to echo: the provider-issued id the result carries, never an Armorer-generated one. */
function geminiResponseId(result: ToolResultLike): { id: string } | Record<never, never> {
  const issued = result.providerCallId;
  return typeof issued === 'string' && issued.length > 0 ? { id: issued } : {};
}

function normalizeGeminiResponse(result: ToolResultLike): Record<string, unknown> {
  if (result.outcome === 'success') {
    return normalizeGeminiPayload(result.content);
  }

  return {
    outcome: result.outcome,
    content: result.content,
    ...(result.error ? { error: result.error } : {}),
    ...(result.action ? { action: result.action } : {}),
  };
}

function extractGeminiParts(input: GeminiToolCallSource): GeminiResponseParts {
  if (!input) {
    return input;
  }
  if (Array.isArray(input)) {
    return input;
  }
  if ('parts' in input) {
    return input.parts;
  }
  if ('content' in input) {
    return input.content?.parts;
  }
  if ('contents' in input) {
    return input.contents?.flatMap((content) => content.parts ?? []);
  }
  return undefined;
}

function resolveGeminiToolName(
  result: ToolResultLike,
  options: GeminiFormatToolResultsOptions,
): string {
  const mapping = options.toolNameByCallId;
  const mapped =
    typeof mapping === 'function'
      ? mapping(result.callId)
      : mapping && typeof mapping === 'object' && Object.hasOwn(mapping, result.callId)
        ? mapping[result.callId]
        : undefined;
  if (mapped !== undefined) return mapped;
  if ('toolName' in result) return result.toolName;
  return options.defaultToolName ?? 'unknown';
}

function getStreamingPayload(result: ToolResultLike): AsyncIterable<unknown> | undefined {
  if ('stream' in result && isAsyncIterable(result.stream)) {
    return result.stream;
  }
  if ('result' in result && isAsyncIterable(result.result)) {
    return result.result;
  }
  return undefined;
}

function normalizeAsyncContent(chunks: unknown[]): ToolResultLike['content'] {
  if (
    chunks.every(
      (chunk) =>
        chunk === null ||
        ['string', 'number', 'boolean'].includes(typeof chunk) ||
        Array.isArray(chunk) ||
        typeof chunk === 'object',
    )
  ) {
    return chunks;
  }
  return chunks.map((chunk) => String(chunk));
}

async function collectAsyncIterable(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const chunks: unknown[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

function normalizeGeminiDeclarations(
  input:
    | GeminiFunctionDeclaration
    | readonly GeminiFunctionDeclaration[]
    | GeminiTool
    | readonly GeminiTool[],
): GeminiFunctionDeclaration[] {
  if (Array.isArray(input)) {
    return input.flatMap((value) =>
      isGeminiTool(value) ? [...value.functionDeclarations] : [value as GeminiFunctionDeclaration],
    );
  }

  if (isGeminiTool(input)) {
    return [...input.functionDeclarations];
  }

  return [input as GeminiFunctionDeclaration];
}

function normalizeGeminiPayload(content: unknown): Record<string, unknown> {
  if (content !== null && typeof content === 'object' && !Array.isArray(content)) {
    return content as Record<string, unknown>;
  }

  return { result: content };
}

function isGeminiTool(value: unknown): value is GeminiTool {
  return (
    value !== null &&
    typeof value === 'object' &&
    'functionDeclarations' in value &&
    Array.isArray((value as GeminiTool).functionDeclarations)
  );
}
