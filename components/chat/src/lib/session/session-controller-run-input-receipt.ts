/** The receipt states under which a host accepted a follow-up. */
const ACCEPTED_RECEIPT_STATES: ReadonlySet<string> = new Set(['accepted', 'queued', 'promoted']);

/**
 * Turns an input's receipt into the acknowledgement `sendRunInput` owes the
 * controller: it returns when the receipt is `accepted`, `queued`, or
 * `promoted`, and throws an error that names the state for any other.
 *
 * Read the receipt the host returns, not the submission outcome. A `replayed`
 * submission of an input that was already cancelled carries a `canceled`
 * receipt, and an immediate self-cancel when no run is live returns one too;
 * both must reject so the row is marked failed with a retry. Admission alone
 * is not enough, because the host cancels input the run ends without
 * delivering.
 */
export function assertRunInputAccepted(receipt: { readonly state: string }): void {
  if (!ACCEPTED_RECEIPT_STATES.has(receipt.state))
    throw new Error(`Run input was not accepted: its receipt is ${receipt.state}`);
}
