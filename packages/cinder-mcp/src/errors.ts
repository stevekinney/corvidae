import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { ComponentKnowledgeError } from './knowledge/knowledge.js';

/** JSON-safe `{ code, message, suggestions }` shape for both tool and resource error payloads. */
export function errorPayload(error: unknown): {
  code: string;
  message: string;
  suggestions: string[];
} {
  return {
    code: error instanceof ComponentKnowledgeError ? error.code : 'UNEXPECTED_ERROR',
    message: error instanceof Error ? error.message : String(error),
    suggestions: error instanceof ComponentKnowledgeError ? error.suggestions : [],
  };
}

/** Wrap a thrown error as an MCP tool result with `isError: true`. */
export function toolError(error: unknown): {
  isError: true;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: { error: ReturnType<typeof errorPayload> };
} {
  const payload = errorPayload(error);
  return {
    isError: true,
    content: [{ type: 'text' as const, text: payload.message }],
    structuredContent: { error: payload },
  };
}

/** Translate a thrown error into the MCP protocol error a resource read must throw. */
export function resourceError(error: unknown): never {
  const payload = errorPayload(error);
  const protocolCode =
    error instanceof ComponentKnowledgeError ? ErrorCode.InvalidParams : ErrorCode.InternalError;
  throw new McpError(protocolCode, payload.message, { error: payload });
}
