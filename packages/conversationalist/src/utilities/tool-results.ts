import type { ToolResult } from '../types';

/**
 * Returns a shallow copy of a tool result.
 */
export function copyToolResult(toolResult: ToolResult): ToolResult {
  return { ...toolResult };
}

/**
 * Redacts tool result payload fields while preserving the original shape. The payload is
 * `content` and, when present, `parts`: both are replaced by the placeholder, so no text or
 * media part survives redaction.
 */
export function redactToolResult(toolResult: ToolResult, placeholder: string): ToolResult {
  const { parts: _parts, ...rest } = toolResult;
  return { ...rest, content: placeholder };
}
