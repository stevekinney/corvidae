import {
  appendMessages,
  clearMessageDeliveryStatus,
  markMessageDeliveryFailed,
  markMessageDeliveryPending,
  markMessageFollowUp,
} from '../components/chat/builders.ts';
import type { ConversationHistory, MessageInput } from '../components/chat/conversation-model.ts';
import type { ChatAttachment } from '../components/chat/input/chat-attachment.ts';
import type { SessionRunState } from './session-controller-history.ts';
import type { ChatSessionControllerOptions } from './session-controller-support.ts';

/** How a run ended, which decides what happens to the follow-ups still waiting. */
export type RunOutcome = 'completed' | 'failed' | 'stopped';

type FollowUp = {
  id: string;
  conversationId: string;
  input: MessageInput;
  attachments: ChatAttachment[];
  /** The invalidation epoch the follow-up was queued under. */
  epoch: number;
  /**
   * `queued` has not been handed to the hook yet, `handed` is with it,
   * `acknowledged` was admitted, `failed` was rejected or refused, and
   * `promoted` became an ordinary turn.
   */
  state: 'queued' | 'handed' | 'acknowledged' | 'failed' | 'promoted';
  resolve: () => void;
  reject: (error: unknown) => void;
};

type FollowUpQueueDependencies = {
  options: ChatSessionControllerOptions;
  lifecycle: SessionRunState;
  messageAttachments: Map<string, ChatAttachment[]>;
  update: (conversation: ConversationHistory) => void;
  reportError: (error: unknown) => void;
  /** Whether a run is working, or is parked on a tool approval. */
  hasRunInProgress: () => boolean;
  /** Promotes a follow-up row to an ordinary turn and runs it to the end. */
  runAsTurn: (messageId: string) => Promise<void>;
};

/**
 * Owns the follow-ups a user sent while a run was working.
 *
 * Follow-ups are handed to the host's hook one at a time, in the order they
 * were sent, so a slow acknowledgement cannot be overtaken. Each one is a row in
 * the transcript, stamped `_followUp`, that never owns the run. A follow-up that
 * is still waiting when the run ends is sent as an ordinary turn, or failed with
 * a retry when the user stopped the run.
 *
 * Acknowledgements are tied to an invalidation epoch rather than to the run's
 * generation. A stop retires the run's own work but must not retire an
 * acknowledgement the hook still owes, so only `invalidate()` and disposal move
 * the epoch.
 */
