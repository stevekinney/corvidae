import { isMediaContent, type MediaContent, type MultiModalContent } from '../../multi-modal';
import { isStreamingMessage } from '../../streaming';
import type { Message, ToolCall, ToolResult } from '../../types';
import { getOwn } from '../../utilities/type-helpers';
import {
  createMediaExportContext,
  effectiveSource,
  recordLineage,
  rejectPart,
  toBase64Payload,
  type MediaExportContext,
} from '../media';
import type {
  GeminiContent,
  GeminiFunctionCallPart,
  GeminiFunctionResponsePart,
  GeminiPart,
} from './types';

const MIME_TYPE_BY_EXTENSION: Record<string, string> = {
  bmp: 'image/bmp',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
};

function inferMimeType(url: string): string | undefined {
  const trimmed = url.split('#')[0]?.split('?')[0] ?? '';
  const dotIndex = trimmed.lastIndexOf('.');
  if (dotIndex === -1) {
    return undefined;
  }
  const extension = trimmed.slice(dotIndex + 1).toLowerCase();
  return getOwn(MIME_TYPE_BY_EXTENSION, extension);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeGeminiResponse(toolResult: ToolResult): Record<string, unknown> {
  if (toolResult.outcome === 'success') {
    if (toolResult.content !== null && typeof toolResult.content === 'object') {
      return Array.isArray(toolResult.content)
        ? { result: toolResult.content }
        : Object.fromEntries(Object.entries(toolResult.content));
    }

    return { result: toolResult.content };
  }

  return {
    outcome: toolResult.outcome,
    content: toolResult.content,
    ...(toolResult.error ? { error: toolResult.error } : {}),
    ...(toolResult.action ? { action: toolResult.action } : {}),
  };
}

/**
 * Converts internal multi-modal content to Gemini parts. A media part the
 * context's role cannot carry (system instructions) is rejected, never dropped.
 */
export function toGeminiParts(
  content: string | ReadonlyArray<MultiModalContent>,
  context: MediaExportContext,
): GeminiPart[] {
  if (typeof content === 'string') {
    return content ? [{ text: content }] : [];
  }

  const parts: GeminiPart[] = [];
  content.forEach((part, partIndex) => {
    if (part.type === 'text') {
      if (part.text) parts.push({ text: part.text });
      return;
    }
    if (isMediaContent(part)) {
      if (context.role === 'system' || context.role === 'developer') {
        rejectPart(context, partIndex, part, 'role-not-accepted');
      }
      parts.push(toGeminiMediaPart(part, partIndex, context));
      return;
    }
    // `container_upload` is an upload reference with no Gemini wire form.
    if (part.type === 'container_upload') {
      rejectPart(context, partIndex, part, 'part-type-not-accepted');
    }
    // Thinking, server-tool, and tool-result blocks are Anthropic-private
    // replay data, not user input; they stay out of a Gemini request.
  });

  return parts;
}

function toGeminiMediaPart(
  part: MediaContent,
  partIndex: number,
  context: MediaExportContext,
): GeminiPart {
  if (part.type === 'file') {
    return rejectPart(context, partIndex, part, 'modality-not-accepted', part.source.kind);
  }
  const effective = effectiveSource(context, partIndex, part);
  const { source } = effective;
  if (source.kind === 'remote-url' || source.kind === 'provider-file') {
    const uri = source.kind === 'remote-url' ? source.url : source.providerFileId;
    if (source.kind === 'provider-file' && source.provider !== 'gemini') {
      return rejectPart(context, partIndex, part, 'source-form-not-accepted', source.kind);
    }
    const mimeType = effective.mimeType ?? inferMimeType(uri);
    if (mimeType === undefined) {
      return rejectPart(context, partIndex, part, 'mime-type-required', source.kind);
    }
    recordLineage(
      context,
      partIndex,
      part,
      effective,
      source.kind === 'remote-url'
        ? { to: 'remote-url', transform: 'remote-url-delegated' }
        : {
            to: 'provider-file',
            transform: 'provider-file-reference',
            providerFileId: source.providerFileId,
          },
    );
    return { fileData: { mimeType, fileUri: uri } };
  }
  const payload = toBase64Payload(source);
  if (payload === undefined) {
    return rejectPart(context, partIndex, part, 'source-form-not-accepted', source.kind);
  }
  const mimeType = effective.mimeType;
  if (mimeType === undefined) {
    return rejectPart(context, partIndex, part, 'mime-type-required', source.kind);
  }
  recordLineage(context, partIndex, part, effective, {
    to: 'inline',
    transform: payload.kind === 'data-url' ? 'data-url-split' : 'inline-base64',
  });
  return { inlineData: { mimeType, data: payload.data } };
}

/**
 * Converts an internal ToolCall to Gemini functionCall part. Pass `geminiId`
 * only when Gemini issued it.
 */
export function toFunctionCallPart(toolCall: ToolCall, geminiId?: string): GeminiFunctionCallPart {
  let args: Record<string, unknown>;

  if (typeof toolCall.arguments === 'string') {
    try {
      const parsed = JSON.parse(toolCall.arguments) as unknown;
      if (isRecord(parsed)) {
        args = parsed;
      } else {
        args = { _value: parsed };
      }
    } catch {
      args = { _raw: toolCall.arguments };
    }
  } else if (
    toolCall.arguments &&
    typeof toolCall.arguments === 'object' &&
    !Array.isArray(toolCall.arguments)
  ) {
    args = Object.fromEntries(Object.entries(toolCall.arguments));
  } else {
    args = { _value: toolCall.arguments };
  }

  return {
    functionCall: {
      ...(geminiId !== undefined ? { id: geminiId } : {}),
      name: toolCall.name,
      args,
    },
  };
}

/**
 * A function response for a result that carries parts. Gemini takes media in
 * `functionResponse.parts` as inline bytes, and text only in `response`, so
 * `response.output` keeps the parts' order: each text part as its string, and
 * each media part as `{ $ref: displayName }`, the reference form the Gemini
 * API documents for naming a `FunctionResponsePart` from the response
 * (https://ai.google.dev/gemini-api/docs/generate-content/function-calling,
 * checked 2026-10-22).
 */
function toMultimodalFunctionResponsePart(
  toolResult: ToolResult,
  parts: NonNullable<ToolResult['parts']>,
  functionName: string,
  context: MediaExportContext,
  geminiId?: string,
): GeminiFunctionResponsePart {
  const media: Array<{ inlineData: { mimeType: string; data: string; displayName: string } }> = [];
  const output = parts.map((part, partIndex) => {
    if (part.type === 'text') return part.text;
    const converted = toGeminiMediaPart(part, partIndex, context);
    if (!('inlineData' in converted)) {
      // The Gemini API does not accept URI-based data in a function response.
      return rejectPart(context, partIndex, part, 'source-form-not-accepted', part.source.kind);
    }
    const displayName = `part-${partIndex}`;
    media.push({ inlineData: { ...converted.inlineData, displayName } });
    return { $ref: displayName };
  });
  // A non-success result keeps its outcome beside the parts, as the canonical payload does.
  const response =
    toolResult.outcome === 'success'
      ? { output }
      : {
          output,
          outcome: toolResult.outcome,
          ...(toolResult.error ? { error: toolResult.error } : {}),
          ...(toolResult.action ? { action: toolResult.action } : {}),
        };
  return {
    functionResponse: {
      ...(geminiId !== undefined ? { id: geminiId } : {}),
      name: functionName,
      response,
      parts: media,
    },
  };
}

/**
 * Converts an internal ToolResult to Gemini functionResponse part.
 * Note: Gemini needs the function name, which we track via a map from the conversation.
 */
export function toFunctionResponsePart(
  toolResult: ToolResult,
  functionName: string,
  context?: MediaExportContext,
  geminiId?: string,
): GeminiFunctionResponsePart {
  if (toolResult.parts !== undefined) {
    return toMultimodalFunctionResponsePart(
      toolResult,
      toolResult.parts,
      functionName,
      context ??
        createMediaExportContext(
          'gemini',
          { id: toolResult.callId, role: 'tool-result' },
          [],
          undefined,
        ),
      geminiId,
    );
  }
  return {
    functionResponse: {
      ...(geminiId !== undefined ? { id: geminiId } : {}),
      name: functionName,
      response: normalizeGeminiResponse(toolResult),
    },
  };
}

/**
 * Collects system message content from a conversation for Gemini's systemInstruction.
 */
export function extractSystemInstruction(
  messages: ReadonlyArray<Message>,
): GeminiContent | undefined {
  const systemMessages = messages.filter(
    (m) => (m.role === 'system' || m.role === 'developer') && !m.hidden && !isStreamingMessage(m),
  );

  if (systemMessages.length === 0) {
    return undefined;
  }

  const parts: GeminiPart[] = [];
  for (const msg of systemMessages) {
    parts.push(
      ...toGeminiParts(msg.content, createMediaExportContext('gemini', msg, [], undefined)),
    );
  }

  if (parts.length === 0) {
    return undefined;
  }

  return {
    role: 'user', // systemInstruction uses 'user' role in Gemini
    parts,
  };
}
