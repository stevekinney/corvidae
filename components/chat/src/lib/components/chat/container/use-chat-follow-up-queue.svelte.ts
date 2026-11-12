import { untrack } from 'svelte';
import type { MessageInput } from '../conversation-model.ts';
import type { ChatAttachment } from '../input/chat-attachment.ts';
import type {
  DiscardedFollowUps,
  FollowUpDiscardReason,
  QueuedFollowUp,
} from './chat-follow-up-queue.ts';

type FollowUpQueueOptions = {
  /** Whether the composer holds follow-ups: the adapter takes run input, and it is not compact. */
  isEnabled: () => boolean;
  /** Whether a run is working, reconnecting or waiting on an approval, so a message would wait. */
  isRunActive: () => boolean;
  /** Whether the transport can accept live input now. */
  isSendNowAvailable?: () => boolean;
  /** The settled outcome of the run that held the queue, when it stopped or failed. */
  getRunOutcome: () => Extract<FollowUpDiscardReason, 'stopped' | 'failed'> | undefined;
  /** The conversation the queue belongs to; a different one empties it. */
  getConversationIdentity: () => string;
  /**
   * Hands a message on: as a new turn when no run works, or as live input to the running run.
   * `onOutcome` hears once whether the hand-off worked.
   */
  submit: (
    message: MessageInput,
    attachments: ChatAttachment[],
    onOutcome?: (succeeded: boolean) => void,
  ) => void;
};

/**
 * Follow-ups typed while a run works wait here, on this page only, until the run finishes; then
 * they go one at a time, each as its own turn, in the order they were typed. Send now instead hands
 * every one to the running run as live input. Stopping the run, or a follow-up whose send fails,
 * sets the rest aside, and Restore brings them back to the composer. Switching conversations
 * empties the queue, because its follow-ups belong to the conversation they were typed in.
 */
export function useChatFollowUpQueue(options: FollowUpQueueOptions) {
  let items = $state<QueuedFollowUp[]>([]);
  let discarded = $state<DiscardedFollowUps | undefined>(undefined);
  // The follow-up sent last whose hand-off has not settled. The next waits for it, because a run
  // that has just been asked for may not read as active yet.
  let flight = $state<symbol | undefined>(undefined);
  let owner = untrack(() => options.getConversationIdentity());
  let nextId = 0;

  $effect(() => {
    const identity = options.getConversationIdentity();
    if (identity === owner) return;
    owner = identity;
    untrack(() => {
      items = [];
      discarded = undefined;
      flight = undefined;
    });
  });

  function dispatch(followUp: QueuedFollowUp): void {
    const token = Symbol(followUp.id);
    flight = token;
    options.submit(followUp.message, [...followUp.attachments], (succeeded) => {
      followUp.onOutcome?.(succeeded);
      if (flight !== token) return;
      flight = undefined;
      if (!succeeded) discard('failed');
    });
  }

  // Once the run has finished, the first follow-up waiting goes as the next turn. The ones behind
  // it wait for that turn in their turn.
  $effect(() => {
    if (options.isRunActive() || flight !== undefined || items.length === 0) return;
    untrack(() => {
      const [head, ...rest] = items;
      if (head === undefined) return;
      const outcome = options.getRunOutcome();
      if (outcome !== undefined) {
        discard(outcome);
        return;
      }
      if (options.isSendNowAvailable !== undefined && !options.isSendNowAvailable()) return;
      items = rest;
      dispatch(head);
    });
  });

  function discard(reason: FollowUpDiscardReason): void {
    if (items.length === 0) return;
    discarded = { reason, items };
    items = [];
  }

  return {
    /** The follow-ups waiting, in the order they were typed. */
    get items(): readonly QueuedFollowUp[] {
      return items;
    },
    /** The follow-ups set aside when the run stopped or a send failed, until Restore or Dismiss. */
    get discarded(): DiscardedFollowUps | undefined {
      return discarded;
    },
    /** Whether a message the composer submits now waits here instead of being sent. */
    get holding(): boolean {
      return options.isEnabled() && options.isRunActive();
    },
    /** Whether Send now instead can hand the waiting follow-ups to the running run. */
    get canSendNow(): boolean {
      return (
        options.isEnabled() &&
        options.isRunActive() &&
        (options.isSendNowAvailable?.() ?? true) &&
        items.length > 0
      );
    },
    /** Adds a follow-up at the end of the queue. */
    enqueue(
      message: MessageInput,
      attachments: readonly ChatAttachment[],
      onOutcome?: (succeeded: boolean) => void,
    ): void {
      nextId += 1;
      items = [...items, { id: `follow-up-${nextId}`, message, attachments, onOutcome }];
    },
    /** Takes a follow-up out of the queue and answers it, for Edit; `undefined` if it is gone. */
    take(id: string): QueuedFollowUp | undefined {
      const followUp = items.find((item) => item.id === id);
      if (followUp !== undefined) items = items.filter((item) => item.id !== id);
      return followUp;
    },
    /** Hands every waiting follow-up to the running run as live input, in order. */
    sendNow(): void {
      if (
        !options.isEnabled() ||
        !options.isRunActive() ||
        (options.isSendNowAvailable !== undefined && !options.isSendNowAvailable())
      )
        return;
      const waiting = items;
      items = [];
      for (const followUp of waiting) {
        options.submit(followUp.message, [...followUp.attachments], followUp.onOutcome);
      }
    },
    /** Sets the waiting follow-ups aside, so they are not sent when the run ends. */
    discard,
    /** Answers the follow-ups set aside and forgets them, for Restore. */
    restore(): readonly QueuedFollowUp[] {
      const restored = discarded?.items ?? [];
      discarded = undefined;
      return restored;
    },
    /** Forgets the follow-ups set aside. */
    dismiss(): void {
      discarded = undefined;
    },
  };
}
