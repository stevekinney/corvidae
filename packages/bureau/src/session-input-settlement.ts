import type { ConditionalTextValueStore, Mailbox } from '@lostgradient/weft';
import { encodeStorageKeyComponent } from '@lostgradient/weft';

/**
 * COR-1476 — what becomes of session input that no run delivered. Bureau never
 * starts a run to answer input: an input a live run's step boundary appends to
 * its conversation ends `promoted`, and one that is still open when its run
 * ends is cancelled, so the client learns it was not delivered and resends it.
 *
 * ## Who cancels, and when
 *
 * The run that ends does the cancelling, in `create-bureau.ts`'s run-end path:
 * it first makes itself not live (its steering `run-ended` entry, retried until
 * it is acknowledged), then catches up steering, reads the session's liveness
 * without itself, and, when no other run is live or starting, cancels every
 * open input whose turn is not in its checkpoint transcript. With another run
 * live, it only releases what it held: that run's end cancels what is left.
 *
 * `submitSessionInput` runs the mirror image: it writes the marker below, commits
 * the admission, writes the marker again, catches up steering, and reads
 * liveness; with no run live or starting it cancels its own input and returns
 * the re-read receipt. The two
 * orderings make one side always see the other: the ending run reads the mailbox
 * only after its not-live write is acknowledged, and the submit side reads
 * liveness only after its admission committed, so an input admitted before the
 * run's mailbox read is cancelled by the run, and one admitted after it finds no
 * live run and cancels itself.
 *
 * ## The marker, and the sweep behind it
 *
 * `session-input-open:v1:{sessionId}` is the sweep's index of sessions that may
 * have open input. The submit side bumps it, with a compare-and-set that gives
 * every write a fresh version, BEFORE it admits, so admitted input is never
 * missing from the index, and again AFTER the admission commits; a crash between
 * the first bump and the admission leaves a marker over an empty mailbox, which
 * the sweep removes. Removing a marker is conditional (read its version, read
 * the mailbox's open count, delete only if nothing is open and the version is
 * unchanged), but that alone does not protect input admitted between the
 * remover's two reads and its delete: the remover then deletes the bumped marker
 * over a mailbox that just became non-empty. The second bump is what closes
 * that window. The open count is the mailbox's own exhaustive counter, not a
 * listing, because a listing stops at a scan ceiling and an empty page does not
 * prove an empty mailbox.
 *
 * The boot sweep and the periodic sweep visit every marked session and cancel
 * its open input only when `liveSessionRunIdsEverywhere` reports no run at all:
 * input under an orphaned `running` workflow of a dead process stays open until
 * that workflow is recovered (its run then delivers it) or marked terminal.
 */

/** The cancellation reason of input that was still open when its run ended. */
export const SESSION_INPUT_RUN_ENDED_REASON = 'the run ended before the input was delivered';

/** Non-terminal mailbox states: what counts as open input. */
export const OPEN_SESSION_INPUT_STATES = [
  'accepted',
  'available',
  'claimed',
  'cancellation-requested',
] as const;

/**
 * The open states a cancellation request can still move: an unclaimed command
 * is cancelled outright, and a claimed one moves to `cancellation-requested`,
 * which no request changes again, so a page of those would never shrink.
 */
const CANCELLABLE_SESSION_INPUT_STATES = ['accepted', 'available', 'claimed'] as const;

const CAS_ATTEMPTS = 20;

/** How many open receipts one batch of a backlog operation handles. */
export const SESSION_INPUT_BACKLOG_BATCH = 100;

const MARKER_PREFIX = 'session-input-open:v1:';
const markerKey = (sessionId: string) => `${MARKER_PREFIX}${encodeStorageKeyComponent(sessionId)}`;

interface MarkerRecord {
  readonly sessionId: string;
  readonly version: number;
}

export interface SessionInputSettlementDependencies {
  readonly kv: ConditionalTextValueStore;
  /** The session's current incarnation, or `undefined` when it no longer exists. */
  readonly incarnationOf: (sessionId: string) => Promise<string | undefined>;
  /**
   * The session incarnation's live and starting runs in every process, read
   * after the steering log has been caught up, so a run whose `run-ended`
   * another process wrote is not counted.
   */
  readonly liveRunIds: (sessionId: string, incarnation: string) => Promise<readonly string[]>;
  readonly mailboxOf: (sessionId: string) => Mailbox | undefined;
  /** Whether the bureau is shutting down, when open input is released, never cancelled. */
  readonly isClosed: () => boolean;
  readonly diagnose: (message: string, cause?: unknown) => void;
}

export interface SessionInputSettlement {
  /**
   * Records that the session may have open input, BEFORE the input is admitted,
   * so admitted input is never missing from the sweep's index.
   */
  markOpen(sessionId: string): Promise<void>;
  /**
   * Runs the mailbox's maintenance, so a lease a dead holder left behind is
   * released and a cancellation it never settled completes, then cancels every
   * open input of the session except the commands in `delivered`, in admission
   * order, with {@link SESSION_INPUT_RUN_ENDED_REASON}, then removes the marker
   * if nothing is left open. The caller has established that no run of the
   * session is live or starting. Returns the cancelled command ids.
   */
  cancelUndelivered(sessionId: string, delivered: ReadonlySet<string>): Promise<string[]>;
  /**
   * Visits every marked session: one with no live or starting run has its open
   * input cancelled; one whose session is gone has its marker removed; the rest
   * are left for their runs. Does nothing while the bureau is closing.
   */
  sweep(): Promise<void>;
}

