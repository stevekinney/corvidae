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
 * - `blocked`: sending is not possible, so the composer is replaced by one compact row that says
 *   why, with an optional button and an optional quiet link beside it. There is no text box.
 */
export type ChatComposerStatus =
  | { kind: 'waiting'; steers?: boolean }
  | { kind: 'steering' }
  | { kind: 'note'; text: string }
  | { kind: 'reconnecting'; attempt: number }
  | { kind: 'queued'; count?: number }
  | {
      kind: 'blocked';
      /** Why the composer is replaced, in a sentence: `Connect a model provider to chat`. */
      reason: string;
      /** The one thing to do about it, drawn as a secondary button (or a link with `href`). */
      action?: ChatComposerBlockedAction | undefined;
      /** A second, quieter way out drawn as a link beside the action, such as `Use Assistant`. */
      link?: ChatComposerBlockedAction | undefined;
    };

/** The words the status line shows for a status. */
export function composerStatusText(status: ChatComposerStatus): string {
  if (status.kind === 'blocked') return status.reason;
  if (status.kind === 'steering') return 'A message now steers the run.';
  if (status.kind === 'note') return status.text;
  if (status.kind === 'waiting') {
    return status.steers
      ? 'Waiting for your approval · a message now steers the run'
      : 'Waiting for your approval';
  }
  if (status.kind === 'reconnecting') {
    const attempt = Math.max(1, Math.trunc(status.attempt));
    return `Reconnecting… attempt ${attempt}`;
  }
  const count = Math.max(1, Math.trunc(status.count ?? 1));
  return count === 1
    ? 'Follow-up queued · sends when the run is ready'
    : `${count} follow-ups queued · they send when the run is ready`;
}
