/**
 * Runes helper for chat message grouping and tool call pairing.
 *
 * Extracts derived values for:
 * - Messages grouped with date separators
 * - Tool call pairs indexed by call ID for O(1) lookup
 */

import type { Message, ToolCallPair } from '../conversation-model.ts';
import { toolEndedTurnAnchor } from '../message/turn-outcome.ts';
import {
  CINDER_ARTIFACT_METADATA_KEY,
  CINDER_NOTES_METADATA_KEY,
  CINDER_REASONING_METADATA_KEY,
  CINDER_STEPS_METADATA_KEY,
  CINDER_SUGGESTIONS_METADATA_KEY,
  pairToolCallsWithResults,
} from '../utilities/index.ts';
import { classifyAssistantText } from '../utilities/message-narration.ts';

// ==========================================================================
// Types
// ==========================================================================

/** Date separator item in the message list */
export type DateItem = {
  type: 'date';
  date: Date;
};

/** Message item in the message list */
export type MessageItem = {
  type: 'message';
  message: Message;
};

/** Union type for items in the messages-with-dates list */
export type MessageWithDateItem = DateItem | MessageItem;

export type UnreadDividerItem = {
  type: 'unread-divider';
  afterMessageId: string | null;
};

export type TypingItem = {
  type: 'typing';
};

/** One thing in a settled turn's step group: a step (a tool call) or a line the agent said between steps. */
export type ToolCallRunEntry =
  { type: 'step'; message: Message } | { type: 'narration'; message: Message };

export type ToolCallRunItem = {
  type: 'tool-call-group';
  /** The tool-call messages of the group, in order. Narration is never in this list. */
  messages: Message[];
  /**
   * Set only when a settled turn folded into this one group: its steps and its narration in the
   * order they happened. The answer is not here; it follows as a row of its own.
   */
  entries?: ToolCallRunEntry[];
};

/**
 * The notice, the line under it and the notes of a turn that said only what it was doing and then
 * stopped or failed: its message draws the text, the step row follows, and this row ends the turn,
 * so the step row reads as part of it and not as the start of a new one.
 */
export type TurnOutcomeItem = {
  type: 'turn-outcome';
  message: Message;
};

export type ChatRenderRow =
  MessageWithDateItem | UnreadDividerItem | TypingItem | ToolCallRunItem | TurnOutcomeItem;

// Re-export ToolCallPair type for convenience.
export type { ToolCallPair } from '../conversation-model.ts';

function messageHasImageContent(message: Message): boolean {
  return (
    Array.isArray(message.content) &&
    message.content.some(
      (segment) =>
        typeof segment === 'object' &&
        segment !== null &&
        'type' in segment &&
        segment.type === 'image',
    )
  );
}

function messageHasStructuredEntries(message: Message): boolean {
  const entries = message.metadata?.['cinder:entries'];
  return Array.isArray(entries) && entries.length > 0;
}

/** Options for the message groups helper */
export interface UseChatMessageGroupsOptions {
  /** Function that returns the current messages array */
  getMessages: () => Message[];
  /** Tool calls whose question was answered here; they keep their own row so the answer stays readable. */
  getAnsweredToolCallIds?: () => Iterable<string>;
  /** Live render options supplied by the transcript owner. */
  getRenderOptions?: () => ChatRenderRowOptions;
}

/** What the row builder reads besides the messages. */
export interface ChatRenderRowOptions {
  firstUnreadId?: string | null;
  showTypingIndicator?: boolean;
  ungroupedToolCallIds?: ReadonlySet<string>;
  /**
   * The messages of turns that are not settled: one streaming, reconnecting or still marked
   * streaming. Such a turn is never folded; its narration is drawn muted where it falls.
   */
  unsettledMessageIds?: ReadonlySet<string>;
  /** Tool calls still waiting on a person (an approval or a question). A turn holding one never folds. */
  pendingToolCallIds?: ReadonlySet<string>;
  /** Whether a narration message may fold; false when its message draws more than its text. */
  canFoldNarration?: (message: Message) => boolean;
  /**
   * Whether an assistant message's outcome (a stopped or failed turn's notice) moves after the
   * step row that follows the message. It applies only to a message that a run of tool calls
   * follows directly, which is narration: the turn has no answer. Absent, no outcome moves.
   */
  deferOutcome?: (message: Message) => boolean;
  /**
   * Whether the outcome of a last turn with no assistant message (its run only called tools) is
   * drawn: asked of the anchor `toolEndedTurnAnchor` makes for the turn. When it is, the outcome is
   * the last row, after the turn's steps. Absent, none is drawn.
   */
  turnEndOutcome?: (anchor: Message) => boolean;
  /** The anchor of the last turn when it has no assistant message, made from every message, not only the rows drawn. */
  turnEndAnchor?: Message | undefined;
}