function parseMarker(raw: string | null): MarkerRecord | undefined {
  if (raw === null) return undefined;
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Partial<MarkerRecord>;
  if (typeof record.sessionId !== 'string' || typeof record.version !== 'number') return undefined;
  return { sessionId: record.sessionId, version: record.version };
}

/**
 * Applies `action` to every cancellable open receipt of a mailbox, in admission
 * order and in bounded batches, until none is listed or a batch makes no
 * progress. A backlog deeper than one batch is handled in full: `list` cannot
 * be paged, so each batch is re-listed after the last one's commands left the
 * listed states. Commands already in `cancellation-requested` are not listed,
 * because nothing here can move them, so a backlog whose head is a page of
 * them still reaches what waits behind it. A listing walks at most a fixed
 * number of index entries (`Mailbox`'s scan ceiling), so an empty page is not
 * proof that nothing is open: that decision belongs to the mailbox's exhaustive
 * open count, which the marker removal reads, and a command the listing could
 * not reach stays open, with its marker, for a later pass.
 */
export async function forEachOpenReceipt(
  mailbox: Mailbox,
  action: (commandId: string) => Promise<unknown>,
): Promise<void> {
  const handled = new Set<string>();
  for (;;) {
    const batch = await mailbox.list({
      states: CANCELLABLE_SESSION_INPUT_STATES,
      limit: SESSION_INPUT_BACKLOG_BATCH,
    });
    const fresh = batch.filter((receipt) => !handled.has(receipt.commandId));
    if (fresh.length === 0) return;
    for (const receipt of fresh) {
      handled.add(receipt.commandId);
      await action(receipt.commandId);
    }
  }
}

/**
 * Cancels every cancellable open command of `mailbox` that is not in `keep`,
 * with {@link SESSION_INPUT_RUN_ENDED_REASON}, in admission order. Returns the
 * ids it cancelled.
 */
export async function cancelOpenSessionInput(
  mailbox: Mailbox,
  keep: ReadonlySet<string>,
): Promise<string[]> {
  const cancelled: string[] = [];
  await forEachOpenReceipt(mailbox, async (commandId) => {
    if (keep.has(commandId)) return;
    await mailbox.requestCancellation({ commandId, reason: SESSION_INPUT_RUN_ENDED_REASON });
    cancelled.push(commandId);
  });
  return cancelled;
}

export function createSessionInputSettlement(
  dependencies: SessionInputSettlementDependencies,
): SessionInputSettlement {
  const { kv, diagnose } = dependencies;

  async function bumpMarker(sessionId: string): Promise<void> {
    const key = markerKey(sessionId);
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      const raw = await kv.get(key);
      const next: MarkerRecord = {
        sessionId,
        version: (parseMarker(raw)?.version ?? 0) + 1,
      };
      if (
        await kv.conditionalBatch(
          [{ key, expectedValue: raw }],
          [{ type: 'set', key, value: JSON.stringify(next) }],
        )
      ) {
        return;
      }
    }
    throw new Error(`The open-input marker of session "${sessionId}" kept changing.`);
  }

  /**
   * Removes the marker only if the mailbox's exhaustive open count is zero and
   * the marker has not changed since it was read. Losing the delete means the
   * session changed under it, so it decides again from what it reads next.
   */
  async function removeMarkerIfIdle(sessionId: string, mailbox: Mailbox): Promise<boolean> {
    const key = markerKey(sessionId);
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      const raw = await kv.get(key);
      if (raw === null) return true;
      const capacity = await mailbox.capacity();
      if (capacity.open > 0) return false;
      if (await kv.conditionalBatch([{ key, expectedValue: raw }], [{ type: 'delete', key }])) {
        return true;
      }
    }
    return false;
  }

  async function cancelUndelivered(
    sessionId: string,
    delivered: ReadonlySet<string>,
  ): Promise<string[]> {
    const mailbox = dependencies.mailboxOf(sessionId);
    if (mailbox === undefined) return [];
    // A command a gone holder leased stays `claimed` until its visibility
    // lapses, and one whose cancellation that holder never settled stays
    // `cancellation-requested`; maintenance moves both on, so the next lines
    // can cancel the first and the marker can clear once the second is over.
    await mailbox.runMaintenance();
    const cancelled = await cancelOpenSessionInput(mailbox, delivered);
    await removeMarkerIfIdle(sessionId, mailbox);
    return cancelled;
  }

  async function sweepSession(sessionId: string): Promise<void> {
    const incarnation = await dependencies.incarnationOf(sessionId);
    const mailbox = dependencies.mailboxOf(sessionId);
    if (incarnation === undefined) {
      // Deleting the session retired its input; only the marker is left.
      if (mailbox !== undefined) await removeMarkerIfIdle(sessionId, mailbox);
      return;
    }
    if (mailbox === undefined || dependencies.isClosed()) return;
    const live = await dependencies.liveRunIds(sessionId, incarnation);
    // A live run delivers the input at its next boundary, and its end cancels
    // what it never delivered; a starting one is live in a moment.
    if (live.length > 0) return;
    await cancelUndelivered(sessionId, new Set());
  }

  return {
    markOpen: bumpMarker,
    cancelUndelivered,
    async sweep() {
      if (dependencies.isClosed()) return;
      for (const key of await kv.list(MARKER_PREFIX)) {
        try {
          const marker = parseMarker(await kv.get(key));
          if (marker === undefined) continue;
          await sweepSession(marker.sessionId);
        } catch (error) {
          diagnose(`Could not settle the open session input behind marker "${key}".`, error);
        }
      }
    },
  };
}
