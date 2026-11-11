/**
 * An action in the blocked row: a button or a quiet link that does something or goes somewhere.
 * With `href` it is a link; otherwise it is a button that calls `onclick`.
 */
export interface ChatComposerBlockedAction {
  /** What the action says, such as `Connect a provider`. */
  readonly label: string;
  /** Where a link goes. When omitted the action is a button. */
  readonly href?: string | undefined;
  /** Called when the action is activated. A link may also pass one, for client-side navigation. */
  readonly onclick?: (() => void) | undefined;
  /**
   * Draws the action as the row's one primary button instead of a secondary one. Use it when the
   * action is the way out of the state, such as `Connect provider` or `Unarchive`. Default `false`.
   */
  readonly primary?: boolean | undefined;
}

/**
 * The line under the composer, or the whole composer.
 *
 * - `waiting`: a tool approval is waiting on the user. With `steers`, a message
 *   sent now goes to the run as input instead of starting a new turn.
 * - `steering`: the chat is working, so a message sent now steers the run.
 * - `note`: a sentence of the host's own, such as when a changed setting applies.
 * - `reconnecting`: the transport lost the run's stream and is trying again.
 * - `queued`: follow-ups the user sent are waiting for the run to take them.
 * - `offline`: the browser has no connection. A warning drawer above the composer says the draft is
 *   kept, and Send is off (and names the drawer through `aria-describedby`) until it clears.
 * - `draft-restored`: the host put back a draft the person had not sent. A neutral drawer above the
 *   composer says when it is from, with Discard draft, which empties the composer and calls
 *   `ondiscard`.
 * - `blocked`: sending is not possible, so the composer is replaced by one compact row that says
 *   why, with an optional button and an optional quiet link beside it. There is no text box.
 * - `archived`: the chat was archived. The composer is replaced by one neutral bar (no warning
 *   colour) with an archive icon, `Archived <when>`, an optional secondary action such as New chat
 *   and an optional primary action such as Unarchive.
 * - `read-only`: the person can read the chat but not write to it, such as after access was
 *   revoked. The composer is replaced by one neutral bar with a lock, the words `Read only` with a
 *   tooltip that can name who granted the access, and an optional primary action such as Request
 *   access.
 */
export type ChatComposerStatus =
  | { kind: 'waiting'; steers?: boolean }
  | { kind: 'steering' }
  | { kind: 'note'; text: string }
  | { kind: 'reconnecting'; attempt: number }
  | { kind: 'queued'; count?: number }
  | { kind: 'offline' }
  | {
      kind: 'draft-restored';
      /** When the draft was written, in words, such as `yesterday at 4:12 PM`. */
      when: string;
      /** Called after Discard draft has emptied the composer, so the host can forget the draft. */
      ondiscard?: (() => void) | undefined;
    }
  | {
      kind: 'blocked';
      /** Why the composer is replaced, in a sentence: `Connect a model provider to chat`. */
      reason: string;
      /** The one thing to do about it, drawn as a secondary button (or a link with `href`). */
      action?: ChatComposerBlockedAction | undefined;
      /** A second, quieter way out drawn as a link beside the action, such as `Use Assistant`. */
      link?: ChatComposerBlockedAction | undefined;
    }
  | {
      kind: 'archived';
      /** When the chat was archived, in words, such as `Nov 3`. The bar reads `Archived <when>`. */
      when: string;
      /** The quieter way out, drawn as a secondary button on the left, such as `New chat`. */
      newChat?: ChatComposerBlockedAction | undefined;
      /** The way back, drawn as the primary button on the right, such as `Unarchive`. */
      unarchive?: ChatComposerBlockedAction | undefined;
    }
  | {
      kind: 'read-only';
      /**
       * What the `Read only` tooltip says, such as `Dana Reyes removed your write access on Nov 3`.
       * Without it the words carry no tooltip.
       */
      tooltip?: string | undefined;
      /** The way to ask for write access again, drawn as the primary button, such as `Request access`. */
      request?: ChatComposerBlockedAction | undefined;
    };

/** The words of the neutral bar a read-only chat draws in place of its composer. */
export const COMPOSER_READ_ONLY_LABEL = 'Read only';

/** What the offline drawer says: the draft is kept, and Send comes back with the connection. */
export const COMPOSER_OFFLINE_TEXT =
  "You're offline. Your draft is saved here, and Send comes back when you reconnect.";

/** The action of the draft-restored drawer: it empties the composer. */
export const COMPOSER_DISCARD_DRAFT_LABEL = 'Discard draft';

/** Whether a status replaces the composer with a neutral bar (archived, read only). */
export function isComposerNoticeStatus(
  status: ChatComposerStatus | undefined,
): status is Extract<ChatComposerStatus, { kind: 'archived' | 'read-only' }> {
  return status?.kind === 'archived' || status?.kind === 'read-only';
}

/** Whether a status is drawn as a drawer above the composer rather than the line under it. */
export function isComposerDrawerStatus(
  status: ChatComposerStatus | undefined,
): status is Extract<ChatComposerStatus, { kind: 'offline' | 'draft-restored' }> {
  return status?.kind === 'offline' || status?.kind === 'draft-restored';
}

/** The words a status shows: on the line under the composer, or in its drawer. */
export function composerStatusText(status: ChatComposerStatus): string {
  if (status.kind === 'blocked') return status.reason;
  if (status.kind === 'archived') return `Archived ${status.when}`;
  if (status.kind === 'read-only') return COMPOSER_READ_ONLY_LABEL;
  if (status.kind === 'offline') return COMPOSER_OFFLINE_TEXT;
  if (status.kind === 'draft-restored') return `Restored your unsent draft from ${status.when}.`;
  if (status.kind === 'steering') return 'A message now steers the run.';
  if (status.kind === 'note') return status.text;
  if (status.kind === 'waiting') {
    return status.steers
      ? 'Waiting for your approval. A message now steers the run.'
      : 'Waiting for your approval';
  }
  if (status.kind === 'reconnecting') {
    const attempt = Math.max(1, Math.trunc(status.attempt));
    return `Reconnecting… attempt ${attempt}`;
  }
  const count = Math.max(1, Math.trunc(status.count ?? 1));
  return count === 1
    ? 'Follow-up queued until the run is ready'
    : `${count} follow-ups queued until the run is ready`;
}
