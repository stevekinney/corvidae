import type { MessageInput } from '../conversation-model.ts';
import type { ChatAttachment } from '../input/chat-attachment.ts';

/**
 * A follow-up typed while a run works. It waits in the composer's Up next drawer, on this page
 * only, until the run finishes; Send now instead hands it to the run as live input.
 */
export interface QueuedFollowUp {
  /** Keys the follow-up's row in the drawer. */
  readonly id: string;
  /** The message as the composer submitted it, quoted excerpts included. */
  readonly message: MessageInput;
  /** The ready attachments the composer submitted with it. */
  readonly attachments: readonly ChatAttachment[];
  /** Told once whether the hand-off worked, when the follow-up is finally sent. */
  readonly onOutcome?: ((succeeded: boolean) => void) | undefined;
}

/** Why queued follow-ups were set aside instead of sent. */
export type FollowUpDiscardReason = 'stopped' | 'failed';

/** Follow-ups set aside when the run was stopped or a send failed, which Restore brings back. */
export interface DiscardedFollowUps {
  readonly reason: FollowUpDiscardReason;
  readonly items: readonly QueuedFollowUp[];
}

/** The Up next drawer's title. */
export const FOLLOW_UP_DRAWER_TITLE = 'Up next';

/** The action that hands the queued follow-ups to the running run now, as live input. */
export const FOLLOW_UP_SEND_NOW_LABEL = 'Send now instead';

/** The discard drawer's action, which puts the follow-ups back in the composer. */
export const FOLLOW_UP_RESTORE_LABEL = 'Restore';

/** The discard drawer's quiet way out, which forgets the follow-ups. */
export const FOLLOW_UP_DISMISS_LABEL = 'Dismiss';

/** What the Up next drawer says beside its title: how many wait, and when they go. */
export function followUpQueueSummary(count: number): string {
  return `${count} queued, sends when this run finishes`;
}

/** What the discard drawer says: why the queued follow-ups were not sent. */
export function followUpDiscardText(count: number, reason: FollowUpDiscardReason): string {
  const cause = reason === 'stopped' ? 'The run was stopped' : 'The run failed';
  return count === 1
    ? `${cause}, so your queued follow-up was not sent.`
    : `${cause}, so your ${count} queued follow-ups were not sent.`;
}

/** The text of a queued follow-up as its row shows it: its words, or what it carries. */
export function followUpPreview(followUp: QueuedFollowUp): string {
  const content = followUp.message.content;
  const text = typeof content === 'string' ? content.trim() : '';
  if (text !== '') return text;
  const count = followUp.attachments.length;
  return count === 1 ? '1 attachment' : `${count} attachments`;
}

/** The words of a queued follow-up, which Edit and Restore put back in the composer. */
export function followUpText(followUp: QueuedFollowUp): string {
  const content = followUp.message.content;
  return typeof content === 'string' ? content : '';
}

/**
 * The composer's draft with `texts` added after it: each text is a paragraph of its own, so
 * restored follow-ups never run into what is already typed. Empty texts are left out.
 */
export function appendToDraft(draft: string, texts: readonly string[]): string {
  const parts = [draft.trimEnd(), ...texts.map((text) => text.trim())].filter(
    (part) => part !== '',
  );
  return parts.join('\n\n');
}
