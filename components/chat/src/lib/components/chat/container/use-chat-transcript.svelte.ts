import { isStreamingMessage } from '../builders.ts';
import type { ConversationHistory, Message, ToolResult } from '../conversation-model.ts';
import { toolEndedTurnAnchor } from '../message/turn-outcome.ts';
import type { ChatTurnState } from '../message/turn-state.ts';
import { resolveMessageTurnState } from '../message/turn-state.ts';
import {
  getMessages,
  pairToolCallsWithResults,
  resolveMessageReasoning,
} from '../utilities/index.ts';
import type { ReasoningInfo } from '../utilities/types.ts';
import { selectChatProgressState, type ChatProgressState } from './select-chat-progress-state.ts';
import {
  getActiveTurnMessageIds,
  useChatMessageGroups,
  type ChatRenderRow,
  type ChatRenderRowOptions,
} from './use-chat-message-groups.svelte.ts';

export interface UseChatTranscriptOptions {
  getConversation: () => ConversationHistory;
  getRollbackMessageId: () => string | null;
  getStreaming: () => boolean;
  getStreamingMessageId: () => string | null;
  getStreamingContent: () => string;
  getMessageReasoning?:
    (() => ((message: Message) => string | ReasoningInfo | undefined) | undefined) | undefined;
  getFirstUnreadId: () => string | null;
  getUngroupAllToolCalls: () => boolean;
  /** Whether the host's run-state surface already communicates progress in place of typing. */
  getSuppressTypingIndicator?: () => boolean;
  /** Host-owned state for the active assistant turn, including transport reconnects. */
  getMessageTurnState?:
    (() => ((message: Message) => ChatTurnState | undefined) | undefined) | undefined;
  /** Tool calls whose question was answered here, which keep their own row. */
  getAnsweredToolCallIds?: (() => Iterable<string>) | undefined;
  /**
   * Whether a narration message may fold into its turn's step group. False for one that draws more
   * than its text, which a fold would drop. Absent, every plain narration message may fold.
   */
  getCanFoldNarration?: (() => ((message: Message) => boolean) | undefined) | undefined;
  /**
   * Whether a message's stopped or failed notice moves after the step row that follows it, so the
   * turn reads as its text, its steps, then how it ended. Absent, no notice moves.
   */
  getDeferOutcome?: (() => ((message: Message) => boolean) | undefined) | undefined;
  /**
   * Whether the outcome of a last turn that has no assistant message (its run only called tools)
   * is drawn after its steps, asked of the anchor Chat makes for that turn.
   */
  getTurnEndOutcome?: (() => ((anchor: Message) => boolean) | undefined) | undefined;
}

export interface UseChatTranscriptReturn {
  readonly messages: Message[];
  readonly lastMessageId: string | undefined;
  readonly messageIndexById: Map<string, number>;
  readonly rollbackBoundaryIndex: number;
  readonly reasoningStreaming: boolean;
  readonly toolActivity: boolean;
  readonly activeTurnMessageIds: Set<string>;
  readonly progressState: ChatProgressState;
  readonly showTypingIndicator: boolean;
  readonly toolCallPairsByCallId: Map<string, import('../conversation-model.ts').ToolCallPair[]>;
  readonly toolResultMessagesByResult: Map<ToolResult, Message>;
  readonly actionRequiredToolCallIds: Set<string>;
  readonly renderRows: ChatRenderRow[];
}

