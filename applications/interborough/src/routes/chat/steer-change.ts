/**
 * One change to a session's settings through `bureau.contexts.steer`, shared by the model picker and
 * the effort and permission selects, so the three end every way a request can end in the same way:
 *
 * - Admitted, including an exact replay of the same command: the change stands, and the session is
 *   read again so the page agrees with the Bureau.
 * - Refused because the session changed since it was read: the session is read again and the
 *   control shows the setting it has now.
 * - Any other refusal: the previous setting comes back, and the notice says why.
 * - A fault: nobody knows whether the Bureau took the change, so the session is read again, and the
 *   command keeps its identifier so a retry is the same command and is not applied twice
 *   (`pending-command-key.ts`).
 */
import { steerRefusalReason, type SteerOutcome } from '../../lib/bureau-client.ts';
import type { PendingCommandKey } from '../../lib/pending-command-key.ts';

/** What a refused or failed change says, in the words of the setting it changes. */
export interface SteerNotices {
  /** The Bureau's own count of the chat's changes was behind: the chat was changed somewhere else. */
  readonly staleRevision: string;
  /** The agent or the deployment does not allow that value. */
  readonly denied: string;
  /** The chat is over, so it takes no change. */
  readonly sessionTerminal: string;
  /** The agent cannot change this setting. */
  readonly unsupportedCapability: string;
  /** Anything else the Bureau answered without changing the setting, such as a Bureau that is closing. */
  readonly notChanged: string;
  /** The request itself failed, so nobody knows whether the Bureau took it. */
  readonly fault: string;
}

/** How a change ended. */
export interface SteerResult {
  /** Whether the Bureau took the change. */
  readonly applied: boolean;
  /** Why it did not take, when it did not. */
  readonly notice?: string;
  /** Whether the session was read again afterwards; the choice stays on screen until it was. */
  readonly reloaded: boolean;
}

/** What a refusal outcome says. */
function refusalNotice(outcome: SteerOutcome, notices: SteerNotices): string {
  switch (outcome.outcome) {
    case 'rejected':
      switch (outcome.failure.reason) {
        case 'stale-revision':
          return notices.staleRevision;
        case 'model-not-allowed':
        case 'policy-denied':
          return notices.denied;
        case 'session-terminal':
          return notices.sessionTerminal;
        default:
          return notices.notChanged;
      }
    case 'session-terminal':
      return notices.sessionTerminal;
    case 'unsupported-capability':
      return notices.unsupportedCapability;
    default:
      return notices.notChanged;
  }
}

/**
 * Sends one change and settles it. `scope` and `content` key the command (`commands.keyFor`), `send`
 * makes the request under that key, and `reload` reads the session again and says whether it could.
 */
export async function changeSetting(options: {
  readonly commands: PendingCommandKey;
  readonly scope: string;
  readonly content: string;
  readonly send: (commandId: string) => Promise<SteerOutcome>;
  readonly reload: () => Promise<boolean>;
  readonly notices: SteerNotices;
}): Promise<SteerResult> {
  const { commands, scope, content, send, reload, notices } = options;
  try {
    const outcome = await send(commands.keyFor(scope, content));
    // The Bureau answered, so the command is settled whatever it said.
    commands.confirmed();
    if (outcome.outcome === 'accepted' || outcome.outcome === 'replayed') {
      return { applied: true, reloaded: await reload() };
    }
    const notice = refusalNotice(outcome, notices);
    const stale = outcome.outcome === 'rejected' && outcome.failure.reason === 'stale-revision';
    return { applied: false, notice, reloaded: stale ? await reload() : false };
  } catch (error) {
    const reason = steerRefusalReason(error);
    if (reason !== undefined) {
      // The Bureau refused the request itself: it is settled, with a reason of its own.
      commands.confirmed();
      return { applied: false, notice: reason, reloaded: false };
    }
    // Nobody knows whether the Bureau took it, so the command keeps its identifier for a retry,
    // and the session is read again to show the setting it has now.
    return { applied: false, notice: notices.fault, reloaded: await reload() };
  }
}
