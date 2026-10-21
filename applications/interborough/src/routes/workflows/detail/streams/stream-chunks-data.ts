/**
 * A durable stream's stored chunks (COR-1462): `weft.workflows.streams.chunks`, called through
 * `client.operations[...]` because it has no ergonomic `HttpClient` method (it needs `streams:read`).
 *
 * The operation answers the chunks stored after a cursor, in order: the first request omits
 * `after`, and each later one passes the sequence of the last chunk the view already holds. A
 * chunk the view holds is never asked for again, and `appendNewChunks` drops one that arrives
 * anyway, so a chunk is shown exactly once however the answers overlap.
 */
import type { HttpClient, WorkflowStatus } from '@lostgradient/weft';

export const STREAM_CHUNKS_OPERATION = 'weft.workflows.streams.chunks';

export type StreamChunksClient = {
  readonly operations: Pick<HttpClient['operations'], typeof STREAM_CHUNKS_OPERATION>;
};

/** How often a live run's stream is asked for new chunks. */
export const STREAM_POLL_INTERVAL_MS = 2_000;

export interface StreamChunk {
  readonly sequence: number;
  readonly value: unknown;
}

function isStreamChunk(value: unknown): value is StreamChunk {
  return (
    typeof value === 'object' &&
    value !== null &&
    'sequence' in value &&
    typeof value.sequence === 'number' &&
    Number.isSafeInteger(value.sequence) &&
    'value' in value
  );
}

/** Read the chunks stored after `after` (all of them when it is omitted), in sequence order. */
export async function readStreamChunks(
  client: StreamChunksClient,
  workflowId: string,
  key: string,
  after: number | undefined,
): Promise<readonly StreamChunk[]> {
  const answer = await client.operations[STREAM_CHUNKS_OPERATION]({
    workflowId,
    key,
    ...(after === undefined ? {} : { after }),
  });
  const chunks: readonly unknown[] = answer.chunks;
  if (!chunks.every(isStreamChunk)) {
    throw new TypeError(`${STREAM_CHUNKS_OPERATION} returned an unexpected shape`);
  }
  return chunks.toSorted((left, right) => left.sequence - right.sequence);
}

/** `held` followed by the chunks of `incoming` that come after the last of them: none twice, in order. */
export function appendNewChunks(
  held: readonly StreamChunk[],
  incoming: readonly StreamChunk[],
): readonly StreamChunk[] {
  let last = held.at(-1)?.sequence ?? -1;
  const fresh: StreamChunk[] = [];
  for (const chunk of incoming) {
    if (chunk.sequence <= last) continue;
    fresh.push(chunk);
    last = chunk.sequence;
  }
  return fresh.length === 0 ? held : [...held, ...fresh];
}

/** A cancelled or timed-out run has its stream chunks swept, so an empty stream there is not "no chunks yet". */
export function streamChunksAreSwept(status: WorkflowStatus): boolean {
  return status === 'cancelled' || status === 'timed-out';
}

/** The key as the view shows it: cut off past `limit` characters, the whole key kept for a `title`. */
export function displayStreamKey(
  key: string,
  limit: number,
): { readonly text: string; readonly truncated: boolean } {
  return key.length <= limit
    ? { text: key, truncated: false }
    : { text: `${key.slice(0, limit - 1)}…`, truncated: true };
}
