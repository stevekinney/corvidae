import type { ConditionalTextValueStore, Mailbox } from '@lostgradient/weft';
import { encodeStorageKeyComponent } from '@lostgradient/weft';

import { walkSessionInputMailbox } from './session-input-durability';

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
 * `session-input-open:v2:{sessionId}:{incarnation}` is the sweep's index of
 * session incarnations that may have open input, one marker per incarnation
 * because each incarnation has its own mailbox. The submit side bumps it, with a compare-and-set that gives
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
 * The boot sweep and the periodic sweep visit every marked incarnation. A
 * current incarnation has its open input cancelled only when
 * `liveSessionRunIdsEverywhere` reports no run at all: input under an orphaned
 * `running` workflow of a dead process stays open until that workflow is
 * recovered (its run then delivers it) or marked terminal. A retired
 * incarnation (its session deleted, or recreated under the same id) has every
 * open input cancelled, and its marker is kept until retention has emptied its
 * mailbox: nothing else maintains a retired mailbox, so without the sweep its
 * terminal records would never retire, one orphaned mailbox per recreation.
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
const CANCELLABLE_SESSION_INPUT_STATES: ReadonlySet<string> = new Set([
  'accepted',
  'available',
  'claimed',
]);

const CAS_ATTEMPTS = 20;

const MARKER_PREFIX = 'session-input-open:v2:';
const markerKey = (sessionId: string, incarnation: string) =>
  `${MARKER_PREFIX}${encodeStorageKeyComponent(sessionId)}:${encodeStorageKeyComponent(incarnation)}`;

interface MarkerRecord {
  readonly sessionId: string;
  readonly incarnation: string;
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
  /** The mailbox of one incarnation of a session. */
  readonly mailboxOf: (sessionId: string, incarnation: string) => Mailbox | undefined;
  /** Whether the bureau is shutting down, when open input is released, never cancelled. */
  readonly isClosed: () => boolean;
  readonly diagnose: (message: string, cause?: unknown) => void;
}

export interface SessionInputSettlement {
  /**
   * Records that the session may have open input, BEFORE the input is admitted,
   * so admitted input is never missing from the sweep's index.
   */
  markOpen(sessionId: string, incarnation: string): Promise<void>;
  /**
   * Runs the mailbox's maintenance, so a lease a dead holder left behind is
   * released and a cancellation it never settled completes, then cancels every
   * open input of the session except the commands in `delivered`, in admission
   * order, with {@link SESSION_INPUT_RUN_ENDED_REASON}, then removes the marker
   * if nothing is left open. The caller has established that no run of the
   * session is live or starting. Returns the cancelled command ids.
   */
  cancelUndelivered(
    sessionId: string,
    incarnation: string,
    delivered: ReadonlySet<string>,
  ): Promise<string[]>;
  /**
   * Visits every marked incarnation: a current one with no live or starting
   * run has its open input cancelled, and its marker removed once nothing is
   * open; a retired one has its open input cancelled, is maintained until
   * retention has emptied its mailbox, and then loses its marker; the rest are
   * left for their runs. Does nothing while the bureau is closing.
   */
  sweep(): Promise<void>;
}

function parseMarker(raw: string | null): MarkerRecord | undefined {
  if (raw === null) return undefined;
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Partial<MarkerRecord>;
  if (
    typeof record.sessionId !== 'string' ||
    typeof record.incarnation !== 'string' ||
    typeof record.version !== 'number'
  ) {
    return undefined;
  }
  return { sessionId: record.sessionId, incarnation: record.incarnation, version: record.version };
}

/**
 * Applies `action` to every cancellable open receipt of a mailbox, in admission
 * order. The walk reads every record the mailbox holds, resumed page by page,
 * because a single listing examines a bounded number of index entries and a
 * session keeps its terminal records for the identity's lifetime: an open
 * command behind more retained entries than one listing reaches would
 * otherwise never be reached by this pass and would wait for its own deadline
 * instead. Commands already in `cancellation-requested` are skipped, because
 * nothing here can move them. Emptiness is still never decided here: that is
 * the mailbox's exhaustive open count, which the marker removal reads.
 */