/** Return type for the message groups helper */
export interface UseChatMessageGroupsReturn {
  /** Messages interleaved with date separators */
  readonly messagesWithDates: MessageWithDateItem[];
  /** Render rows derived from messagesWithDates; call buildChatRenderRows with options for UI-only rows. */
  readonly renderRows: ChatRenderRow[];
  /** Map of tool call ID to tool call pairs for O(1) lookup */
  readonly toolCallPairsByCallId: Map<string, ToolCallPair[]>;
  /** Tool result message IDs already represented inside a paired tool call group */
  readonly pairedToolResultIds: Set<string>;
  /** Tool calls that still require an approval action. */
  readonly actionRequiredToolCallIds: Set<string>;
}

// ==========================================================================
// Helper
// ==========================================================================

/** Find result message IDs that are already represented by paired tool-call messages. */
export function findPairedToolResultIds(messages: readonly Message[]): Set<string> {
  const visibleToolCallIds = new Set<string>();
  const pairedResultIds = new Set<string>();

  for (const message of messages) {
    if (message.role === 'tool-call' && message.toolCall) {
      visibleToolCallIds.add(message.toolCall.id);
    }
  }

  for (const message of messages) {
    if (
      message.role === 'tool-result' &&
      message.toolResult &&
      visibleToolCallIds.has(message.toolResult.callId)
    ) {
      pairedResultIds.add(message.id);
    }
  }

  return pairedResultIds;
}

/**
 * Build visible messages with date separators, skipping paired tool-result messages. A system
 * message never opens a day: it stays with the day band it falls under.
 */
export function buildMessagesWithDateSeparators(
  messages: readonly Message[],
  pairedToolResultIds: ReadonlySet<string>,
): MessageWithDateItem[] {
  const result: MessageWithDateItem[] = [];
  let lastDate: string | null = null;

  for (const message of messages) {
    if (message.role === 'tool-result' && pairedToolResultIds.has(message.id)) {
      continue;
    }

    // The instructions are not part of the conversation's days: they are written when the chat is
    // created and say nothing of when it was spoken, so they never open a day (or hold one open).
    const timestamp =
      message.role === 'system'
        ? undefined
        : (message.createdAt ?? message.metadata?.['timestamp']);
    if (timestamp != null) {
      const messageDate = new Date(timestamp);
      const isValidDate = !isNaN(messageDate.getTime());
      if (isValidDate) {
        const dateKey = messageDate.toDateString();

        if (dateKey !== lastDate) {
          result.push({ type: 'date', date: messageDate });
          lastDate = dateKey;
        }
      }
    }
    result.push({ type: 'message', message });
  }

  return result;
}

/** A settled turn that folds: the item range it covers and what the one group holds. */
type TurnFold = {
  lastIndex: number;
  firstMessageId: string;
  lastMessageId: string;
  group: ToolCallRunItem;
};

/** The metadata a narration message may not carry: each is drawn by its message, which a fold drops. */
const narrationOverlayKeys = (): readonly string[] => [
  CINDER_REASONING_METADATA_KEY,
  CINDER_NOTES_METADATA_KEY,
  CINDER_STEPS_METADATA_KEY,
  CINDER_SUGGESTIONS_METADATA_KEY,
  CINDER_ARTIFACT_METADATA_KEY,
];

