/**
 * The idempotency key of a command that may have been applied without its response arriving.
 *
 * `bureau.tasks.respond` makes a command idempotent by its `messageId`: an exact retry returns the
 * original receipt and resolves nothing again. A client that mints a new key for a retry takes that
 * protection away. When the Bureau applied an answer and the response was lost, the retry would be
 * a second command, and if the task had parked again on the same signal by then, the stale answer
 * would be applied to the later wait.
 *
 * So one key stays with the pending command: every retry of the same command reuses it. A new key
 * is minted only for a command that differs (a different scope or a different answer), and after a
 * response that confirms the command, which ends it.
 */
export class PendingCommandKey {
  #pending: { readonly scope: string; readonly content: string; readonly key: string } | undefined;

  /** The key for sending `content` under `scope`: the pending one for the same command, else a new one. */
  keyFor(scope: string, content: string): string {
    if (this.#pending?.scope === scope && this.#pending.content === content) {
      return this.#pending.key;
    }
    const key = crypto.randomUUID();
    this.#pending = { scope, content, key };
    return key;
  }

  /** The command was confirmed by a response, so the next one is a new command. */
  confirmed(): void {
    this.#pending = undefined;
  }
}
