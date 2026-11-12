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

import { CHAT_COPY } from '../../app/copy/chat.ts';
import { resultSummary } from '../../lib/tool-text.ts';
import { workflowTypePath } from '../../lib/workflow-type-paths.ts';
import {
  continuesAfterDecision,
  decidedLine,
  type DecisionContext,
} from './approval-decision-words.ts';
import { opensTurn } from './event-notes.ts';

/** One row of a conversation. */
type Message = ConversationHistory['messages'][string];

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
  /** Where the answer goes, when it is a page: the workflow a Create workflow call made. */
  readonly resultHref?: string | undefined;
  /** The answer, for the details. */
  readonly result: unknown;
  /**
   * Why a failed call failed, as the tool reported it: what went wrong, its machine code, and
   * whether trying again can work. Absent for a call that did not fail, and for a failure that
   * carries no error.
   */
  readonly failure?: ToolFailure | undefined;
  /**
   * How long the call ran, in milliseconds: from its start to its end as the Bureau recorded them,
   * so far for a call still running, and to when the run stopped for an interrupted one. Absent
   * when nothing recorded says (a call that waits on a person, or one whose start is not known).
   */
  readonly durationMilliseconds?: number | undefined;
  /**
   * How a person decided the call's approval, when the Bureau recorded it on the call's outcome:
   * who, when, and the note they left. Absent for a call that never asked, and for one decided
   * before the Bureau recorded decisions.
   */
  readonly decision?: ApprovalDecision | undefined;
};

/** Why a call failed: the tool's own error. */
export type ToolFailure = {
  readonly message: string;
  readonly code?: string | undefined;
  readonly retryable?: boolean | undefined;
};

/** How a person decided a tool approval, as the Bureau wrote it on the call's outcome row. */
export type ApprovalDecision = {
  /** Approved, or refused (a rejection is a refusal that carries a reason). */
  readonly outcome: 'approved' | 'denied';
  /** The principal that decided, as the Bureau recorded it: the chat's owner when it was you. */
  readonly decidedBy: string;
  /** When it was decided, in epoch milliseconds. */
  readonly decidedAt: number;
  /** The note left with the decision, which the agent read as the reason for a refusal. */
  readonly reason?: string | undefined;
  /** The sentence the tool asked with, which the outcome replaced along with the waiting row. */
  readonly asked?: string | undefined;
  /**
   * Where the person decided, as the Bureau recorded it with the decision (COR-2292): `chat` or
   * `reviews`. Absent when the decision did not say, as every decision recorded before it could.
   */
  readonly decisionSurface?: 'chat' | 'reviews' | undefined;
};

/** Where a `tool-result` row keeps when its call ran: Operative's `TOOL_TIMING_METADATA_KEY`. */
export const TOOL_TIMING_METADATA_KEY = 'toolTiming';

/**
 * What a call's duration is read against, every time on the Bureau's clock in epoch milliseconds,
 * never the page's: the Bureau's time now (for a call still running), when each call the page
 * watched start started, and when the run the transcript ends on stopped.
 */
export type ToolTimingContext = {
  /** The Bureau's time now (`bureau-clock.ts`). */
  readonly now: number;
  /**
   * When each call the page watched begin started, from its `TOOL_CALL_START`. A call read from
   * the stored thread has its row's recorded time instead.
   */
  readonly callStarts?: ReadonlyMap<string, number> | undefined;
  /**
   * When each call the page watched answer answered, from its `TOOL_CALL_RESULT`: the row the
   * page wrote for the answer carries the page's time until the run's snapshot replaces it.
   */
  readonly callEnds?: ReadonlyMap<string, number> | undefined;
  /** When the last run stopped, for a call it left without an answer; absent while unknown. */
  readonly stoppedAt?: number | undefined;
};