export function useChatTranscript(options: UseChatTranscriptOptions): UseChatTranscriptReturn {
  const messages = $derived(getMessages(options.getConversation()));
  const lastMessageId = $derived(messages.at(-1)?.id);
  const rollbackBoundaryIndex = $derived.by(() => {
    const rollbackMessageId = options.getRollbackMessageId();
    return rollbackMessageId
      ? messages.findIndex((message) => message.id === rollbackMessageId)
      : -1;
  });
  const messageIndexById = $derived(
    new Map(messages.map((message, index) => [message.id, index] as const)),
  );
  const turnReconnects = $derived.by(() => {
    const activeMessageId = options.getStreamingMessageId() ?? messages.at(-1)?.id;
    const activeMessage = messages.find((message) => message.id === activeMessageId);
    const anchor = toolEndedTurnAnchor(messages);
    return (
      (activeMessage !== undefined &&
        resolveMessageTurnState(activeMessage, options.getMessageTurnState?.())?.kind ===
          'reconnecting') ||
      (anchor !== undefined &&
        resolveMessageTurnState(anchor, options.getMessageTurnState?.())?.kind === 'reconnecting')
    );
  });

  const messageGroups = useChatMessageGroups({
    getMessages: () => messages,
    ...(options.getAnsweredToolCallIds === undefined
      ? {}
      : { getAnsweredToolCallIds: options.getAnsweredToolCallIds }),
    getRenderOptions: () => {
      const renderOptions: ChatRenderRowOptions = {
        firstUnreadId: options.getFirstUnreadId(),
        showTypingIndicator:
          showTypingIndicator && !options.getSuppressTypingIndicator?.() && !turnReconnects,
        unsettledMessageIds,
      };
      const canFoldNarration = options.getCanFoldNarration?.();
      if (canFoldNarration !== undefined) renderOptions.canFoldNarration = canFoldNarration;
      const deferOutcome = options.getDeferOutcome?.();
      if (deferOutcome !== undefined) renderOptions.deferOutcome = deferOutcome;
      const turnEndOutcome = options.getTurnEndOutcome?.();
      if (turnEndOutcome !== undefined) renderOptions.turnEndOutcome = turnEndOutcome;
      if (options.getUngroupAllToolCalls()) {
        renderOptions.ungroupedToolCallIds = new Set(
          messages.flatMap((message) => (message.toolCall?.id ? [message.toolCall.id] : [])),
        );
      }
      return renderOptions;
    },
  });
  const toolResultMessagesByResult = $derived.by(() => {
    const map = new Map<ToolResult, Message>();
    for (const message of messages) {
      if (message.role === 'tool-result' && message.toolResult) {
        map.set(message.toolResult, message);
      }
    }
    return map;
  });
  const toolCallPairsByCallId = $derived(messageGroups.toolCallPairsByCallId);
  const actionRequiredToolCallIds = $derived(messageGroups.actionRequiredToolCallIds);

  const reasoningStreaming = $derived.by(() => {
    if (!options.getStreaming()) return false;
    const activeMessageId = options.getStreamingMessageId() ?? messages.at(-1)?.id;
    const activeMessage = messages.find((message) => message.id === activeMessageId);
    if (!activeMessage) return false;
    if (options.getStreamingMessageId() === null && !isStreamingMessage(activeMessage)) {
      return false;
    }
    return Boolean(resolveMessageReasoning(activeMessage, options.getMessageReasoning?.()));
  });
  const activeTurnMessageIds = $derived.by(() => {
    if (!options.getStreaming()) return new Set<string>();
    const activeMessageId = options.getStreamingMessageId() ?? messages.at(-1)?.id;
    return getActiveTurnMessageIds(messages, activeMessageId ?? undefined);
  });
  // The turns that are not settled: the active stream's, and any with a message still marked
  // streaming or one the host says is streaming or reconnecting. A turn folds into its step group
  // only once it is not one of these.
  const unsettledMessageIds = $derived.by(() => {
    const ids = new Set(activeTurnMessageIds);
    const declared = options.getMessageTurnState?.();
    messages.forEach((message, index) => {
      const kind = resolveMessageTurnState(message, declared)?.kind;
      if (!isStreamingMessage(message) && kind !== 'streaming' && kind !== 'reconnecting') return;
      let start = index;
      while (start > 0 && messages[start]?.role !== 'user') start -= 1;
      for (let at = start; at < messages.length; at += 1) {
        if (at > index && messages[at]?.role === 'user') break;
        ids.add(messages[at]!.id);
      }
    });
    return ids;
  });
  const toolActivity = $derived.by(() => {
    if (!options.getStreaming()) return false;
    return pairToolCallsWithResults(
      messages.filter((message) => activeTurnMessageIds.has(message.id)),
    ).some((pair) => !pair.result);
  });
  const progressState = $derived(
    selectChatProgressState({
      streaming: options.getStreaming(),
      reasoningStreaming,
      toolActivity,
    }),
  );
  // The three quiet dots follow the last assistant line whenever a run is active and neither
  // reasoning nor a tool reports progress, including after partial text has streamed (a pause).
  const showTypingIndicator = $derived(progressState === 'streaming');

  return {
    get messages() {
      return messages;
    },
    get lastMessageId() {
      return lastMessageId;
    },
    get messageIndexById() {
      return messageIndexById;
    },
    get rollbackBoundaryIndex() {
      return rollbackBoundaryIndex;
    },
    get reasoningStreaming() {
      return reasoningStreaming;
    },
    get toolActivity() {
      return toolActivity;
    },
    get activeTurnMessageIds() {
      return activeTurnMessageIds;
    },
    get progressState() {
      return progressState;
    },
    get showTypingIndicator() {
      return showTypingIndicator;
    },
    get toolCallPairsByCallId() {
      return toolCallPairsByCallId;
    },
    get toolResultMessagesByResult() {
      return toolResultMessagesByResult;
    },
    get actionRequiredToolCallIds() {
      return actionRequiredToolCallIds;
    },
    get renderRows() {
      return messageGroups.renderRows;
    },
  };
}
