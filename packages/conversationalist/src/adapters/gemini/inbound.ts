import { appendMessages, createConversationHistory } from '../../conversation/index';
import { createInvalidInputError } from '../../errors';
import type {
  ContentSource,
  MediaContent,
  MultiModalContent,
  ToolResultPart,
} from '../../multi-modal';
import type {
  ConversationHistory as Conversation,
  JSONValue,
  MessageInput,
  ToolResult,
} from '../../types';
import { createMediaPart, inlineBase64Source, modalityFromMimeType, sourceFromUrl } from '../media';
import {
  fromCanonicalToolResultPayload,
  isCanonicalToolResultPayload,
  toJSONValue,
} from '../shared';
import type {
  GeminiConversation,
  GeminiFileDataPart,
  GeminiFunctionResponsePart,
  GeminiInlineDataPart,
  GeminiPart,
  GeminiTextPart,
} from './types';

function parseFunctionArguments(args: Record<string, unknown>): JSONValue {
  if (Object.keys(args).length === 1 && Object.hasOwn(args, '_value')) {
    return toJSONValue(args['_value']);
  }

  if (
    Object.keys(args).length === 1 &&
    Object.hasOwn(args, '_raw') &&
    typeof args['_raw'] === 'string'
  ) {
    return args['_raw'];
  }

  return toJSONValue(args);
}

function parseFunctionResponse(
  callId: string,
  response: Record<string, unknown>,
  media?: GeminiFunctionResponsePart['functionResponse']['parts'],
): ToolResult {
  const withParts = toPartsToolResult(callId, response, media);
  if (withParts) return withParts;
  const value = toJSONValue(response);

  const canonical = toCanonicalToolResult(callId, value);
  if (canonical) return canonical;
  const wrapped = toWrappedToolResult(callId, value);
  if (wrapped) return wrapped;

  return {
    callId,
    outcome: 'success',
    content: value,
  };
}

function isMediaReference(entry: unknown): entry is { $ref: string } {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    Object.keys(entry).length === 1 &&
    '$ref' in entry &&
    typeof entry.$ref === 'string'
  );
}

/**
 * The inverse of how a result with parts is exported (COR-1634): `response.output` lists every part
 * in order, a text part as its string and a media part as `{ $ref: displayName }`, and the media
 * itself rides in `functionResponse.parts`. A response with no media list is a plain result and is
 * left to the other readers, since `{ output: [...] }` is also an ordinary value. A `$ref` the
 * media list does not carry is refused: reading it as text would drop the media silently.
 */
function toPartsToolResult(
  callId: string,
  response: Record<string, unknown>,
  media: GeminiFunctionResponsePart['functionResponse']['parts'],
): ToolResult | undefined {
  const output = response['output'];
  if (media === undefined || !Array.isArray(output) || output.length === 0) return undefined;
  if (!output.every((entry) => typeof entry === 'string' || isMediaReference(entry))) {
    return undefined;
  }
  const byName = new Map(media.map(({ inlineData }) => [inlineData.displayName, inlineData]));
  const parts = output.map((entry: string | { $ref: string }): ToolResultPart => {
    if (typeof entry === 'string') return { type: 'text', text: entry };
    const inline = byName.get(entry.$ref);
    if (inline === undefined) {
      throw createInvalidInputError(
        `Gemini function response references media "${entry.$ref}", which its parts do not carry.`,
        { callId, reference: entry.$ref },
      );
    }
    return createMediaPart(
      modalityFromMimeType(inline.mimeType) ?? 'file',
      inlineBase64Source(inline.data),
      { mimeType: inline.mimeType },
    );
  });
  // A non-success result keeps its outcome, error and action beside the output.
  const outcome = response['outcome'];
  if (outcome === undefined || outcome === 'success') {
    return { callId, outcome: 'success', content: null, parts };
  }
  const leading = toJSONValue({
    outcome,
    content: null,
    ...(response['error'] === undefined ? {} : { error: response['error'] }),
    ...(response['action'] === undefined ? {} : { action: response['action'] }),
  });
  if (!isCanonicalToolResultPayload(leading)) return undefined;
  return { ...fromCanonicalToolResultPayload(callId, leading), parts };
}

function toCanonicalToolResult(callId: string, value: JSONValue): ToolResult | undefined {
  return isCanonicalToolResultPayload(value)
    ? fromCanonicalToolResultPayload(callId, value)
    : undefined;
}

function toWrappedToolResult(callId: string, value: JSONValue): ToolResult | undefined {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !Object.hasOwn(value, 'result')
  ) {
    return undefined;
  }
  return { callId, outcome: 'success', content: Object.values(value)[0] ?? null };
}

/**
 * A Gemini `fileUri` is a public HTTP or HTTPS URL, or a handle Gemini itself
 * issued: a Files API URI or a Cloud Storage URI (`gs://`). Only a public URL is a
 * `remote-url`; the handles are `provider-file` references, which `remote-url`
 * (http or https only) cannot represent. Any other scheme (`ftp:`, `s3:`, `file:`)
 * names nothing Gemini can read, so it is refused rather than stored as a handle.
 */
function sourceFromGeminiFileUri(fileUri: string): ContentSource {
  const isFilesApiUri = fileUri.startsWith('https://generativelanguage.googleapis.com/');
  const isCloudStorageUri = fileUri.startsWith('gs://');
  if (isFilesApiUri || isCloudStorageUri) {
    return { kind: 'provider-file', provider: 'gemini', providerFileId: fileUri };
  }
  return sourceFromUrl(fileUri);
}

