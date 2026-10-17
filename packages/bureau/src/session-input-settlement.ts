import type { ConditionalTextValueStore, Mailbox } from '@lostgradient/weft';
import { encodeStorageKeyComponent } from '@lostgradient/weft';

/**
 * COR-1476 — the marker index of sessions that may have open input, and the
 * sweep over it. `session-input-open:v1:{sessionId}` is written by the submit
 * side, with a compare-and-set that gives every write a fresh version, BEFORE
 * the input is admitted, so admitted input is never missing from the index; a
 * crash between the marker and the admission leaves a marker over an empty
 * mailbox, which the sweep removes. Removing a marker is conditional (read its
 * version, read the mailbox, delete only if the mailbox is idle and the version
 * is unchanged), so a marker is never deleted over input admitted after it was
 * read.
 */

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
  /** Visits every marked session and removes the marker of one with nothing open. */
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
 * order and in bounded batches, until none is left or a batch makes no
 * progress. A backlog deeper than one batch is handled in full: `list` cannot
 * be paged, so each batch is re-listed after the last one's commands left the
 * listed states. Commands already in `cancellation-requested` are not listed,
 * because nothing here can move them, so a backlog whose head is a page of
 * them still reaches what waits behind it.
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
   * Removes the marker only if the mailbox has no open input and the marker has
   * not changed since it was read. Losing the delete means the session changed
   * under it, so it decides again from what it reads next.
   */
  async function removeMarkerIfIdle(sessionId: string, mailbox: Mailbox): Promise<boolean> {
    const key = markerKey(sessionId);
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      const raw = await kv.get(key);
      if (raw === null) return true;
      const open = await mailbox.list({ states: OPEN_SESSION_INPUT_STATES, limit: 1 });
      if (open.length > 0) return false;
      if (await kv.conditionalBatch([{ key, expectedValue: raw }], [{ type: 'delete', key }])) {
        return true;
      }
    }
    return false;
  }

  async function sweepSession(sessionId: string): Promise<void> {
    const mailbox = dependencies.mailboxOf(sessionId);
    if (mailbox === undefined || dependencies.isClosed()) return;
    await removeMarkerIfIdle(sessionId, mailbox);
  }

  return {
    markOpen: bumpMarker,
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