/**
 * Whether a message's content holds a block that is not text: an image, or a native `thinking` or
 * `redacted_thinking` block, which the message draws as its reasoning disclosure. A fold draws a
 * narration message as its text alone, so any such block would be lost.
 */
function messageHasNonTextContent(message: Message): boolean {
  return (
    Array.isArray(message.content) &&
    message.content.some(
      (segment) =>
        typeof segment !== 'object' ||
        segment === null ||
        !('type' in segment) ||
        segment.type !== 'text',
    )
  );
}

/**
 * Whether a narration message is only its text, so folding it into the step group drops nothing: no
 * image, native or overlaid reasoning, structured entries, notes, steps, suggestions or artifact,
 * and no failed send.
 */
function isPlainNarration(message: Message): boolean {
  return (
    message.role === 'assistant' &&
    !message.hidden &&
    !message.toolCall &&
    message.metadata?.['_deliveryStatus'] !== 'failed' &&
    !messageHasNonTextContent(message) &&
    !messageHasStructuredEntries(message) &&
    narrationOverlayKeys().every((key) => !Object.hasOwn(message.metadata ?? {}, key))
  );
}

/**
 * Finds the settled turns that fold into one step group, keyed by the item index each starts at.
 *
 * A turn is the run of items between two person's messages. It folds when all of these hold:
 *
 * - it is settled: none of its messages is in `unsettledMessageIds`;
 * - it has an answer, the assistant text after its last tool message, and at least one narration;
 * - from its first step or narration to its last step, every item is a step that groups or a plain
 *   narration message. A date separator, an unread divider, a hidden or failed message, an unpaired
 *   tool result, a call with a card or a question of its own, or a call still waiting on a person
 *   ends the fold: that turn keeps today's rows, with its narration drawn in place.
 *
 * The turn's tail (the answer, and anything after it) is not part of the fold: it stays its own
 * rows, so the answer's key never changes when the turn settles.
 */
function planTurnFolds(
  items: readonly MessageWithDateItem[],
  options: ChatRenderRowOptions | undefined,
): Map<number, TurnFold> {
  const folds = new Map<number, TurnFold>();
  const messages = items.flatMap((item) => (item.type === 'message' ? [item.message] : []));
  const roles = classifyAssistantText(messages);
  const firstUnreadId = options?.firstUnreadId ?? null;

  const planTurn = (from: number, to: number): void => {
    const turnItems = items.slice(from, to);
    if (
      turnItems.some(
        (item) => item.type === 'message' && options?.unsettledMessageIds?.has(item.message.id),
      )
    ) {
      return;
    }
    const isStep = (item: MessageWithDateItem): boolean =>
      item.type === 'message' && canGroupToolCall(item.message, options?.ungroupedToolCallIds);
    const isNarration = (item: MessageWithDateItem): boolean =>
      item.type === 'message' &&
      roles.get(item.message.id) === 'narration' &&
      isPlainNarration(item.message) &&
      (options?.canFoldNarration?.(item.message) ?? true);
    const firstIndex = turnItems.findIndex((item) => isStep(item) || isNarration(item));
    const lastIndex = turnItems.findLastIndex(isStep);
    if (firstIndex < 0 || lastIndex < firstIndex) return;
    const span = turnItems.slice(firstIndex, lastIndex + 1);
    const hasAnswer = turnItems
      .slice(lastIndex + 1)
      .some((item) => item.type === 'message' && roles.get(item.message.id) === 'answer');
    if (!hasAnswer || !span.some(isNarration)) return;
    const entries: ToolCallRunEntry[] = [];
    for (const [position, item] of span.entries()) {
      if (item.type !== 'message') return;
      const step = isStep(item);
      if (!step && !isNarration(item)) return;
      if (position > 0 && item.message.id === firstUnreadId) return;
      const callId = item.message.toolCall?.id;
      if (callId !== undefined && options?.pendingToolCallIds?.has(callId)) return;
      entries.push({ type: step ? 'step' : 'narration', message: item.message });
    }
    const firstEntry = entries[0];
    const lastEntry = entries.at(-1);
    if (firstEntry === undefined || lastEntry === undefined) return;
    folds.set(from + firstIndex, {
      lastIndex: from + lastIndex,
      firstMessageId: firstEntry.message.id,
      lastMessageId: lastEntry.message.id,
      group: {
        type: 'tool-call-group',
        messages: entries.flatMap((entry) => (entry.type === 'step' ? [entry.message] : [])),
        entries,
      },
    });
  };

  let turnStart = 0;
  items.forEach((item, index) => {
    if (item.type === 'message' && item.message.role === 'user') {
      planTurn(turnStart, index);
      turnStart = index + 1;
    }
  });
  planTurn(turnStart, items.length);
  return folds;
}

