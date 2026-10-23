/**
 * One run's tool calls, read from the chat thread the run belongs to. The Bureau names the rows of
 * a run's steps `<runId>:step:<n>`, and the result of a call `<row>:result:<callId>`, so the rows
 * of this run are the ones that begin with its identifier. A thread is AG-UI messages: an
 * assistant row carries `toolCalls`, and a `tool` row carries the call's result, with its outcome
 * in the `conversationalist:toolResult` metadata.
 */
import { z } from 'zod';

import { resultSummary } from '../../../lib/tool-text.ts';
import type { ToolCallEntry, ToolCallState } from '../../chat/tool-activity.ts';

const toolCallSchema = z.object({
  id: z.string(),
  function: z.object({ name: z.string(), arguments: z.string().optional() }),
});
const assistantSchema = z.object({
  id: z.string(),
  role: z.literal('assistant'),
  toolCalls: z.array(toolCallSchema).optional(),
});
const toolSchema = z.object({
  id: z.string(),
  role: z.literal('tool'),
  toolCallId: z.string(),
  metadata: z
    .object({
      'conversationalist:toolResult': z
        .object({
          outcome: z.enum(['success', 'error', 'action_required']),
          content: z.unknown().optional(),
          error: z.object({ message: z.string().optional() }).optional(),
        })
        .optional(),
    })
    .optional(),
});

function parseArguments(text: string | undefined): unknown {
  if (text === undefined || text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** The calls the run `runId` made, in order, each with where it stands. */
export function toolCallsOfRun(runId: string, messages: readonly unknown[]): ToolCallEntry[] {
  const results = new Map<string, z.infer<typeof toolSchema>>();
  for (const message of messages) {
    const parsed = toolSchema.safeParse(message);
    if (parsed.success && parsed.data.id.startsWith(`${runId}:`)) {
      results.set(parsed.data.toolCallId, parsed.data);
    }
  }
  const entries: ToolCallEntry[] = [];
  for (const message of messages) {
    const parsed = assistantSchema.safeParse(message);
    if (!parsed.success || !parsed.data.id.startsWith(`${runId}:`)) continue;
    for (const call of parsed.data.toolCalls ?? []) {
      const result = results.get(call.id)?.metadata?.['conversationalist:toolResult'];
      const state: ToolCallState =
        result === undefined
          ? 'running'
          : result.outcome === 'action_required'
            ? 'needs-you'
            : result.outcome === 'error'
              ? 'failed'
              : 'done';
      entries.push({
        callId: call.id,
        name: call.function.name,
        arguments: parseArguments(call.function.arguments),
        state,
        summary:
          state === 'failed'
            ? (result?.error?.message ?? resultSummary(result?.content))
            : state === 'done'
              ? resultSummary(result?.content)
              : '',
        result: result?.content,
      });
    }
  }
  return entries;
}