export async function forEachOpenReceipt(
  mailbox: Mailbox,
  action: (commandId: string) => Promise<unknown>,
): Promise<void> {
  await walkSessionInputMailbox(mailbox, async (receipt) => {
    if (!CANCELLABLE_SESSION_INPUT_STATES.has(receipt.state)) return undefined;
    await action(receipt.commandId);
    return undefined;
  });
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

  async function bumpMarker(sessionId: string, incarnation: string): Promise<void> {
    const key = markerKey(sessionId, incarnation);
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      const raw = await kv.get(key);
      const next: MarkerRecord = {
        sessionId,
        incarnation,
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
    throw new Error(
      `The open-input marker of session "${sessionId}" (incarnation "${incarnation}") kept changing.`,
    );
  }

  /**
   * What makes a mailbox idle enough to lose its marker: for a current
   * incarnation, nothing open (the mailbox's exhaustive open count); for a
   * retired one, no record at all, open or terminal, because the sweep is the
   * only thing that maintains it and its retention sweep must run until the
   * last record is gone. An unfiltered listing of one entry answers the latter
   * exactly: it examines one index entry and is empty only when there is none.
   */
  type Idle = 'nothing-open' | 'no-records';

  /**
   * Removes the marker only if the mailbox is idle and the marker has not
   * changed since it was read. Losing the delete means the marker changed under
   * it, so it decides again from what it reads next. The caller has run the
   * mailbox's maintenance first: a command a gone holder leased stays `claimed`
   * until its visibility lapses, and one whose cancellation that holder never
   * settled stays `cancellation-requested`, so without it a dead lease would
   * hold the marker forever on every path that judges it idle.
   */
  async function removeMarkerOnceMaintained(
    sessionId: string,
    incarnation: string,
    mailbox: Mailbox,
    idle: Idle,
  ): Promise<boolean> {
    const key = markerKey(sessionId, incarnation);
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      const raw = await kv.get(key);
      if (raw === null) return true;
      if (idle === 'nothing-open') {
        const capacity = await mailbox.capacity();
        if (capacity.open > 0) return false;
      } else {
        const any = await mailbox.list({ limit: 1 });
        if (any.length > 0) return false;
      }
      if (await kv.conditionalBatch([{ key, expectedValue: raw }], [{ type: 'delete', key }])) {
        return true;
      }
    }
    return false;
  }

  async function cancelUndelivered(
    sessionId: string,
    incarnation: string,
    delivered: ReadonlySet<string>,
  ): Promise<string[]> {
    const mailbox = dependencies.mailboxOf(sessionId, incarnation);
    if (mailbox === undefined) return [];
    // Maintenance before the cancel pass, so a lease a gone holder left and
    // that has lapsed is cancelled outright rather than merely requested; the
    // marker check then needs no second pass.
    await mailbox.runMaintenance();
    return cancelMaintained(sessionId, incarnation, mailbox, delivered, 'nothing-open');
  }

  /** The cancel pass of {@link cancelUndelivered}, after maintenance has run. */
  async function cancelMaintained(
    sessionId: string,
    incarnation: string,
    mailbox: Mailbox,
    delivered: ReadonlySet<string>,
    idle: Idle,
  ): Promise<string[]> {
    const cancelled = await cancelOpenSessionInput(mailbox, delivered);
    await removeMarkerOnceMaintained(sessionId, incarnation, mailbox, idle);
    return cancelled;
  }

  async function sweepIncarnation(sessionId: string, incarnation: string): Promise<void> {
    const mailbox = dependencies.mailboxOf(sessionId, incarnation);
    if (mailbox === undefined) return;
    const current = await dependencies.incarnationOf(sessionId);
    if (current !== incarnation) {
      // Retired: its session was deleted, or recreated under the same id, and
      // the mailbox is the retired incarnation's own, so whatever is open in it
      // belongs to nobody. Deletion's retirement pass cancelled what it saw;
      // an admission that loaded the old incarnation can commit after that
      // pass, under this marker, and is cancelled here. Maintenance runs on
      // every visit until retention has emptied the mailbox, and only then
      // does the marker go. The cancel walk runs only when the mailbox's
      // exhaustive open count says something is open: a retired mailbox is
      // visited on every sweep for as long as retention keeps its records,
      // and walking those records each time would cost every visit a read of
      // each of them for nothing.
      await mailbox.runMaintenance();
      const { open } = await mailbox.capacity();
      if (open > 0) await cancelOpenSessionInput(mailbox, new Set());
      await removeMarkerOnceMaintained(sessionId, incarnation, mailbox, 'no-records');
      return;
    }
    if (dependencies.isClosed()) return;
    // Maintenance before the liveness check: a run parked past the command
    // timeout keeps the sweep away from its input, so this is where that
    // input's deadline is enforced (dead-lettered, receipt `expired`).
    await mailbox.runMaintenance();
    const live = await dependencies.liveRunIds(sessionId, incarnation);
    // A live run delivers the input at its next boundary, and its end cancels
    // what it never delivered; a starting one is live in a moment.
    if (live.length > 0) return;
    await cancelMaintained(sessionId, incarnation, mailbox, new Set(), 'nothing-open');
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
          await sweepIncarnation(marker.sessionId, marker.incarnation);
        } catch (error) {
          diagnose(`Could not settle the open session input behind marker "${key}".`, error);
        }
      }
    },
  };
}