export function buildChatRenderRows(
  items: readonly MessageWithDateItem[],
  options?: ChatRenderRowOptions,
): ChatRenderRow[] {
  const rows: ChatRenderRow[] = [];
  const firstUnreadId = options?.firstUnreadId ?? null;
  let previousMessageId: string | null = null;
  let toolCallRun: Message[] = [];
  const folds = planTurnFolds(items, options);

  // A message whose outcome waits for the step row that follows it.
  let deferredOutcome: Message | undefined;
  const flushToolCallRun = (): void => {
    if (toolCallRun.length > 0) {
      rows.push({ type: 'tool-call-group', messages: toolCallRun });
      if (deferredOutcome !== undefined) {
        rows.push({ type: 'turn-outcome', message: deferredOutcome });
        deferredOutcome = undefined;
      }
    }
    toolCallRun = [];
  };

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    const fold = folds.get(index);
    if (fold) {
      flushToolCallRun();
      if (fold.firstMessageId === firstUnreadId) {
        rows.push({ type: 'unread-divider', afterMessageId: previousMessageId });
      }
      rows.push(fold.group);
      previousMessageId = fold.lastMessageId;
      index = fold.lastIndex;
      continue;
    }
    if (item.type === 'message') {
      if (item.message.id === firstUnreadId) {
        flushToolCallRun();
        rows.push({ type: 'unread-divider', afterMessageId: previousMessageId });
      }
      previousMessageId = item.message.id;
      if (canGroupToolCall(item.message, options?.ungroupedToolCallIds)) {
        toolCallRun.push(item.message);
        continue;
      }
      const next = items[index + 1];
      if (
        item.message.role === 'assistant' &&
        next?.type === 'message' &&
        canGroupToolCall(next.message, options?.ungroupedToolCallIds) &&
        options?.deferOutcome?.(item.message)
      ) {
        flushToolCallRun();
        rows.push(item);
        deferredOutcome = item.message;
        continue;
      }
    }
    flushToolCallRun();
    rows.push(item);
  }
  flushToolCallRun();

  const anchor = options?.turnEndAnchor;
  if (anchor !== undefined && options?.turnEndOutcome?.(anchor) === true) {
    rows.push({ type: 'turn-outcome', message: anchor });
  }

  if (options?.showTypingIndicator) {
    rows.push({ type: 'typing' });
  }

  return rows;
}

function canGroupToolCall(
  message: Message,
  ungroupedToolCallIds: ReadonlySet<string> | undefined,
): boolean {
  const toolCallId = message.toolCall?.id;
  return Boolean(
    message.role === 'tool-call' &&
    toolCallId &&
    !message.hidden &&
    message.metadata?.['_deliveryStatus'] !== 'failed' &&
    !messageHasImageContent(message) &&
    !messageHasStructuredEntries(message) &&
    !ungroupedToolCallIds?.has(toolCallId),
  );
}

export function chatRenderRowKey(row: ChatRenderRow): string {
  switch (row.type) {
    case 'date':
      return `date-${row.date.toISOString()}`;
    case 'message':
      return `msg-${row.message.id}`;
    case 'unread-divider':
      return `unread-${row.afterMessageId ?? 'start'}`;
    case 'typing':
      return 'typing';
    case 'tool-call-group':
      return `tool-group-${row.messages[0]?.id ?? 'empty'}`;
    case 'turn-outcome':
      return `outcome-${row.message.id}`;
    default:
      throw new Error(`Unknown chat render row type: ${String(row)}`);
  }
}

