/**
 * The checks a goal may name: `bureau.validators.list` (COR-2111), through the generated client.
 * Each row is one validator at one version, with who it comes from and, when it takes a
 * configuration, that configuration as JSON Schema (COR-2117), which a form is drawn from.
 */
import { bureauClient, type BureauOutput } from './bureau-api.ts';
import type { Fetcher } from './bureau-client.ts';

type Options = { readonly signal?: AbortSignal; readonly fetch?: Fetcher };

/** One validator a goal may name. */
export type GoalValidator = BureauOutput<'bureau.validators.list'>['validators'][number];

/** Every validator a goal may name, in the order the Bureau lists them. */
export async function listValidators(options?: Options): Promise<readonly GoalValidator[]> {
  const answer = await bureauClient['bureau.validators.list']({}, options);
  return answer.validators;
}
