/**
 * The tool calls of a transcript as a person reads them. A step of a run that calls a tool is one
 * row of the conversation, and a turn that calls several has a row for each, back to back. They
 * are shown as one group: a rail with a row per call, which Cinder's tool call rail folds from
 * three calls. A call that needs a decision, failed or was interrupted is never inside the fold.
 */
import {
  pairToolCallsWithResults,
  type ConversationHistory,
  type ToolCallPair,
} from '@lostgradient/chat';

import type { ToolCallRailCall } from '@lostgradient/cinder';

import { CHAT_COPY } from '../../app/copy.ts';
import { resultSummary } from '../../lib/tool-text.ts';

/**
 * Where one call stands. `interrupted` is a call with no answer that nothing is working on any more:
 * the run ended while it was under way, so how it ended is not known.
 */
export type ToolCallState = 'running' | 'needs-you' | 'done' | 'failed' | 'denied' | 'interrupted';

/** What the tool catalog says of a tool: its name for a person, and what it may do. */
export type ToolInfo = {
  readonly title: string | null;
  readonly tier: 'read-only' | 'mutating' | 'dangerous' | null;
};

export type ToolCallEntry = {
  /** The tool call's identifier, which an approval names. */
  readonly callId: string;
  /** The tool's identifier ("lookup-order"), which is its name when the catalog gives it no title. */
  readonly name: string;
  /** The tool's name for a person ("Lookup order"), from the catalog; absent when it has none. */
  readonly title?: string | undefined;
  /** What the tool may do, from the catalog; absent when the catalog does not list the tool. */
  readonly tier?: ToolInfo['tier'] | undefined;
  /** The call's key input, the first scalar it was given ("4471"); empty when it was given none. */
  readonly input?: string | undefined;
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

/** The code this page writes on a call the person denied (`run-wiring.ts`). */
export const DENIED_CODE = 'approval-denied';

/** The message this page writes on a denial that carries no reason (`run-wiring.ts`). */
export const DEFAULT_DENIAL = 'The approval was denied.';

/** What the Bureau writes into the conversation for a denied or rejected call, with the reason after a colon. */
const BUREAU_REFUSAL = /^Tool call (?:denied|rejected)(?::\s*([\s\S]*))?$/;

/** The reason a person gave when they refused the call, empty when they gave none or it was not a refusal. */
function refusalReason(pair: ToolCallPair): string | undefined {
  const result = pair.result;
  if (result?.outcome !== 'error') return undefined;
  if (result.error?.code === DENIED_CODE) {
    // The page's own wording stands in for a refusal with no reason.
    const message = result.error.message;
    return message === DEFAULT_DENIAL ? '' : message;
  }
  const content = result.content;
  if (typeof content !== 'string') return undefined;
  const refused = BUREAU_REFUSAL.exec(content);
  return refused === null ? undefined : (refused[1] ?? '').trim();
}

/**
 * Where a call stands, from its result: none yet is still running, and a parked one needs a
 * person. A call the person refused is denied and not failed: it did what was asked of it.
 */
export function toolCallState(pair: ToolCallPair, runActive = true): ToolCallState {
  const outcome = pair.result?.outcome;
  if (outcome === undefined) return runActive ? 'running' : 'interrupted';
  if (outcome === 'action_required') return 'needs-you';
  if (outcome !== 'error') return 'done';
  return refusalReason(pair) === undefined ? 'failed' : 'denied';
}

/** The first scalar a call was given, which usually names what it acted on, on one line. */
export function keyInput(args: unknown): string {
  if (typeof args === 'string') return args.replaceAll(/\s+/g, ' ').trim();
  if (typeof args !== 'object' || args === null) return '';
  for (const value of Object.values(args)) {
    if (typeof value === 'string' && value.trim() !== '')
      return value.replaceAll(/\s+/g, ' ').trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  }
  return '';
}

/** A tool's identifier as a person reads it when the catalog gives no title: "lookup-order" is "Lookup order". */
export function toolDisplayName(identifier: string, title?: string | null): string {
  if (title !== undefined && title !== null && title.trim() !== '') return title;
  const words = identifier.replaceAll(/[-_]+/g, ' ').trim();
  return words === '' ? identifier : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

function entryOf(
  pair: ToolCallPair,
  runActive: boolean,
  tools: ReadonlyMap<string, ToolInfo>,
): ToolCallEntry {
  const state = toolCallState(pair, runActive);
  const failure = pair.result?.error?.message;
  const info = tools.get(pair.call.name);
  return {
    callId: pair.call.id,
    name: pair.call.name,
    title: toolDisplayName(pair.call.name, info?.title),
    tier: info?.tier,
    input: keyInput(pair.call.arguments),
    arguments: pair.call.arguments,
    state,
    summary:
      state === 'needs-you' || state === 'running' || state === 'interrupted'
        ? ''
        : state === 'denied'
          ? (refusalReason(pair) ?? '')
          : state === 'failed'
            ? (failure ?? resultSummary(pair.result?.content))
            : resultSummary(pair.result?.content),
    result: pair.result?.content,
  };
}

/** Whether a tool may change things: the catalog says so, or says nothing, which is treated the same way. */
export function mayChange(tier: ToolInfo['tier'] | undefined): boolean {
  return tier !== 'read-only';
}

/** The words of an interrupted call's row, keyed to what its tool may do. */
export function interruptedWords(entry: Pick<ToolCallEntry, 'tier'>): string {
  return mayChange(entry.tier)
    ? CHAT_COPY.tools.interruptedChanges
    : CHAT_COPY.tools.interruptedReads;
}

/** One call as a row of the rail. */
export function railCall(entry: ToolCallEntry, nested: boolean): ToolCallRailCall {
  const named = {
    id: entry.callId,
    name: entry.title ?? entry.name,
    identifier: entry.name,
    ...(entry.input === undefined || entry.input === '' ? {} : { input: entry.input }),
    nested,
  };
  switch (entry.state) {
    case 'running':
      return { ...named, status: 'running' };
    case 'needs-you':
      return { ...named, status: 'waiting' };
    case 'interrupted':
      return { ...named, status: 'interrupted', result: interruptedWords(entry) };
    case 'denied':
      return { ...named, status: 'denied', result: entry.summary || CHAT_COPY.tools.denied };
    case 'failed':
      return {
        ...named,
        status: 'failed',
        ...(entry.summary === '' ? {} : { result: entry.summary }),
      };
    case 'done':
      return {
        ...named,
        status: 'done',
        ...(entry.summary === '' ? {} : { result: entry.summary }),
      };
  }
}

/**
 * The groups of a conversation: each by the id of its first row, which renders the group, and the
 * ids of the later rows, which render nothing. A row that is hidden, or that only carries a result,
 * does not break a run of tool rows.
 */
export function toolGroups(
  conversation: ConversationHistory,
  options: { readonly runActive?: boolean; readonly tools?: ReadonlyMap<string, ToolInfo> } = {},
): {
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
    current.entries.push(entryOf(pair, options.runActive ?? true, options.tools ?? new Map()));
  }
  close();
  return { groups, absorbed };
}
