/**
 * The types of a replay-and-live feed: its storage backend, the feed over it, and its subscribe
 * options. The implementation is `replay-live-feed.ts`.
 *
 * @module server/replay-live-feed-types
 */

import type { Cursor, SequencedEventEnvelope } from './sequence-cursor.ts';

export type ReplayLiveFeedBackend<TEnvelope extends SequencedEventEnvelope> = {
  replay(options: { afterSequence: number; requestedCursor?: Cursor }): AsyncIterable<TEnvelope>;
  snapshotTailSequence(): Promise<number>;
  subscribeLive(listener: (envelope: TEnvelope) => void): () => void;
  decodeCursor?(cursor: Cursor): { sequence: number } | 'gap' | 'invalid';
  encodeCursor?(sequence: number): Cursor;
  snapshotFirstRetainedSequence?(): Promise<number>;
  createGapEnvelope?(options: {
    requestedCursor: Cursor;
    firstRetainedSequence: number;
    continuationCursor: Cursor;
  }): TEnvelope;
};

export type ReplayLiveFeed<TEnvelope extends SequencedEventEnvelope> = {
  replay(options?: { fromCursor?: Cursor; limit?: number }): AsyncIterable<TEnvelope>;
  subscribe(options?: ReplayLiveSubscribeOptions<TEnvelope>): AsyncIterable<TEnvelope>;
  decodeCursor(cursor: Cursor): { sequence: number } | 'gap' | 'invalid';
  dispose(): void;
};

export type ReplayLiveSubscribeOptions<TEnvelope extends SequencedEventEnvelope> = {
  fromCursor?: Cursor;
  signal?: AbortSignal;
  replayLimit?: number;
  filterEnvelope?: (envelope: TEnvelope) => boolean;
  countReplayEnvelope?: (envelope: TEnvelope) => boolean;
  createReplayLimitError?: (count: number, limit: number) => unknown;
  onReplayComplete?: () => void;
};
