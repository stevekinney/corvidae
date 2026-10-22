import { appendMessages, createConversationHistory } from '../../conversation/index';
import type { MultiModalContent } from '../../multi-modal';
import type {
  ConversationHistory as Conversation,
  JSONValue,
  MessageInput,
  ToolResult,
} from '../../types';
import { createMediaPart, modalityFromMimeType, parseDataUrl, sourceFromUrl } from '../media';
import {
  fromCanonicalToolResultPayload,
  isCanonicalToolResultPayload,
  parseJSONValue,
  parseToolResultText,
} from '../shared';
import type { OpenAIContentPart, OpenAIMessage, OpenAITextContentPart } from './types';

function toConversationContent(
  content: string | OpenAIContentPart[] | OpenAITextContentPart[] | null,
): MessageInput['content'] | undefined {
  if (content === null) {
    return undefined;
  }

  if (typeof content === 'string') {
    return content;
  }

  const parts: MultiModalContent[] = content.map(toConversationPart);

  if (parts.length === 0) {
    return '';
  }

  if (parts.length === 1 && parts[0]?.type === 'text') {
    return parts[0].text ?? '';
  }

  return parts;
}

function toConversationPart(part: OpenAIContentPart): MultiModalContent {
  if (part.type === 'text') return { type: 'text', text: part.text };
  if (part.type === 'image_url') return createMediaPart('image', sourceFromUrl(part.image_url.url));
  const { file_data: fileData, file_id: fileId, filename } = part.file;
  const name = filename === undefined ? {} : { name: filename };
  if (fileId !== undefined) {
    return createMediaPart(
      'document',
      { kind: 'provider-file', provider: 'openai', providerFileId: fileId },
      name,
    );
  }
  const parsed = fileData === undefined ? undefined : parseDataUrl(fileData);
  if (fileData === undefined || parsed === undefined) {
    throw new TypeError('OpenAI file content part carries neither a file_id nor a base64 data URL');
  }
  return createMediaPart(
    modalityFromMimeType(parsed.mimeType) === 'document' ? 'document' : 'file',
    sourceFromUrl(fileData),
    { ...name, ...(parsed.mimeType !== undefined ? { mimeType: parsed.mimeType } : {}) },
  );
}

function parseToolArguments(value: string): JSONValue {
  return parseJSONValue(value) ?? value;
}

function parseToolResult(callId: string, content: string | OpenAITextContentPart[]): ToolResult {
  if (typeof content !== 'string') {
    const withParts = parseOutcomeWithParts(callId, content);
    if (withParts !== undefined) return withParts;
  }
  const serialized =
    typeof content === 'string' ? content : content.map((part) => part.text).join('\n\n');
  return parseToolResultText(callId, serialized);
}

/**
 * The inverse of how a non-success result with parts is exported: a leading text part holding
 * the canonical outcome payload (with `content: null`), then the parts' text.
 */
function parseOutcomeWithParts(
  callId: string,
  content: OpenAITextContentPart[],
): ToolResult | undefined {
  const [lead, ...rest] = content;
  if (lead === undefined || rest.length === 0) return undefined;
  const parsed = parseJSONValue(lead.text);
  if (parsed === undefined || !isCanonicalToolResultPayload(parsed)) return undefined;
  if (parsed.outcome === 'success' || parsed.content !== null) return undefined;
  return {
    ...fromCanonicalToolResultPayload(callId, parsed),
    parts: rest.map((part) => ({ type: 'text', text: part.text })),
  };
}

function toMessageInputs(messages: ReadonlyArray<OpenAIMessage>): MessageInput[] {
  const inputs: MessageInput[] = [];

  for (const message of messages) {
    inputs.push(...toMessageInput(message));
  }

  return inputs;
}

function toMessageInput(message: OpenAIMessage): MessageInput[] {
  switch (message.role) {
    case 'system':
    case 'user':
      return [
        {
          role: message.role,
          content: toConversationContent(message.content) ?? '',
        },
      ];

    case 'assistant':
      return toAssistantInputs(message);

    case 'tool':
      return [
        {
          role: 'tool-result',
          content: '',
          toolResult: parseToolResult(message.tool_call_id, message.content),
        },
      ];
    default:
      return [];
  }
}

function toAssistantInputs(message: Extract<OpenAIMessage, { role: 'assistant' }>): MessageInput[] {
  const inputs: MessageInput[] = [];
  const assistantContent = toConversationContent(message.content);
  const hasAssistantContent = assistantContent !== undefined && assistantContent.length > 0;

  if (hasAssistantContent) {
    inputs.push({
      role: 'assistant',
      content: assistantContent,
    });
  }

  for (const toolCall of message.tool_calls ?? []) {
    inputs.push({
      role: 'tool-call',
      content: '',
      toolCall: {
        id: toolCall.id,
        name: toolCall.function.name,
        arguments: parseToolArguments(toolCall.function.arguments),
      },
    });
  }

  return inputs;
}

/**
 * Converts OpenAI Chat Completions API messages back into a ConversationHistory.
 */
export function fromOpenAIMessages(messages: ReadonlyArray<OpenAIMessage>): Conversation {
  let conversation = createConversationHistory();
  const inputs = toMessageInputs(messages);

  if (inputs.length > 0) {
    conversation = appendMessages(conversation, ...inputs);
  }

  return conversation;
}

export function appendOpenAIMessages(
  conversation: Conversation,
  messages: ReadonlyArray<OpenAIMessage>,
): Conversation {
  const inputs = toMessageInputs(messages);
  if (inputs.length === 0) {
    return conversation;
  }
  return appendMessages(conversation, ...inputs);
}
