import type {
  ChatAdapter,
  ChatCommand,
  ChatToolApprovalResolution,
} from '../adapter/chat-adapter.ts';
import type { Message, MessageInput } from '../conversation-model.ts';
import type { ChatAttachment } from '../input/chat-attachment.ts';

type CommandCallback<T extends unknown[]> = (...args: T) => void | Promise<void>;

type CommandActionsOptions = {
  getAdapter: () => ChatAdapter | undefined;
  getMessages: () => Message[];
  getOnAdapterError: () => ((event: { command: ChatCommand; error: unknown }) => void) | undefined;
  getOnSubmit: () =>
    CommandCallback<[{ message: MessageInput; attachments: ChatAttachment[] }]> | undefined;
  getOnRetry: () => CommandCallback<[string]> | undefined;
  getOnEdit: () => CommandCallback<[{ messageId: string; content: string }]> | undefined;
  getOnApprove: () => CommandCallback<[string]> | undefined;
  getOnDeny: () => CommandCallback<[string]> | undefined;
  getOnStop: () => CommandCallback<[{ messageId: string }]> | undefined;
  invalidateHistory: () => void;
  afterSubmit: (editing: boolean) => void;
  getConversationIdentity: () => string;
};

function removeFromSet(set: Set<string>, value: string): Set<string> {
  const next = new Set(set);
  next.delete(value);
  return next;
}

