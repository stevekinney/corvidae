/**
 * The guardrails installed in the Bureau (COR-2118): `bureau.guardrails.list`, parsed at the
 * boundary. Each is listed once per family it serves, with what it guards, whether an agent can
 * configure it, and the fields its configuration takes as JSON Schema.
 */
import { z } from 'zod';

import { callBureau, type Fetcher } from './bureau-client.ts';

type Options = { readonly signal?: AbortSignal; readonly fetch?: Fetcher };

const guardrailSchema = z.object({
  id: z.string(),
  family: z.enum(['input', 'output', 'tools', 'memory']),
  description: z.string(),
  configurable: z.boolean(),
  configuration: z.record(z.string(), z.unknown()).nullable(),
  /** `bungalow` for a guardrail the owner wrote as a file (COR-2120): its `id` is the file's stem, and no plugin holds it. */
  source: z.enum(['plugin', 'host', 'bungalow']),
  plugin: z.string().nullable(),
});

/**
 * One installed guardrail of one family. `id` is `plugin:name`, what an agent's `guardrails` lists;
 * a `memory` guardrail guards the host's memory and no agent lists it.
 */
export type InstalledGuardrail = z.infer<typeof guardrailSchema>;

const listSchema = z.object({ guardrails: z.array(guardrailSchema) });

/** Every guardrail installed in the Bureau, the host's first, then each running plugin's. */
export async function listGuardrails(options?: Options): Promise<InstalledGuardrail[]> {
  return listSchema.parse(await callBureau('bureau.guardrails.list', {}, options)).guardrails;
}