export function findRenderRowIndexByMessageId(
  rows: readonly ChatRenderRow[],
  messageId: string,
): number {
  return rows.findIndex((row) =>
    row.type === 'message'
      ? row.message.id === messageId
      : row.type === 'tool-call-group'
        ? row.messages.some((message) => message.id === messageId) ||
          (row.entries?.some((entry) => entry.message.id === messageId) ?? false)
        : false,
  );
}

/** Return message IDs belonging to the turn containing the active stream message. */
export function getActiveTurnMessageIds(
  messages: readonly Message[],
  activeMessageId: string | undefined,
): Set<string> {
  if (!activeMessageId) return new Set<string>();
  const activeMessageIndex = messages.findIndex((message) => message.id === activeMessageId);
  if (activeMessageIndex < 0) return new Set<string>();

  let turnStartIndex = activeMessageIndex;
  while (turnStartIndex > 0 && messages[turnStartIndex]?.role !== 'user') {
    turnStartIndex -= 1;
  }
  return new Set(messages.slice(turnStartIndex).map((message) => message.id));
}

/**
 * Creates reactive derived values for message grouping and tool call pairing.
 *
 * @example
 * ```svelte
 * <script lang="ts">
 *   import { useChatMessageGroups } from './use-chat-message-groups.svelte.ts';
 *
 *   const messageGroups = useChatMessageGroups({
 *     getMessages: () => messages,
 *   });
 *
 *   // Access derived values
 *   const items = messageGroups.messagesWithDates;
 *   const pairs = messageGroups.toolCallPairsByCallId.get(callId);
 * </script>
 * ```
 */
export function useChatMessageGroups(
  options: UseChatMessageGroupsOptions,
): UseChatMessageGroupsReturn {
  const { getMessages, getRenderOptions } = options;

  // Derive tool call pairs from messages
  const toolCallPairs = $derived(pairToolCallsWithResults(getMessages()));

  // Build a Map for O(1) lookup of tool call pairs by call ID
  // Note: Using plain Map instead of SvelteMap since the map is recreated
  // on each derivation (not mutated), so reactive wrapper is unnecessary
  const toolCallPairsByCallId = $derived.by(() => {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Map is recreated on each derivation, not mutated
    const map = new Map<string, ToolCallPair[]>();
    for (const pair of toolCallPairs) {
      const existing = map.get(pair.call.id);
      if (existing) {
        existing.push(pair);
      } else {
        map.set(pair.call.id, [pair]);
      }
    }
    return map;
  });

  const pairedToolResultIds = $derived.by(() => findPairedToolResultIds(getMessages()));

  const actionRequiredToolCallIds = $derived.by(() => {
    const ids = new Set<string>();
    for (const [callId, pairs] of toolCallPairsByCallId) {
      if (pairs.some((pair) => pair.result?.outcome === 'action_required')) ids.add(callId);
    }
    return ids;
  });

  // Group messages by date for date separators
  const messagesWithDates = $derived.by(() => {
    return buildMessagesWithDateSeparators(getMessages(), pairedToolResultIds);
  });

  const renderRows = $derived.by(() => {
    const renderOptions = getRenderOptions?.();
    return buildChatRenderRows(messagesWithDates, {
      pendingToolCallIds: actionRequiredToolCallIds,
      ...renderOptions,
      turnEndAnchor:
        renderOptions?.turnEndOutcome === undefined
          ? undefined
          : toolEndedTurnAnchor(getMessages()),
      ungroupedToolCallIds: new Set([
        ...(renderOptions?.ungroupedToolCallIds ?? []),
        ...(options.getAnsweredToolCallIds?.() ?? []),
      ]),
    });
  });

  return {
    get messagesWithDates() {
      return messagesWithDates;
    },
    get renderRows() {
      return renderRows;
    },
    get toolCallPairsByCallId() {
      return toolCallPairsByCallId;
    },
    get pairedToolResultIds() {
      return pairedToolResultIds;
    },
    get actionRequiredToolCallIds() {
      return actionRequiredToolCallIds;
    },
  };
}
