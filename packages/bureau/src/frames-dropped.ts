/**
 * The frames-dropped marker for Bureau's in-memory live feeds.
 *
 * Weft's replay-plus-live feed gives each live subscriber a bounded buffer.
 * When a subscriber falls behind far enough to fill it, the feed ends that
 * subscriber's stream, and nothing tells the reader that anything happened: to
 * a consumer the stream simply stops. A reader of an ephemeral feed (the AG-UI
 * and management streams, per COR-901's "Slow consumers" rule) needs the stream
 * to say so and to keep going.
 *
 * {@link withFramesDroppedMarker} wraps a feed so that an overflow yields exactly
 * one {@link FRAMES_DROPPED_KIND} marker and the stream continues. The feed ends
 * a subscription for three reasons: the subscriber's own signal aborted, the
 * feed's lifetime ended (disposal), or the live buffer overflowed. Only the
 * third is reported and resumed; the other two end the stream as they always did.
 *
 * After the marker the subscription resumes after the last cursor the reader
 * received, so the events the in-memory log still retains arrive next, in
 * order and without duplicates, and live delivery follows. An event the log has
 * already evicted is lost, and the marker is what tells the reader it may be.
 * The marker takes the position of the last event delivered, so a reader that
 * reconnects from its cursor does not skip anything the marker stood in front of.
 *
 * @module frames-dropped
 */

import type { ReplayLiveFeed, SequencedEventEnvelope } from '@lostgradient/weft';

/** The `kind` of the marker that reports a live buffer overflow. */
export const FRAMES_DROPPED_KIND = 'frames.dropped';

/** Where a marker sits: the last event the reader received before it. */
export type FramesDroppedPosition = {
  /** The sequence of the last event delivered, or `-1` when none was. */
  readonly sequence: number;
  /** The cursor of the last event delivered, or `-1` when none was. */
  readonly cursor: string;
};

/**
 * Wraps `feed` so a subscriber whose live buffer overflows receives one marker
 * built by `createMarker`, then the stream continues.
 *
 * `lifetime` is the signal that ends every subscription when the feed is
 * disposed; a stream that ends because it fired is not an overflow.
 */
export function withFramesDroppedMarker<TEnvelope extends SequencedEventEnvelope>(
  feed: ReplayLiveFeed<TEnvelope>,
  lifetime: AbortSignal,
  createMarker: (position: FramesDroppedPosition) => TEnvelope,
): ReplayLiveFeed<TEnvelope> {
  return {
    replay: (options) => feed.replay(options),
    subscribe: (options) => subscribeWithMarker(feed, lifetime, createMarker, options),
    dispose: () => {
      feed.dispose();
    },
  };
}

async function* subscribeWithMarker<TEnvelope extends SequencedEventEnvelope>(
  feed: ReplayLiveFeed<TEnvelope>,
  lifetime: AbortSignal,
  createMarker: (position: FramesDroppedPosition) => TEnvelope,
  options: Parameters<ReplayLiveFeed<TEnvelope>['subscribe']>[0],
): AsyncGenerator<TEnvelope, void, undefined> {
  const signal = options?.signal;
  let resumeAfter = options?.fromCursor;
  let lastSequence = -1;
  // The caller hears about replay completing once, not once per resumption.
  let replayCompleteReported = false;
  let resuming = false;
  while (true) {
    const reportReplayComplete = options?.onReplayComplete;
    // `replayLimit` bounds how much a cold subscription may replay. After an
    // overflow the replay is bounded by the buffer that overflowed, which can
    // exceed that limit, and failing the resumed stream would end it right after
    // the marker announced that it continues.
    const { replayLimit: _replayLimit, createReplayLimitError: _createError, ...unlimited } =
      options ?? {};
    const subscription = feed.subscribe({
      ...(resuming ? unlimited : options),
      ...(resumeAfter === undefined ? {} : { fromCursor: resumeAfter }),
      ...(reportReplayComplete === undefined
        ? {}
        : {
            onReplayComplete: () => {
              if (replayCompleteReported) return;
              replayCompleteReported = true;
              reportReplayComplete();
            },
          }),
    });
    for await (const envelope of subscription) {
      resumeAfter = envelope.cursor;
      lastSequence = envelope.sequence;
      yield envelope;
    }
    if (signal?.aborted === true || lifetime.aborted) return;
    yield createMarker({ sequence: lastSequence, cursor: resumeAfter ?? '-1' });
    resuming = true;
  }
}
