/**
 * The inline push install a send owes (COR-1543). Whether a send owes one, and where its
 * checkpoint starts, is decided once, at admission, and recorded in the send's ledger claim; a
 * retry reads it back from the claim. The single completion helper refuses to complete an entry
 * that owes an install the send has not confirmed, so no path can complete a receipt while
 * silently skipping the install.
 *
 * @module a2a-push-install-claim
 */

/** What a send's claim records about its inline push configuration. */
export type OwedInstall = {
  /** Whether the send must install its inline configuration before it may complete. */
  readonly pushOwed: boolean;
  /** Where the installed configuration's checkpoint starts; `'-1'` is before the first event. */
  readonly pushCursor: string;
};

/** What decides the install a send owes. */
export type OwedInstallInput = {
  readonly hasInline: boolean;
  /** Whether the send continues an existing task. */
  readonly continuing: boolean;
  /** Whether its deadline had passed at admission. */
  readonly expired: boolean;
  /** The claim an earlier attempt left pending, which decides for a retry. */
  readonly pending:
    | { readonly pushOwed?: boolean | undefined; readonly pushCursor?: string | undefined }
    | undefined;
  /** The cursor after the last event the continued task holds now. */
  readonly tail: string | undefined;
};

/**
 * The install a send owes, or `undefined` when it carries no inline configuration. A retry of a
 * pending claim follows the claim. Otherwise every path owes the install except an expired
 * continuation, which applies no input and leaves the task as it is.
 */
export function owedInstallOf(input: OwedInstallInput): OwedInstall | undefined {
  if (!input.hasInline) return undefined;
  const { pending } = input;
  if (pending?.pushOwed !== undefined) {
    return { pushOwed: pending.pushOwed, pushCursor: pending.pushCursor ?? '-1' };
  }
  const pushOwed = !(input.expired && input.continuing);
  return { pushOwed, pushCursor: input.continuing ? (input.tail ?? '-1') : '-1' };
}

/** A ledger that completes entries. */
type Completing<Entry, Result> = {
  complete(entry: Entry, result: Result): Promise<unknown>;
};

/**
 * The only way a send completes its ledger entry: an entry that owes an install completes only
 * once the install is confirmed.
 *
 * @throws {Error} When the claim owes an install that has not been confirmed.
 */
export async function completeSend<Entry, Result>(
  ledger: Completing<Entry, Result>,
  entry: Entry,
  result: Result,
  owed: OwedInstall | undefined,
  installed: boolean,
): Promise<void> {
  if (owed?.pushOwed === true && !installed) {
    throw new Error('A send cannot complete before the push configuration it owes is installed.');
  }
  await ledger.complete(entry, result);
}
