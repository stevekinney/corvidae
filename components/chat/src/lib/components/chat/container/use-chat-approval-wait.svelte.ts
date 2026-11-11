import type { ApprovalState } from '@lostgradient/cinder';
import type { Message } from '../conversation-model.ts';
import {
  findPendingApprovalMessageId,
  nextPendingApprovalDeadline,
} from './chat-approval-review.ts';

/** The longest delay a timer takes; a later deadline wakes early and arms the next wait. */
const MAXIMUM_TIMER_DELAY = 2_147_483_647;

type ApprovalWaitOptions = {
  getMessages: () => readonly Message[];
  getApprovalStates: () => ReadonlyMap<string, ApprovalState> | undefined;
};

/**
 * Whether a tool approval waits on the person, and the message that shows it. An approval stops
 * waiting when it is decided here and when its deadline passes, which the card shows as Expired:
 * the helper wakes once at the next deadline, without a host update, so the composer drawer stops
 * saying it waits.
 */
export function useChatApprovalWait(options: ApprovalWaitOptions) {
  let currentTime = $state(Date.now());

  $effect(() => {
    // Read against the time last read at, so a wake before the deadline (a capped delay) arms the
    // next one, and one past it moves on to the deadline after.
    const deadline = nextPendingApprovalDeadline(
      options.getMessages(),
      options.getApprovalStates(),
      currentTime,
    );
    if (deadline === undefined) return;
    const delay = Math.min(Math.max(0, deadline - Date.now()), MAXIMUM_TIMER_DELAY);
    const timer = setTimeout(() => {
      currentTime = Date.now();
    }, delay);
    return () => clearTimeout(timer);
  });

  const messageId = $derived(
    findPendingApprovalMessageId(options.getMessages(), options.getApprovalStates(), currentTime),
  );

  return {
    /** Whether an approval still waits on the person. */
    get waiting(): boolean {
      return messageId !== undefined;
    },
    /** The id of the message that shows the first approval that waits. */
    get messageId(): string | undefined {
      return messageId;
    },
  };
}