/** Owns Chat command routing, retry flights, editing state, and approval rollback. */
export function useChatCommandActions(options: CommandActionsOptions) {
  let approvedToolCallIds = $state(new Set<string>());
  let deniedToolCallIds = $state(new Set<string>());
  let editingMessageIds = $state(new Set<string>());
  let pendingRetryMessageTokens = $state(new Map<string, symbol>());

  $effect(() => {
    options.getConversationIdentity();
    approvedToolCallIds = new Set();
    pendingRetryMessageTokens = new Map();
    deniedToolCallIds = new Set();
    editingMessageIds = new Set();
  });

  function dispatchCommand(
    command: ChatCommand,
    runAdapterMethod: (adapter: ChatAdapter) => Promise<void> | undefined,
    callback: (() => void | Promise<void>) | undefined,
  ): Promise<void> | void {
    const adapter = options.getAdapter();
    if (adapter) {
      try {
        const run = runAdapterMethod(adapter);
        if (run !== undefined) {
          return run.catch((error: unknown) => {
            options.getOnAdapterError()?.({ command, error });
          });
        }
      } catch (error) {
        options.getOnAdapterError()?.({ command, error });
        return;
      }
    }
    void callback?.();
  }

  function handleSubmit(message: MessageInput, attachments: ChatAttachment[]): void {
    options.invalidateHistory();
    const editing = editingMessageIds.size > 0;
    void dispatchCommand(
      'sendMessage',
      (adapter) => Promise.resolve(adapter.sendMessage(message, attachments)),
      () => options.getOnSubmit()?.({ message, attachments }),
    );
    options.afterSubmit(editing);
  }

  function dispatchRetryMessage(messageId: string): void {
    if (pendingRetryMessageTokens.has(messageId)) return;
    const flightToken = Symbol(messageId);
    pendingRetryMessageTokens = new Map(pendingRetryMessageTokens).set(messageId, flightToken);
    const clearPending = (): void => {
      if (pendingRetryMessageTokens.get(messageId) !== flightToken) return;
      const next = new Map(pendingRetryMessageTokens);
      next.delete(messageId);
      pendingRetryMessageTokens = next;
    };
    try {
      let callbackRun: Promise<void> | undefined;
      const run = dispatchCommand(
        'retryMessage',
        (adapter) =>
          adapter.retryMessage ? Promise.resolve(adapter.retryMessage(messageId)) : undefined,
        () => {
          const result = options.getOnRetry()?.(messageId);
          if (result !== undefined) callbackRun = Promise.resolve(result);
        },
      );
      const flight = run ?? callbackRun;
      if (flight !== undefined) void flight.finally(clearPending);
      else clearPending();
    } catch (error) {
      clearPending();
      throw error;
    }
  }

  function handleEdit(event: { messageId: string; content: string }): void {
    void dispatchCommand(
      'editMessage',
      (adapter) => (adapter.editMessage ? Promise.resolve(adapter.editMessage(event)) : undefined),
      () => options.getOnEdit()?.(event),
    );
  }

  function resolveToolApproval(
    toolCallId: string,
    command: 'approveToolCall' | 'denyToolCall',
    canHandle: boolean,
    commit: (id: string) => void,
    rollback: (id: string) => void,
    runAdapter: (adapter: ChatAdapter) => Promise<void | ChatToolApprovalResolution> | undefined,
    callback: (() => void | Promise<void>) | undefined,
  ): void {
    if (!canHandle) return;
    if (approvedToolCallIds.has(toolCallId) || deniedToolCallIds.has(toolCallId)) return;
    commit(toolCallId);
    const adapter = options.getAdapter();
    if (adapter) {
      let run: Promise<void | ChatToolApprovalResolution> | undefined;
      try {
        run = runAdapter(adapter);
      } catch (error) {
        rollback(toolCallId);
        options.getOnAdapterError()?.({ command, error });
        return;
      }
      if (run !== undefined) {
        const handleResolution = (
          resolution: void | ChatToolApprovalResolution,
        ): void | Promise<void> => {
          if (resolution === 'pending') {
            rollback(toolCallId);
            return undefined;
          }
          return callback?.();
        };
        const handleFailure = (error: unknown): void => {
          rollback(toolCallId);
          options.getOnAdapterError()?.({ command, error });
        };
        void run.then(handleResolution, handleFailure);
        return;
      }
    }
    void callback?.();
  }

  function handleApprove(toolCallId: string): void {
    resolveToolApproval(
      toolCallId,
      'approveToolCall',
      canApprove,
      (id) => (approvedToolCallIds = new Set([...approvedToolCallIds, id])),
      (id) => (approvedToolCallIds = removeFromSet(approvedToolCallIds, id)),
      (adapter) =>
        adapter.approveToolCall ? Promise.resolve(adapter.approveToolCall(toolCallId)) : undefined,
      () => options.getOnApprove()?.(toolCallId),
    );
  }

  function handleDeny(toolCallId: string): void {
    resolveToolApproval(
      toolCallId,
      'denyToolCall',
      canDeny,
      (id) => (deniedToolCallIds = new Set([...deniedToolCallIds, id])),
      (id) => (deniedToolCallIds = removeFromSet(deniedToolCallIds, id)),
      (adapter) =>
        adapter.denyToolCall ? Promise.resolve(adapter.denyToolCall(toolCallId)) : undefined,
      () => options.getOnDeny()?.(toolCallId),
    );
  }

  function handleStopGenerating(): void {
    const streamingMessage = options
      .getMessages()
      .slice()
      .reverse()
      .find((message) => message.role === 'assistant');
    if (!streamingMessage) return;
    void dispatchCommand(
      'stopGenerating',
      (adapter) =>
        adapter.stopGenerating
          ? Promise.resolve(adapter.stopGenerating(streamingMessage.id))
          : undefined,
      () => options.getOnStop()?.({ messageId: streamingMessage.id }),
    );
  }

  function handleEditingChange(messageId: string, editing: boolean): void {
    const next = new Set(editingMessageIds);
    if (editing) next.add(messageId);
    else next.delete(messageId);
    editingMessageIds = next;
  }

  const canApprove = $derived(
    options.getOnApprove() !== undefined || options.getAdapter()?.approveToolCall !== undefined,
  );
  const canDeny = $derived(
    options.getOnDeny() !== undefined || options.getAdapter()?.denyToolCall !== undefined,
  );

  return {
    handleSubmit,
    handleRetry: dispatchRetryMessage,
    handleEdit,
    handleApprove,
    handleDeny,
    handleStopGenerating,
    handleEditingChange,
    retryMessage: dispatchRetryMessage,
    get canApprove() {
      return canApprove;
    },
    get canDeny() {
      return canDeny;
    },
    get isEditing() {
      return editingMessageIds.size > 0;
    },
    get approvedToolCallIds() {
      return approvedToolCallIds;
    },
    get deniedToolCallIds() {
      return deniedToolCallIds;
    },
  };
}
