/**
 * The one message a page hands to the new chat it opens. Home's Start a chat has a message and an
 * agent and opens New chat; New chat sends the message as the chat's first, once. It travels in the
 * page's own memory and not in the address, so no link can start a run: an address that names a
 * message would send it to whoever opened it, spending the model and running tools with no one
 * pressing Send. It is for the agent it names, it is taken once, and it goes stale after a few
 * seconds, so a chat opened later by hand never sends something typed earlier.
 */

/** How long a handed-over message is good for: the navigation it belongs to takes far less. */
export const HANDOFF_WINDOW_MILLISECONDS = 10_000;

interface PendingFirstMessage {
  readonly agent: string;
  readonly message: string;
  /** `performance.now()` when it was handed over, which a test's fixed `Date` does not move. */
  readonly at: number;
}

let pending: PendingFirstMessage | undefined;

/** Hands `message` to the next new chat with `agent`. A blank message hands nothing, and a second handoff replaces the first. */
export function handOffFirstMessage(agent: string, message: string): void {
  const text = message.trim();
  pending = text === '' ? undefined : { agent, message: text, at: performance.now() };
}

/**
 * The message handed over for a new chat with `agent`, taken so it is sent once; `undefined` when
 * none is waiting, when it is for another agent, or when it has gone stale. A handoff for another
 * agent is left for the chat that is, unless it has gone stale, when it is dropped.
 */
export function takeFirstMessage(agent: string): string | undefined {
  if (pending === undefined) return undefined;
  if (performance.now() - pending.at > HANDOFF_WINDOW_MILLISECONDS) {
    pending = undefined;
    return undefined;
  }
  if (pending.agent !== agent) return undefined;
  const { message } = pending;
  pending = undefined;
  return message;
}