/** A time as epoch milliseconds, or `undefined` for one that is not a date. */
function epochOf(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** The start and end a result row records for its call, under {@link TOOL_TIMING_METADATA_KEY}. */
export function recordedTiming(
  metadata: Readonly<Record<string, unknown>> | undefined,
): { readonly startedAt: number; readonly endedAt: number } | undefined {
  const value = metadata?.[TOOL_TIMING_METADATA_KEY];
  if (typeof value !== 'object' || value === null) return undefined;
  const start = epochOf(Reflect.get(value, 'startedAt'));
  const end = epochOf(Reflect.get(value, 'endedAt'));
  return start === undefined || end === undefined || end < start
    ? undefined
    : { startedAt: start, endedAt: end };
}

/** Where a `tool-result` row keeps how its approval was decided: Bureau's `APPROVAL_DECISION_METADATA_KEY`. */
export const APPROVAL_DECISION_METADATA_KEY = 'approvalDecision';

/** How a person decided the approval, as a result row records it under {@link APPROVAL_DECISION_METADATA_KEY}. */
export function recordedDecision(
  metadata: Readonly<Record<string, unknown>> | undefined,
): ApprovalDecision | undefined {
  const value = metadata?.[APPROVAL_DECISION_METADATA_KEY];
  if (typeof value !== 'object' || value === null) return undefined;
  const decision: unknown = Reflect.get(value, 'decision');
  const decidedBy: unknown = Reflect.get(value, 'decidedBy');
  const decidedAt = epochOf(Reflect.get(value, 'decidedAt'));
  const reason: unknown = Reflect.get(value, 'reason');
  const asked: unknown = Reflect.get(value, 'asked');
  const decisionSurface: unknown = Reflect.get(value, 'decisionSurface');
  if (
    (decision !== 'approve' && decision !== 'deny' && decision !== 'reject') ||
    typeof decidedBy !== 'string' ||
    decidedAt === undefined
  ) {
    return undefined;
  }
  return {
    outcome: decision === 'approve' ? 'approved' : 'denied',
    decidedBy,
    decidedAt,
    ...(typeof reason === 'string' && reason.trim() !== '' ? { reason } : {}),
    ...(typeof asked === 'string' && asked.trim() !== '' ? { asked } : {}),
    // Only the two surfaces the Bureau records count; anything else reads as unknown.
    ...(decisionSurface === 'chat' || decisionSurface === 'reviews' ? { decisionSurface } : {}),
  };
}

/** The rows a call's times are read from: its own row, and its result's when it has one. */
type CallRows = {
  readonly call: Message;
  readonly result?: Message | undefined;
};

/**
 * When a call ran, from the times the Bureau recorded: the result row's start and end. A call
 * whose answer records none counts from its start (the Bureau's time on its `TOOL_CALL_START`, else
 * its row's recorded time) to its answer (the Bureau's time on its `TOOL_CALL_RESULT`, else the
 * answer row's), to the Bureau's now while it runs, or to the run's stop once it was interrupted.
 * A call a person denied never ran, so it has times only when they were recorded, and a call that
 * waits on a person has none.
 */
function intervalOf(
  state: ToolCallState,
  rows: CallRows,
  timing: ToolTimingContext | undefined,
): { readonly start: number; readonly end: number } | undefined {
  if (timing === undefined || state === 'needs-you') return undefined;
  const recorded = recordedTiming(rows.result?.metadata);
  if (recorded !== undefined) return { start: recorded.startedAt, end: recorded.endedAt };
  if (state === 'denied') return undefined;
  const callId = rows.call.toolCall?.id ?? '';
  const start = timing.callStarts?.get(callId) ?? epochOf(rows.call.createdAt);
  if (start === undefined) return undefined;
  const end =
    state === 'running'
      ? timing.now
      : state === 'interrupted'
        ? timing.stoppedAt
        : (timing.callEnds?.get(callId) ?? epochOf(rows.result?.createdAt));
  return end === undefined ? undefined : { start, end: Math.max(start, end) };
}

/** How long a call ran, in milliseconds, from the times {@link intervalOf} reads; absent when none. */
function durationOf(
  state: ToolCallState,
  rows: CallRows,
  timing: ToolTimingContext | undefined,
): number | undefined {
  const interval = intervalOf(state, rows, timing);
  return interval === undefined ? undefined : interval.end - interval.start;
}

/**
 * How long a turn spent on its tools, in milliseconds: the time at least one call was under way,
 * so calls that ran together count once and the time the turn waited on a person counts for
 * nothing. Absent when no call has recorded times, and while any call is still running (the rail's
 * summary says "so far" and shows no duration then).
 */
function turnDuration(
  intervals: readonly ({ readonly start: number; readonly end: number } | undefined)[],
  entries: readonly ToolCallEntry[],
): number | undefined {
  if (entries.some((entry) => entry.state === 'running')) return undefined;
  const known = intervals
    .filter((interval) => interval !== undefined)
    .toSorted((left, right) => left.start - right.start);
  if (known.length === 0) return undefined;
  let total = 0;
  let reach = -Infinity;
  for (const { start, end } of known) {
    total += Math.max(0, end - Math.max(start, reach));
    reach = Math.max(reach, end);
  }
  return total;
}

/** A call's duration as the rail prints it: `0.4s`, `12s`, `1m 5s`. */
export function formatCallDuration(milliseconds: number): string {
  if (milliseconds < 10_000) return `${(Math.max(0, milliseconds) / 1000).toFixed(1)}s`;
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** The calls of one turn's run of tool rows, and the rows of the conversation they came from. */
export type ToolGroup = {
  readonly entries: readonly ToolCallEntry[];
  readonly messageIds: readonly string[];
  /**
   * How long the turn spent on its tools, in milliseconds (the time at least one call was under
   * way); absent while a call is running and when no call recorded its times.
   */
  readonly durationMilliseconds?: number | undefined;
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

/**
 * What the catalog says of each tool, by the name a call carries. The catalog names a namespaced
 * tool `bureau:workflows-create`, and a model calls it by the form a provider takes, `bureau__workflows-create`,
 * so a tool is listed under both.
 */
export function toolInfoByName(
  tools: readonly {
    readonly name: string;
    readonly title: string | null;
    readonly tier: ToolInfo['tier'];
  }[],
): ReadonlyMap<string, ToolInfo> {
  const info = new Map<string, ToolInfo>();
  for (const tool of tools) {
    const entry = { title: tool.title, tier: tool.tier };
    info.set(tool.name, entry);
    info.set(tool.name.replaceAll(':', '__'), entry);
  }
  return info;
}

/** A tool's identifier as a person reads it when the catalog gives no title: "lookup-order" is "Lookup order". */
export function toolDisplayName(identifier: string, title?: string | null): string {
  if (title !== undefined && title !== null && title.trim() !== '') return title;
  const words = identifier.replaceAll(/[-_]+/g, ' ').trim();
  return words === '' ? identifier : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/** The Bureau's tool that creates a workflow, as a call names it (`bureau:workflows-create` in the catalog). */
const CREATE_WORKFLOW_CALL = 'bureau__workflows-create';

/**
 * The workflow a finished Create workflow call made: what it was called, which is what the row
 * says came back, and the address of its page. A call that did not create one (it was refused, or
 * the file already existed) points nowhere.
 */
export function createdWorkflow(
  name: string,
  args: unknown,
  result: unknown,
): { readonly title: string; readonly href: string } | undefined {
  if (name !== CREATE_WORKFLOW_CALL || typeof result !== 'object' || result === null) {
    return undefined;
  }
  const { status, id } = result as { status?: unknown; id?: unknown };
  if (status !== 'ok' || typeof id !== 'string' || id === '') return undefined;
  const called =
    typeof args === 'object' && args !== null ? (args as { name?: unknown }).name : undefined;
  return {
    title: typeof called === 'string' && called.trim() !== '' ? called.trim() : id,
    href: workflowTypePath(id),
  };
}

function entryOf(
  pair: ToolCallPair,
  runActive: boolean,
  tools: ReadonlyMap<string, ToolInfo>,
  rows?: CallRows,
  timing?: ToolTimingContext,
): ToolCallEntry {
  const state = toolCallState(pair, runActive);
  const failure = pair.result?.error?.message;
  const error = pair.result?.error;
  const info = tools.get(pair.call.name);
  const durationMilliseconds = rows === undefined ? undefined : durationOf(state, rows, timing);
  const decision = recordedDecision(rows?.result?.metadata);
  const created =
    state === 'done'
      ? createdWorkflow(pair.call.name, pair.call.arguments, pair.result?.content)
      : undefined;
  return {
    ...(durationMilliseconds === undefined ? {} : { durationMilliseconds }),
    ...(decision === undefined ? {} : { decision }),
    callId: pair.call.id,
    name: pair.call.name,
    title: toolDisplayName(pair.call.name, info?.title),
    tier: info?.tier,
    input: keyInput(pair.call.arguments),
    arguments: pair.call.arguments,
    state,
    ...(created === undefined ? {} : { resultHref: created.href }),
    summary:
      created !== undefined
        ? created.title
        : state === 'needs-you' || state === 'running' || state === 'interrupted'
          ? ''
          : state === 'denied'
            ? (refusalReason(pair) ?? '')
            : state === 'failed'
              ? (failure ?? resultSummary(pair.result?.content))
              : resultSummary(pair.result?.content),
    result: pair.result?.content,
    ...(state === 'failed' && error !== undefined
      ? {
          failure: {
            message: error.message,
            ...(error.code === '' ? {} : { code: error.code }),
            retryable: error.retryable,
          },
        }
      : {}),
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

/**
 * One call as a row of the rail. A call whose approval a person decided says so in their words
 * ("Approved by you 10:33 AM, $18.50 refunded", "Denied by you 10:40 AM"), which `context` words:
 * who the person is to this chat, and which decisions were made away from it.
 */
export function railCall(
  entry: ToolCallEntry,
  nested: boolean,
  context: DecisionContext = {},
): ToolCallRailCall {
  const decided = decidedLine(entry, context);
  const named = {
    id: entry.callId,
    name: entry.title ?? entry.name,
    identifier: entry.name,
    ...(entry.input === undefined || entry.input === '' ? {} : { input: entry.input }),
    nested,
    ...(entry.durationMilliseconds === undefined
      ? {}
      : { duration: formatCallDuration(entry.durationMilliseconds) }),
  };
  switch (entry.state) {
    case 'running':
      return { ...named, status: 'running' };
    case 'needs-you':
      return { ...named, status: 'waiting' };
    case 'interrupted':
      return { ...named, status: 'interrupted', result: interruptedWords(entry) };
    case 'denied':
      return {
        ...named,
        status: 'denied',
        result: entry.summary || CHAT_COPY.tools.denied,
        ...(decided === undefined ? {} : { decision: decided }),
      };
    case 'failed':
      return {
        ...named,
        status: 'failed',
        ...(entry.summary === '' ? {} : { result: entry.summary }),
      };
    case 'done':
      // A call whose answer is a page keeps its answer on the row, as a link, so a person's
      // approval of it is told in the approval under the row and not in place of the answer.
      if (entry.resultHref !== undefined) {
        return {
          ...named,
          status: entry.decision?.outcome === 'approved' ? 'approved' : 'done',
          ...(entry.summary === '' ? {} : { result: entry.summary }),
          resultHref: entry.resultHref,
        };
      }
      // A call decided in Reviews whose continuing run is going reads as that run (design row
      // 18i): the spinner, the decision with "running…" as its words, and no duration of its own.
      if (decided !== undefined && continuesAfterDecision(entry, context)) {
        const { duration: _finished, ...going } = named;
        return { ...going, status: 'running', result: decided };
      }
      return decided !== undefined && entry.decision?.outcome === 'approved'
        ? { ...named, status: 'approved', decision: decided }
        : {
            ...named,
            status: 'done',
            ...(entry.summary === '' ? {} : { result: entry.summary }),
          };
  }
}

/** The index of the row that opens the turn `index` is in: 0 when no row before it opens one. */
export function turnStart(conversation: ConversationHistory, index: number): number {
  for (let at = index; at >= 0; at -= 1) {
    if (opensTurn(conversation.messages[conversation.ids[at] ?? ''])) return at;
  }
  return 0;
}

/** The index of the row that opens the last turn: 0 when no row opens one. */
export function lastTurnStart(conversation: ConversationHistory): number {
  return turnStart(conversation, conversation.ids.length - 1);
}

/**
 * The groups of a conversation: each by the id of its first row, which renders the group, and the
 * ids of the later rows, which render nothing. A row that is hidden, or that only carries a result,
 * does not break a run of tool rows. A call of an earlier turn with no answer was interrupted, even
 * while a run is going: Retry keeps a failed attempt on record (B06, row 20b), and the run going is
 * the new turn's, which is not working on it.
 */
export function toolGroups(
  conversation: ConversationHistory,
  options: {
    readonly runActive?: boolean;
    readonly tools?: ReadonlyMap<string, ToolInfo>;
    /** What each call's duration is read against; without it no call has one. */
    readonly timing?: ToolTimingContext | undefined;
  } = {},
): {
  readonly groups: ReadonlyMap<string, ToolGroup>;
  readonly absorbed: ReadonlySet<string>;
} {
  const pairs = new Map(
    pairToolCallsWithResults(conversation.ids.flatMap((id) => conversation.messages[id] ?? [])).map(
      (pair) => [pair.call.id, pair] as const,
    ),
  );
  // Each call's answer row, which records when the call ran.
  const resultRows = new Map<string, Message>();
  for (const id of conversation.ids) {
    const row = conversation.messages[id];
    if (row?.toolResult !== undefined) resultRows.set(row.toolResult.callId, row);
  }
  const groups = new Map<string, ToolGroup>();
  const absorbed = new Set<string>();
  let current:
    | {
        ids: string[];
        entries: ToolCallEntry[];
        intervals: ({ readonly start: number; readonly end: number } | undefined)[];
      }
    | undefined;
  const close = (): void => {
    const first = current?.ids[0];
    if (current !== undefined && first !== undefined) {
      const durationMilliseconds = turnDuration(current.intervals, current.entries);
      groups.set(first, {
        entries: current.entries,
        messageIds: current.ids,
        ...(durationMilliseconds === undefined ? {} : { durationMilliseconds }),
      });
      for (const id of current.ids.slice(1)) absorbed.add(id);
    }
    current = undefined;
  };
  const lastTurn = lastTurnStart(conversation);
  for (const [index, id] of conversation.ids.entries()) {
    const message = conversation.messages[id];
    if (message === undefined || message.hidden) continue;
    if (message.toolResult !== undefined) continue;
    const call = message.toolCall;
    if (call === undefined) {
      close();
      continue;
    }
    const pair = pairs.get(call.id) ?? { call };
    current ??= { ids: [], entries: [], intervals: [] };
    current.ids.push(id);
    const rows = { call: message, result: resultRows.get(call.id) };
    const entry = entryOf(
      pair,
      index >= lastTurn && (options.runActive ?? true),
      options.tools ?? new Map(),
      rows,
      options.timing,
    );
    current.entries.push(entry);
    current.intervals.push(intervalOf(entry.state, rows, options.timing));
  }
  close();
  return { groups, absorbed };
}
