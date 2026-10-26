import type { ToolResult } from 'conversationalist';

import { stringify } from './stringify.ts';

type ToolResultParts = NonNullable<ToolResult['parts']>;

/**
 * One part of a tool result as text: a text part as itself, and a media part as a bracketed
 * label naming its type, name (or alt text), and media type. Never its bytes, URL, or path: a tool
 * chooses those, and showing the model's tool output must not load or reveal them.
 */
export function describeToolResultPart(part: ToolResultParts[number]): string {
  if (part.type === 'text') return part.text;
  const label = part.name ?? part.alt;
  const detail = [label, part.mimeType].filter((value) => value !== undefined && value !== '');
  return detail.length === 0 ? `[${part.type}]` : `[${part.type}: ${detail.join(', ')}]`;
}

/**
 * The text a tool result shows (COR-1634): its ordered parts, one blank line apart, when it has
 * them (`content` is then only the structured value beside them), and otherwise its `content`.
 */
export function toolResultText(result: ToolResult): string {
  if (result.parts === undefined) return stringify(result.content);
  return result.parts.map(describeToolResultPart).join('\n\n');
}