export function createFollowUpQueue({
  options,
  lifecycle,
  messageAttachments,
  update,
  reportError,
  hasRunInProgress,
  runAsTurn,
}: FollowUpQueueDependencies) {
  const records = new Map<string, FollowUp>();
  const order: FollowUp[] = [];
  let epoch = 0;
  let pumping = false;

  const rowIsVisible = (record: FollowUp): boolean =>
    !lifecycle.disposed &&
    options.getConversation().id === record.conversationId &&
    options.getConversation().messages[record.id] !== undefined;
  const isRetired = (record: FollowUp): boolean => lifecycle.disposed || record.epoch !== epoch;
  const markFailed = (record: FollowUp): void => {
    record.state = 'failed';
    if (rowIsVisible(record))
      update(markMessageDeliveryFailed(options.getConversation(), record.id));
  };

  const handOver = async (record: FollowUp): Promise<void> => {
    if (lifecycle.disposed) {
      record.state = 'failed';
      record.reject(new Error('Chat session is disposed'));
      return;
    }
    if (record.epoch !== epoch) {
      record.state = 'failed';
      record.reject(
        new Error('This follow-up was not delivered: the session was invalidated first'),
      );
      return;
    }
    if (options.getConversation().id !== record.conversationId) {
      // The user's words must not vanish: say so, and mark the row if it is
      // still on screen.
      const error = new Error(
        'This follow-up was not delivered: the conversation changed before it could be sent',
      );
      markFailed(record);
      reportError(error);
      record.reject(error);
      return;
    }
    record.state = 'handed';
    try {
      await options.sendRunInput?.(record.conversationId, record.input, record.attachments, {
        messageId: record.id,
      });
    } catch (error) {
      // After an invalidation nothing the hook says is allowed to land.
      if (isRetired(record)) {
        record.resolve();
        return;
      }
      markFailed(record);
      reportError(error);
      record.reject(error);
      return;
    }
    if (isRetired(record)) {
      record.resolve();
      return;
    }
    record.state = 'acknowledged';
    if (rowIsVisible(record))
      update(clearMessageDeliveryStatus(options.getConversation(), record.id));
    record.resolve();
  };

  const takeNext = (): FollowUp | undefined => {
    while (order.length > 0) {
      const next = order.shift()!;
      if (next.state === 'queued') return next;
    }
    return undefined;
  };

  const pump = async (): Promise<void> => {
    if (pumping) return;
    pumping = true;
    try {
      for (let next = takeNext(); next; next = takeNext()) await handOver(next);
    } finally {
      pumping = false;
    }
  };

  const submit = (record: FollowUp): Promise<void> => {
    record.state = 'queued';
    record.epoch = epoch;
    const settled = new Promise<void>((resolve, reject) => {
      record.resolve = resolve;
      record.reject = reject;
    });
    const stale = order.indexOf(record);
    if (stale !== -1) order.splice(stale, 1);
    order.push(record);
    void pump();
    return settled;
  };

  return {
    /** Appends a follow-up row to the transcript and queues it for the hook. */
    send(
      conversationId: string,
      input: MessageInput,
      attachments: ChatAttachment[],
    ): Promise<void> | undefined {
      // No `startSubmission`: that would retire the very run the input is for.
      const appended = appendMessages(options.getConversation(), input);
      const id = appended.ids.at(-1);
      if (!id) return undefined;
      messageAttachments.set(id, [...attachments]);
      update(markMessageDeliveryPending(markMessageFollowUp(appended, id), id));
      const record: FollowUp = {
        id,
        conversationId,
        input,
        attachments: [...attachments],
        epoch,
        state: 'queued',
        resolve: () => undefined,
        reject: () => undefined,
      };
      records.set(id, record);
      return submit(record);
    },
    /** Whether a row is a follow-up this controller is still tracking. */
    has: (messageId: string): boolean => records.has(messageId),
    /** Sends a failed follow-up through the hook again, with the same message id. */
    resend(messageId: string): Promise<void> {
      const record = records.get(messageId);
      if (!record) throw new Error('This follow-up can no longer be resent');
      record.conversationId = options.getConversation().id;
      update(markMessageDeliveryPending(options.getConversation(), messageId));
      return submit(record);
    },
    /** Forgets a follow-up that became an ordinary turn. */
    forget(messageId: string): void {
      const record = records.get(messageId);
      if (record) record.state = 'promoted';
      records.delete(messageId);
    },
    /**
     * Called when a run has ended. Anything still waiting for the hook is sent
     * as an ordinary turn (one at a time, each after the previous run ends),
     * or failed with a retry when the user stopped the run.
     */
    async runEnded(outcome: RunOutcome): Promise<void> {
      if (lifecycle.disposed || lifecycle.running || hasRunInProgress()) return;
      const waiting = order.filter(
        (record) =>
          record.state === 'queued' &&
          record.epoch === epoch &&
          record.conversationId === options.getConversation().id,
      );
      const first = waiting[0];
      if (!first) return;
      if (outcome === 'stopped') {
        for (const record of waiting) {
          markFailed(record);
          record.reject(
            new Error('This follow-up was not delivered: the run was stopped before it was sent'),
          );
        }
        return;
      }
      // The next run's own end handles the rest, so they go out in order.
      try {
        await runAsTurn(first.id);
        first.resolve();
      } catch (error) {
        first.reject(error);
      }
    },
    /** Retires every acknowledgement still owed, and drops what is waiting. */
    invalidate(): void {
      epoch += 1;
    },
    dispose(): void {
      epoch += 1;
      records.clear();
    },
  };
}
