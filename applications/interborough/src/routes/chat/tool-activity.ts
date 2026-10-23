/**
 * The tool calls of a transcript as a person reads them. A step of a run that calls a tool is one
 * row of the conversation, and a turn that calls several has a row for each, back to back. They
 * are shown as one group: a line saying how many tools were used and how many need a decision,
 * which opens to a row per call. A call that needs a decision is never inside the fold.
 */
import {
  pairToolCallsWithResults,
  type ConversationHistory,
  type ToolCallPair,
} from '@lostgradient/chat';

import { resultSummary } from '../../lib/tool-text.ts';

/** Where one call stands. */
export type ToolCallState = 'running' | 'needs-you' | 'done' | 'failed';

export type ToolCallEntry = {
  /** The tool call's identifier, which an approval names. */
  readonly callId: string;
  readonly name: string;
  readonly arguments: unknown;
  readonly state: ToolCallState;
  /** One line about the answer, empty while there is none. */
  readonly summary: string;
  /** The answer, for the details. */
  readonly result: unknown;
};

/** The calls of one turn's run of tool rows, and the rows of the conversation they came from. */
export type ToolGroup = {
  readonly entries: readonly ToolCallEntry[];
  readonly messageIds: readonly string[];
};

/** Where a call stands, from its result: none yet is still running, and a parked one needs a person. */
export function toolCallState(pair: ToolCallPair): ToolCallState {
  const outcome = pair.result?.outcome;
  if (outcome === undefined) return 'running';
  if (outcome === 'action_required') return 'needs-you';
  return outcome === 'error' ? 'failed' : 'done';
}

function entryOf(pair: ToolCallPair): ToolCallEntry {
  const state = toolCallState(pair);
  const failure = pair.result?.error?.message;
  return {
    callId: pair.call.id,
    name: pair.call.name,
    arguments: pair.call.arguments,
    state,
    summary:
      state === 'needs-you' || state === 'running'
        ? ''
        : state === 'failed'
          ? (failure ?? resultSummary(pair.result?.content))
          : resultSummary(pair.result?.content),
    result: pair.result?.content,
  };
}

/** What a group's line says: how many tools, and how many of them need a decision or failed. */
export function groupSummary(entries: readonly ToolCallEntry[]): string {
  const needing = entries.filter((entry) => entry.state === 'needs-you').length;
  const failed = entries.filter((entry) => entry.state === 'failed').length;
  const used = `Used ${String(entries.length)} ${entries.length === 1 ? 'tool' : 'tools'}`;
  if (needing > 0) return `${used} · ${String(needing)} ${needing === 1 ? 'needs' : 'need'} you`;
  if (failed > 0) return `${used} · ${String(failed)} failed`;
  return used;
}

/**
 * The groups of a conversation: each by the id of its first row, which renders the group, and the
 * ids of the later rows, which render nothing. A row that is hidden, or that only carries a result,
 * does not break a run of tool rows.
 */
export function toolGroups(conversation: ConversationHistory): {
  readonly groups: ReadonlyMap<string, ToolGroup>;
  readonly absorbed: ReadonlySet<string>;
} {
  const pairs = new Map(
    pairToolCallsWithResults(conversation.ids.flatMap((id) => conversation.messages[id] ?? [])).map(
      (pair) => [pair.call.id, pair] as const,
    ),
  );
  const groups = new Map<string, ToolGroup>();
  const absorbed = new Set<string>();
  let current: { ids: string[]; entries: ToolCallEntry[] } | undefined;
  const close = (): void => {
    const first = current?.ids[0];
    if (current !== undefined && first !== undefined) {
      groups.set(first, { entries: current.entries, messageIds: current.ids });
      for (const id of current.ids.slice(1)) absorbed.add(id);
    }
    current = undefined;
  };
  for (const id of conversation.ids) {
    const message = conversation.messages[id];
    if (message === undefined || message.hidden) continue;
    if (message.toolResult !== undefined) continue;
    const call = message.toolCall;
    if (call === undefined) {
      close();
      continue;
    }
    const pair = pairs.get(call.id) ?? { call };
    current ??= { ids: [], entries: [] };
    current.ids.push(id);
    current.entries.push(entryOf(pair));
  }
  close();
  return { groups, absorbed };
}
