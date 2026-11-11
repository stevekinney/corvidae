import type { RunFrame } from '@lostgradient/operative';

// ── WebSocket Frame Types ───────────────────────────────────────────

/**
 * Live stream frame shapes, before the per-run sequence stamp is applied. Kept separate from
 * {@link ServerFrame} so a producer never has to know about sequencing — the bureau frame layer
 * (`create-bureau.ts`) stamps `runSeq` once, at the single point where frames are handed to
 * `emitLiveFrame`. See {@link ServerFrame} for the wire-level (stamped) shape. No Bureau code
 * produces one today; the type stays because the wire protocol does and `components/chat`
 * still decodes it.
 */
export type StreamFrame =
  | { type: 'stream:text-delta'; runId: string; content: string; accumulated: string }
  | { type: 'stream:tool-call-start'; runId: string; toolName: string; blockId: string }
  | {
      type: 'stream:tool-call-delta';
      runId: string;
      toolName: string;
      blockId: string;
      partialArgs: string;
    }
  | {
      type: 'stream:tool-call-complete';
      runId: string;
      toolName: string;
      blockId: string;
      arguments: unknown;
    }
  | { type: 'stream:complete'; runId: string; state: unknown }
  | { type: 'stream:error'; runId: string; error: string };
/**
 * AB-96 — a versioned run-lifecycle frame from `operative`'s run envelope
 * (`RunFrame`: run-started, step, assistant-chunk/final, tool-pre/post,
 * notification, run-finished). The terminal `RunReport` is embedded on the
 * `run-finished` variant.
 *
 * Deliberately NOT part of {@link StreamFrame}/the AB-15 `runSeq` replay
 * contract: `create-bureau.ts` emits these without a `runSeq` stamp (they
 * carry their own envelope-level sequencing via `RunFrame`), so
 * `getRunSeq`/the live-frame replay buffer correctly treat them as
 * non-replayable, same as before AB-15 added `runSeq`.
 */
export type RunEnvelopeFrame = { type: 'run-envelope'; runId: string; frame: RunFrame };
export type ServerFrame =
  | {
      type: 'event';
      runId: string;
      event: string;
      detail: unknown;
      /**
       * The store's global action counter (unique across all runs in this
       * store's lifetime). Used by the REST `/api/v1/runs/:id` timeline to
       * dedupe against live frames already rendered — see
       * `use-run-detail.svelte.ts`. NOT a replay cursor; use {@link runSeq}
       * for that.
       */
      sequence: number;
      timestamp: number;
      /**
       * Monotonic per-run sequence number (AB-15), starting at 1 for the
       * first live frame emitted for `runId` and incrementing by 1 for every
       * subsequent run-scoped frame (`event` and `stream:*`) emitted for that
       * same run. This is the replay cursor: a reconnecting client reports
       * the highest `runSeq` it has already seen for a run (WS `subscribe.since`,
       * SSE `Last-Event-ID`) and the door replays buffered frames with a
       * higher `runSeq` before resuming the live feed.
       */
      runSeq: number;
    }
  | { type: 'subscribed'; runId: string }
  | { type: 'unsubscribed'; runId: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong' }
  | (StreamFrame & { runSeq: number })
  | RunEnvelopeFrame
  | {
      /**
       * A durable event delivered through the gateway's reconnect-across-
       * restart fallback (AB-312), never through the ordinary in-memory
       * replay buffer this file's `runSeq` doc comment describes. Sourced
       * from `Bureau.subscribeEventHistory`'s replay-then-tail delivery
       * once a client's resume cursor is older than the live buffer's own
       * floor (or the buffer holds nothing at all, e.g. after a Gateway
       * restart) — see `packages/gateway/src/live-events.ts`'s
       * `durableEnvelopeToServerFrame`.
       *
       * Deliberately carries NO `runSeq`: it is not part of the AB-15
       * in-memory replay-buffer cursor space (a `DurableEventEnvelope`'s
       * own `sequence`/`cursor` is Weft's fleet-global position, not a
       * per-run counter, and the two cannot be translated into each
       * other — see this issue's own doc comment on the fallback path).
       * Never buffered and never advances a client's live `runSeq`
       * cursor, the same as every other non-`runSeq`-bearing frame.
       */
      type: 'durable-event';
      runId: string;
      /** The durable envelope's own `kind` (e.g. `'run.completed'`). */
      event: string;
      /** The durable envelope's own `payload`. */
      detail: unknown;
      /** The durable envelope's own opaque `cursor` — never parsed, only round-tripped. */
      cursor: string;
      schemaVersion: number;
      /** The durable envelope's own `emittedAtMs`. */
      timestamp: number;
    };
