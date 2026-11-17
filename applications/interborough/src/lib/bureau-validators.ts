/**
 * The checks a goal may name: `bureau.validators.list` (COR-2111), parsed at the boundary. Each row is
 * one validator at one version, with who it comes from and, when it takes a configuration, that
 * configuration as JSON Schema (COR-2117), which a form is drawn from.
 */
import { z } from 'zod';

import { callBureau, type Fetcher } from './bureau-client.ts';

type Options = { readonly signal?: AbortSignal; readonly fetch?: Fetcher };

const validatorSchema = z.object({
  name: z.string(),
  version: z.string(),
  determinism: z.enum(['deterministic', 'stochastic']).nullable(),
  /** The JSON Schema of the configuration a goal may give it, or `null` when it takes none. */
  configuration: z.record(z.string(), z.unknown()).nullable(),
  source: z.object({
    kind: z.enum(['bureau', 'plugin', 'bungalow']),
    name: z.string(),
    version: z.string(),
  }),
});

/** One validator a goal may name. */
export type GoalValidator = z.infer<typeof validatorSchema>;

/** Every validator a goal may name, in the order the Bureau lists them. */
export async function listValidators(options?: Options): Promise<GoalValidator[]> {
  const answer = z
    .object({ validators: z.array(validatorSchema) })
    .parse(await callBureau('bureau.validators.list', {}, options));
  return answer.validators;
}
