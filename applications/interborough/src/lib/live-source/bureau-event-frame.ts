/**
 * The wire shape of `bureau.events` as the browser reads it (COR-1722), apart from the source that
 * opens the connection so the cache layer can name its kinds without loading the source.
 */

/** One envelope of `bureau.events`: the wire shape `bureauEventEnvelopeSchema` (`@lostgradient/bureau`) describes. */
export interface BureauEventFrame {
  readonly kind: string;
  readonly sequence: number;
  readonly cursor: string;
  readonly emittedAtMs: number;
  readonly payload: unknown;
  /** The plugin whose contribution caused the event; absent for an event from Bureau core. */
  readonly source?: string;
}

/** The kind the feed gives the envelope that reports a cursor it can no longer resume from. */
export const BUREAU_GAP_KIND = 'feed.gap';

/** The kind the feed gives the marker that reports this reader fell behind and frames were skipped. */
export const BUREAU_FRAMES_DROPPED_KIND = 'frames.dropped';

/**
 * The kind of the frame this source dispatches once when a replay it held back ends. It is not on
 * the wire: it says "what was published while this page was not listening is not known".
 */
export const BUREAU_RESYNC_KIND = 'feed.resync';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Whether a `ping` frame's data is the `replayComplete` marker that ends a replay. */
export function isReplayCompletePing(data: string): boolean {
  const parsed = parseJson(data);
  return isRecord(parsed) && parsed['replayComplete'] === true;
}

/** Parses one frame's `data:` into an envelope, or `null` when it is not one. */
export function parseBureauEventFrame(data: string): BureauEventFrame | null {
  const parsed = parseJson(data);
  if (!isRecord(parsed)) return null;
  const kind = parsed['kind'];
  const cursor = parsed['cursor'];
  const sequence = finiteNumber(parsed['sequence']);
  const emittedAtMs = finiteNumber(parsed['emittedAtMs']);
  if (typeof kind !== 'string' || typeof cursor !== 'string') return null;
  if (sequence === null || emittedAtMs === null) return null;
  // `source` is the envelope's own field, apart from the payload; a core event has none.
  const source = parsed['source'];
  return {
    kind,
    sequence,
    cursor,
    emittedAtMs,
    payload: parsed['payload'],
    ...(typeof source === 'string' && source !== '' ? { source } : {}),
  };
}

/** Whether a kind is a recovery signal: the cursor named a gap, or frames were dropped. */
export function isRecoveryKind(kind: string): boolean {
  return kind === BUREAU_GAP_KIND || kind === BUREAU_FRAMES_DROPPED_KIND;
}
