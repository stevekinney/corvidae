/**
 * The models that can answer decisions (`bureau.decisions.models`), as the Bureau reports them: each
 * catalog row that can decide, whether it is available or needs setup, and the row that answers as
 * the fallback. The page only renders this list; which rows can decide and which one answers are the
 * Bureau's rules (`packages/bureau/src/decisions/create-decisions.ts`).
 */
import { bureauClient, type BureauOutput } from './bureau-api.ts';
import type { Fetcher } from './bureau-client.ts';

type Options = { readonly signal?: AbortSignal; readonly fetch?: Fetcher };

/**
 * One catalog row that can answer decisions. `<provider>/<model>` is what a decision setting stores.
 * `answering` is the row a decision goes to now, at most one, none when nothing can answer;
 * `fallback` is the row the language-model fallback uses; `canBeFallback` says whether the Bureau's
 * fallback rule can ever use the row (it returns structured output).
 */
export type DecisionModels = BureauOutput<'bureau.decisions.models'>;
export type DecisionModelRow = DecisionModels['rows'][number];

/** The name a decision setting stores for a row: `<provider>/<model>`. */
export function decisionRowName(row: Pick<DecisionModelRow, 'provider' | 'model'>): string {
  return `${row.provider}/${row.model}`;
}

/** The rows and host model currently available for decisions. */
export function listDecisionModels(options?: Options): Promise<DecisionModels> {
  return bureauClient['bureau.decisions.models']({}, options);
}