function toMediaFromGeminiPart(part: GeminiInlineDataPart | GeminiFileDataPart): MediaContent {
  if ('inlineData' in part) {
    return createMediaPart(
      modalityFromMimeType(part.inlineData.mimeType) ?? 'file',
      inlineBase64Source(part.inlineData.data),
      { mimeType: part.inlineData.mimeType },
    );
  }
  return createMediaPart(
    modalityFromMimeType(part.fileData.mimeType) ?? 'file',
    sourceFromGeminiFileUri(part.fileData.fileUri),
    { mimeType: part.fileData.mimeType },
  );
}

function toContentFromGeminiPart(
  part: GeminiTextPart | GeminiInlineDataPart | GeminiFileDataPart,
): MessageInput['content'] {
  if ('text' in part) {
    return part.text;
  }

  return [toMediaFromGeminiPart(part)];
}

function toSystemInstructionContent(parts: GeminiPart[]): MessageInput['content'] | undefined {
  const contentParts: MultiModalContent[] = [];

  for (const part of parts) {
    if ('text' in part) {
      contentParts.push({ type: 'text', text: part.text });
    } else if ('inlineData' in part || 'fileData' in part) {
      contentParts.push(toMediaFromGeminiPart(part));
    }
  }

  if (contentParts.length === 0) {
    return undefined;
  }

  if (contentParts.length === 1 && contentParts[0]?.type === 'text') {
    return contentParts[0].text ?? '';
  }

  return contentParts;
}

function toMessageInputs(payload: GeminiConversation): MessageInput[] {
  const inputs: MessageInput[] = [];
  let syntheticToolCallCount = 0;
  const pendingToolCalls = new Map<string, string[]>();
  // Gemini-issued function-call id -> internal call id, to pair a response by id.
  const callIdByGeminiId = new Map<string, string>();

  const queueToolCall = (name: string, callId: string) => {
    const queued = pendingToolCalls.get(name) ?? [];
    queued.push(callId);
    pendingToolCalls.set(name, queued);
  };

  const dequeueToolCall = (name: string): string | undefined => {
    const queued = pendingToolCalls.get(name);
    if (!queued || queued.length === 0) {
      return undefined;
    }
    const [callId, ...rest] = queued;
    if (rest.length === 0) {
      pendingToolCalls.delete(name);
    } else {
      pendingToolCalls.set(name, rest);
    }
    return callId;
  };

  // Pairs by the Gemini-issued id when the response carries one, and removes
  // the call from its name queue so a later same-name response skips it.
  const takeToolCallById = (id: string | undefined, name: string): string | undefined => {
    const callId = id === undefined ? undefined : callIdByGeminiId.get(id);
    if (callId === undefined) return undefined;
    const queued = pendingToolCalls.get(name);
    const index = queued?.indexOf(callId) ?? -1;
    if (queued && index !== -1) queued.splice(index, 1);
    return callId;
  };

  const systemContent = payload.systemInstruction
    ? toSystemInstructionContent(payload.systemInstruction.parts)
    : undefined;
  if (systemContent !== undefined) {
    inputs.push({
      role: 'system',
      content: systemContent,
    });
  }

  for (const content of payload.contents) {
    const role = content.role === 'model' ? 'assistant' : 'user';

    for (const part of content.parts) {
      if ('functionCall' in part) {
        const callId = `gemini-call-${++syntheticToolCallCount}`;
        queueToolCall(part.functionCall.name, callId);
        const issuedId =
          typeof part.functionCall.id === 'string' && part.functionCall.id !== ''
            ? part.functionCall.id
            : undefined;
        if (issuedId !== undefined) callIdByGeminiId.set(issuedId, callId);
        inputs.push({
          role: 'tool-call',
          content: '',
          toolCall: {
            id: callId,
            name: part.functionCall.name,
            arguments: parseFunctionArguments(part.functionCall.args),
            ...(issuedId !== undefined ? { providerCallId: issuedId } : {}),
          },
        });
        continue;
      }

      if ('functionResponse' in part) {
        const callId =
          takeToolCallById(part.functionResponse.id, part.functionResponse.name) ??
          dequeueToolCall(part.functionResponse.name) ??
          `gemini-call-${++syntheticToolCallCount}`;
        inputs.push({
          role: 'tool-result',
          content: '',
          toolResult: parseFunctionResponse(
            callId,
            part.functionResponse.response,
            part.functionResponse.parts,
          ),
        });
        continue;
      }

      inputs.push({
        role,
        content: toContentFromGeminiPart(part),
      });
    }
  }

  return inputs;
}

/**
 * Converts Gemini SDK contents back into a ConversationHistory.
 */
export function fromGeminiMessages(payload: GeminiConversation): Conversation {
  let conversation = createConversationHistory();
  const inputs = toMessageInputs(payload);

  if (inputs.length > 0) {
    conversation = appendMessages(conversation, ...inputs);
  }

  return conversation;
}

export function appendGeminiMessages(
  conversation: Conversation,
  payload: GeminiConversation,
): Conversation {
  const inputs = toMessageInputs(payload);
  if (inputs.length === 0) {
    return conversation;
  }
  return appendMessages(conversation, ...inputs);
}
