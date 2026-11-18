/**
 * The embedding memory uses and the switch to another (`bureau.memory.embedding` and
 * `bureau.memory.embedding.cancel`), through the generated client. The operations give identifiers
 * and codes, never words: the Embedder row of Settings › General words them
 * (`routes/settings/embedder-model.ts`), so no identifier or code is shown as a word.
 *
 * A Bureau newer than the browser may report a cause or a failure code this client does not know,
 * and the row words that case.
 */
import { HttpClientError } from '@lostgradient/weft';

import { bureauClient, type BureauOutput } from './bureau-api.ts';
import type { Fetcher } from './bureau-client.ts';

type Options = { readonly signal?: AbortSignal; readonly fetch?: Fetcher };

/**
 * The embedding memory uses, the switch to another, and the embedders registered. `active` is the
 * embedding recall and admission use; `problem` is what keeps it from working fully
 * (`embedder-unavailable`), or `null`; `job` is the switch that is running, or the last one that
 * failed or was cancelled (the wire spells the state `cancelled`; the page's word for it is
 * "Canceled"); `embedders` is every registered embedder, in registry order, with whether memory
 * could embed with it now.
 */
export type EmbeddingStatus = Omit<BureauOutput<'bureau.memory.embedding'>, 'problem' | 'job'> & {
  /** What keeps the active embedding from working fully: a string, so a cause a newer Bureau reports still reaches the row. */
  readonly problem: string | null;
  readonly job: EmbeddingJob | null;
};

/** The switch a status reports. `error` is a string, so a failure code a newer Bureau reports still reaches the row. */
export type EmbeddingJob = Omit<
  NonNullable<BureauOutput<'bureau.memory.embedding'>['job']>,
  'error'
> & { readonly error: string | null };

/** One registered embedder of a status. */
export type RegisteredEmbedder = EmbeddingStatus['embedders'][number];

/** Reads the embedding status (`bureau.memory.embedding`). */
export async function getEmbeddingStatus(options?: Options): Promise<EmbeddingStatus> {
  return bureauClient['bureau.memory.embedding']({}, options);
}

/**
 * Cancels the running switch (`bureau.memory.embedding.cancel`). `true` when this call cancelled
 * one, `false` when none was running or it finished first, which is not an error.
 */
export async function cancelEmbeddingSwitch(options?: Options): Promise<boolean> {
  const answer = await bureauClient['bureau.memory.embedding.cancel']({}, options);
  return answer.cancelled;
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
