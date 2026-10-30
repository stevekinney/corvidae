/**
 * The status line under the composer.
 *
 * - `waiting`: a tool approval is waiting on the user. With `steers`, a message
 *   sent now goes to the run as input instead of starting a new turn.
 * - `reconnecting`: the transport lost the run's stream and is trying again.
 * - `queued`: follow-ups the user sent are waiting for the run to take them.
 */
export type ChatComposerStatus =
  | { kind: 'waiting'; steers?: boolean }
  | { kind: 'reconnecting'; attempt: number }
  | { kind: 'queued'; count?: number };

/** The words the status line shows for a status. */
export function composerStatusText(status: ChatComposerStatus): string {
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
