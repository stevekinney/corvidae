/**
 * The embedding memory uses and the switch to another (`bureau.memory.embedding` and
 * `bureau.memory.embedding.cancel`), parsed at the boundary. The operations give identifiers and
 * codes, never words: the Embedder row of Settings › General words them
 * (`routes/settings/embedder-model.ts`), so no identifier or code is shown as a word.
 *
 * `problem` and `job.error` stay strings here. A Bureau newer than the browser may report a cause or
 * a failure code this client does not know, and the row words that case; a parse that threw on it
 * would leave the row with nothing to say.
 */
import { HttpClientError } from '@lostgradient/weft';
import { z } from 'zod';

import { callBureau, type Fetcher } from './bureau-client.ts';

type Options = { readonly signal?: AbortSignal; readonly fetch?: Fetcher };

const statusSchema = z.object({
  /** The embedding recall and admission use. */
  active: z.object({
    /** Its embedder's registry id: `hashing`, or `<plugin>:<name>`. */
    embedder: z.string(),
    /** How many entries each of its vectors has. */
    dimension: z.number().int(),
    /** The model that made its vectors, or `null` for one stored before models were recorded. */
    model: z.string().nullable(),
  }),
  /** What keeps the active embedding from working fully (`embedder-unavailable`), or `null`. */
  problem: z.string().nullable(),
  /** The switch that is running, or the last one that failed or was cancelled; `null` when none. */
  job: z
    .object({
      /** The registry id of the embedder the switch re-embeds memory with. */
      target: z.string(),
      /** The wire spells the state `cancelled`; the page's word for it is "Canceled". */
      state: z.enum(['running', 'failed', 'cancelled']),
      /** How many stored memories the switch has embedded. */
      done: z.number().int(),
      /** How many memories are stored. */
      total: z.number().int(),
      /** Why a failed switch failed, as a code, or `null`. */
      error: z.string().nullable(),
    })
    .nullable(),
  /** Every registered embedder, in registry order, with whether memory could embed with it now. */
  embedders: z.array(
    z.object({
      id: z.string(),
      dimension: z.number().int(),
      availability: z.enum(['available', 'needs-setup']),
    }),
  ),
});

/** The embedding memory uses, the switch to another, and the embedders registered. */
export type EmbeddingStatus = z.infer<typeof statusSchema>;

/** The switch a status reports. */
export type EmbeddingJob = NonNullable<EmbeddingStatus['job']>;

/** One registered embedder of a status. */
export type RegisteredEmbedder = EmbeddingStatus['embedders'][number];

/** Reads the embedding status (`bureau.memory.embedding`). */
export async function getEmbeddingStatus(options?: Options): Promise<EmbeddingStatus> {
  return statusSchema.parse(await callBureau('bureau.memory.embedding', {}, options));
}

const cancelSchema = z.object({ cancelled: z.boolean() });

/**
 * Cancels the running switch (`bureau.memory.embedding.cancel`). `true` when this call cancelled
 * one, `false` when none was running or it finished first, which is not an error.
 */
export async function cancelEmbeddingSwitch(options?: Options): Promise<boolean> {
  return cancelSchema.parse(await callBureau('bureau.memory.embedding.cancel', {}, options))
    .cancelled;
}

/**
 * What a failed read or cancel of the embedding means to the row: the Bureau keeps no memory
 * (`no-memory`), the caller may not read or change settings (`forbidden`), or anything else,
 * which includes a server that did not answer (`other`).
 */
export type EmbeddingFault = 'no-memory' | 'forbidden' | 'other';

/** Sorts a thrown fault into the {@link EmbeddingFault} the row words. */
export function embeddingFaultOf(error: unknown): EmbeddingFault {
  if (!(error instanceof HttpClientError)) return 'other';
  switch (error.data?.['weftCode']) {
    case 'UnsupportedCapability':
      return 'no-memory';
    case 'Forbidden':
      return 'forbidden';
    default:
      return 'other';
  }
}
