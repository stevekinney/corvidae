import {
  appendMessages,
  clearMessageDeliveryStatus,
  markMessageDeliveryFailed,
  markMessageDeliveryPending,
  markMessageFollowUp,
  removeMessage,
} from '../components/chat/builders.ts';
import type { ConversationHistory, MessageInput } from '../components/chat/conversation-model.ts';
import type { ChatAttachment } from '../components/chat/input/chat-attachment.ts';
import { getOwn } from '../utilities/get-own.ts';
import type { SessionRunState } from './session-controller-history.ts';
import {
  ownRowEnvironment,
  type ChatSessionControllerOptions,
} from './session-controller-support.ts';

/** How a run ended, which decides what happens to the follow-ups still waiting. */
export type RunOutcome = 'completed' | 'failed' | 'stopped';

type FollowUp = {
  id: string;
  conversationId: string;
  input: MessageInput;
  attachments: ChatAttachment[];
  /** The invalidation epoch the follow-up was queued under. */
  epoch: number;
  /** Send order, which decides the order promoted follow-ups go out in. */
  sequence: number;
  /**
   * `queued` has not been handed to the hook yet, `handed` is with it,
   * `acknowledged` was accepted, `delivered` is in its run's terminal history
   * or the host said its run took it, `cancelled` was accepted but its run
   * ended without delivering it, and waits to be sent as an ordinary turn,
   * `failed` was rejected, refused or lost to a stop, `promoted` became an
   * ordinary turn, and `removed` was taken back by the person.
   */
  state:
    | 'queued'
    | 'handed'
    | 'acknowledged'
    | 'delivered'
    | 'cancelled'
    | 'failed'
    | 'promoted'
    | 'removed';
  /** The host said the run took it while its acknowledgement was still owed. */
  reportedDelivered?: boolean;
  /** A removal in flight, so a second Remove waits on the first instead of asking twice. */
  removing?: Promise<void>;
  /**
   * How the first run that ended after the hand-off ended, and the ids in the
   * terminal history it carried. Together with the acknowledgement it decides
   * the follow-up's fate; either can arrive first.
   */
  runEnd?: { outcome: RunOutcome; terminalIds: ReadonlySet<string> | undefined };
  /** The host's receipt was `promoted`: the turn is already in the conversation. */
  receiptPromoted?: boolean;
  /** Settles the promise the sender is waiting on. */
  settled: PromiseWithResolvers<void>;
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
  let nextSequence = 0;

  const rowIsVisible = (record: FollowUp): boolean =>
    !lifecycle.disposed &&
    options.getConversation().id === record.conversationId &&
    getOwn(options.getConversation().messages, record.id) !== undefined;
  const isRetired = (record: FollowUp): boolean => lifecycle.disposed || record.epoch !== epoch;
  const invalidated = (): Error =>
    new Error('This follow-up was not delivered: the session was invalidated first');
  const isLive = (record: FollowUp): boolean =>
    record.epoch === epoch && record.conversationId === options.getConversation().id;
  /**
   * A host that can take a follow-up back (`retractRunInput`) holds it until the
   * run takes it, so acceptance is not delivery: the row stays queued until the
   * host reports the run reached it, or the run's end shows it did.
   */
  const holdsUntilDelivered = options.retractRunInput !== undefined;
  /** The row reads as a sent message from now on. A row already reading so is not written again. */
  const showSent = (record: FollowUp): void => {
    if (!rowIsVisible(record)) return;
    const row = getOwn(options.getConversation().messages, record.id);
    if (row?.metadata['_deliveryStatus'] === undefined) return;
    update(clearMessageDeliveryStatus(options.getConversation(), record.id));
  };
  /** The run has it: the row reads as sent, and the run's end will not resend it. */
  const markDelivered = (record: FollowUp): void => {
    record.state = 'delivered';
    showSent(record);
  };
  /** Takes the row out of the transcript and forgets the follow-up: it will never be sent. */
  const drop = (record: FollowUp): void => {
    record.state = 'removed';
    records.delete(record.id);
    const queuedAt = order.indexOf(record);
    if (queuedAt !== -1) order.splice(queuedAt, 1);
    messageAttachments.delete(record.id);
    if (rowIsVisible(record)) update(removeMessage(options.getConversation(), record.id));
    record.settled.resolve();
  };
  /** A record's state as it is now, which an `await` may have changed since it was last read. */
  const stateOf = (record: FollowUp): FollowUp['state'] => record.state;
  const markFailed = (record: FollowUp): void => {
    record.state = 'failed';
    if (rowIsVisible(record))
      update(markMessageDeliveryFailed(options.getConversation(), record.id));
  };

  /**
   * Decides what became of an accepted follow-up once its run has ended. The run
   * delivered it if its terminal history names the row. Otherwise the server
   * cancelled it, including when the run ended with no terminal history at all:
   * a stop by this client leaves it failed with a retry, and a completion or a
   * failure leaves it to be sent as an ordinary turn.
   */
  const classify = (record: FollowUp): void => {
    if (record.state !== 'acknowledged' || !record.runEnd) return;
    const { outcome, terminalIds } = record.runEnd;
    // A promoted receipt means the host already committed the turn to the
    // conversation, so it is delivered even when the run sent no history.
    if (record.receiptPromoted || terminalIds?.has(record.id)) markDelivered(record);
    else if (outcome === 'stopped') markFailed(record);
    else record.state = 'cancelled';
  };

  /** Sends the earliest waiting follow-up as an ordinary turn, if no run is in progress. */
  const promoteNext = async (): Promise<void> => {
    if (lifecycle.disposed || lifecycle.running || hasRunInProgress()) return;
    const first = [...records.values()]
      .filter(
        (record) =>
          (record.state === 'queued' || record.state === 'cancelled') &&
          record.removing === undefined &&
          isLive(record),
      )
      .sort((a, b) => a.sequence - b.sequence)[0];
    if (!first) return;
    if (!rowIsVisible(first)) {
      // A snapshot adopted after the run ended replaced its row. Sending a turn now
      // would carry no user message, so the input would vanish; report it instead.
      first.state = 'failed';
      const error = new Error(
        'This follow-up was not resent: its message is no longer in the conversation',
      );
      reportError(error);
      first.settled.reject(error);
      void promoteNext();
      return;
    }
    // The next run's own end handles the rest, so they go out in order.
    try {
      await runAsTurn(first.id);
      first.settled.resolve();
    } catch (error) {
      first.settled.reject(error);
    }
  };

  const handOver = async (record: FollowUp): Promise<void> => {
    if (lifecycle.disposed) {
      record.state = 'failed';
      record.settled.reject(new Error('Chat session is disposed'));
      return;
    }
    if (record.epoch !== epoch) {
      // Reported like a conversation change: the words must not vanish silently.
      const error = invalidated();
      markFailed(record);
      reportError(error);
      record.settled.reject(error);
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
      record.settled.reject(error);
      return;
    }
    record.state = 'handed';
    try {
      const receipt = await options.sendRunInput?.(
        record.conversationId,
        record.input,
        record.attachments,
        { messageId: record.id },
      );
      if (receipt?.state === 'promoted') record.receiptPromoted = true;
    } catch (error) {
      // After an invalidation nothing the hook says is allowed to land, and
      // the sender is told the input did not complete.
      if (isRetired(record)) {
        record.settled.reject(invalidated());
        return;
      }
      markFailed(record);
      reportError(error);
      record.settled.reject(error);
      // A later follow-up may have been waiting on this one to settle.
      if (record.runEnd) void promoteNext();
      return;
    }
    if (isRetired(record)) {
      record.settled.resolve();
      return;
    }
    record.state = 'acknowledged';
    if (record.reportedDelivered) markDelivered(record);
    else if (!holdsUntilDelivered || record.receiptPromoted) showSent(record);
    record.settled.resolve();
    // The run may have ended before this acknowledgement arrived. Now both
    // halves are known, so the follow-up's fate is too.
    if (record.runEnd) {
      classify(record);
      void promoteNext();
    }
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
    // A resend belongs to whatever run is in progress now, not to the run that
    // ended before it; that run's outcome must not classify the new attempt.
    delete record.runEnd;
    delete record.receiptPromoted;
    record.epoch = epoch;
    record.settled = Promise.withResolvers<void>();
    const stale = order.indexOf(record);
    if (stale !== -1) order.splice(stale, 1);
    order.push(record);
    void pump();
    return record.settled.promise;
  };

  return {
    /** Appends a follow-up row to the transcript and queues it for the hook. */
    send(
      conversationId: string,
      input: MessageInput,
      attachments: ChatAttachment[],
    ): Promise<void> | undefined {
      // No `startSubmission`: that would retire the very run the input is for.
      const appended = appendMessages(options.getConversation(), input, ownRowEnvironment(options));
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
        sequence: (nextSequence += 1),
        state: 'queued',
        settled: Promise.withResolvers<void>(),
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
    /**
     * The host's word that the run took these follow-ups into its conversation
     * (`ChatSessionController.markFollowUpsDelivered`). Each reads as a sent
     * message from now on, can no longer be removed, and is not resent when the
     * run ends. An id this controller is not holding is ignored.
     */
    delivered(messageIds: Iterable<string>): void {
      for (const id of messageIds) {
        const record = records.get(id);
        if (record === undefined || !isLive(record)) continue;
        if (record.state === 'acknowledged') markDelivered(record);
        // The acknowledgement is still owed: it lands as delivered.
        else if (record.state === 'handed') record.reportedDelivered = true;
      }
    },
    /**
     * Takes back a follow-up the run has not taken. One the host still holds is
     * retracted through `retractRunInput`; one the host was never handed, or
     * whose run ended without taking it, is only dropped here. Either way its row
     * leaves the transcript and it is never sent. When the host answers that the
     * run already took it, the row reads as sent instead. Rejects for a
     * follow-up that is already a sent message, and when the host's retraction
     * fails, leaving the row queued.
     */
    remove(messageId: string): Promise<void> {
      const record = records.get(messageId);
      if (record === undefined || record.state === 'delivered' || record.state === 'promoted')
        return Promise.reject(new Error('This follow-up was already sent'));
      record.removing ??= (async () => {
        try {
          // An acknowledgement in flight decides whether the host holds it.
          if (record.state === 'handed') await record.settled.promise.catch(() => undefined);
          const settled = stateOf(record);
          if (settled === 'delivered') return;
          if (settled !== 'acknowledged') {
            drop(record);
            return;
          }
          const answer = await options.retractRunInput?.(record.conversationId, {
            messageId: record.id,
          });
          // Read afresh: the run may have ended while the host answered.
          const now = stateOf(record);
          if (answer === 'delivered') {
            if (now === 'acknowledged') markDelivered(record);
            return;
          }
          // Retracted. The run may have ended meanwhile and left it to be sent as
          // a turn of its own, which waits on this removal: it is dropped all the same.
          if (now !== 'promoted' && now !== 'removed') drop(record);
        } finally {
          delete record.removing;
          // A retraction that failed leaves a follow-up its run did not take still
          // owed as a turn of its own.
          if (stateOf(record) === 'cancelled') void promoteNext();
        }
      })();
      return record.removing;
    },
    /** Forgets a follow-up that became an ordinary turn. */
    forget(messageId: string): void {
      const record = records.get(messageId);
      if (record) record.state = 'promoted';
      records.delete(messageId);
    },
    /**
     * Called when a run has ended (a run parked on an approval has not).
     *
     * The run's outcome and terminal ids are stored on every follow-up handed to
     * the hook, and each is classified once its acknowledgement is known too (see
     * `classify`). A follow-up still waiting for the hook is sent as an ordinary
     * turn, or failed with a retry when the user stopped the run; those go out
     * one at a time, each run ending before the next starts.
     */
    async runEnded(outcome: RunOutcome, terminalIds?: ReadonlySet<string>): Promise<void> {
      if (lifecycle.disposed || lifecycle.running || hasRunInProgress()) return;
      for (const record of records.values()) {
        if ((record.state === 'handed' || record.state === 'acknowledged') && !record.runEnd) {
          record.runEnd = { outcome, terminalIds };
          classify(record);
        }
      }
      if (outcome === 'stopped') {
        for (const record of records.values()) {
          if (record.state !== 'queued' || !isLive(record)) continue;
          markFailed(record);
          record.settled.reject(
            new Error('This follow-up was not delivered: the run was stopped before it was sent'),
          );
        }
      }
      await promoteNext();
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
