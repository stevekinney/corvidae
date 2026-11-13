/**
 * The models that can answer decisions (`bureau.decisions.models`), as the Bureau reports them: each
 * catalog row that can decide, whether it is available or needs setup, and the row that answers as
 * the fallback. The page only renders this list; which rows can decide and which one answers are the
 * Bureau's rules (`packages/bureau/src/decisions/create-decisions.ts`), parsed here at the boundary.
 */
import { z } from 'zod';

import { callBureau, type Fetcher } from './bureau-client.ts';

type Options = { readonly signal?: AbortSignal; readonly fetch?: Fetcher };

const rowSchema = z.object({
  provider: z.string(),
  model: z.string(),
  availability: z.enum(['available', 'needs-setup']),
  decisionOnly: z.boolean(),
  answering: z.boolean(),
});

const modelsSchema = z.object({ rows: z.array(rowSchema) });

/** One catalog row that can answer decisions. `<provider>/<model>` is what a decision setting stores. */
export type DecisionModelRow = z.infer<typeof rowSchema>;

/** The name a decision setting stores for a row: `<provider>/<model>`. */
export function decisionRowName(row: Pick<DecisionModelRow, 'provider' | 'model'>): string {
  return `${row.provider}/${row.model}`;
}

/** The rows that can answer decisions, in catalog order, each with its availability. */
export async function listDecisionModels(options?: Options): Promise<readonly DecisionModelRow[]> {
  return modelsSchema.parse(await callBureau('bureau.decisions.models', {}, options)).rows;
}
