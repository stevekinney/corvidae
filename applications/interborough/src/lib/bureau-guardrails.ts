/**
 * The guardrails installed in the Bureau (COR-2118): `bureau.guardrails.list`, through the generated
 * client. Each is listed once per family it serves, with what it guards, whether an agent can
 * configure it, and the fields its configuration takes as JSON Schema.
 */
import { bureauClient, type BureauOutput } from './bureau-api.ts';
import type { Fetcher } from './bureau-client.ts';

type Options = { readonly signal?: AbortSignal; readonly fetch?: Fetcher };

/**
 * One installed guardrail of one family. `id` is `plugin:name`, what an agent's `guardrails` lists;
 * a `memory` guardrail guards the host's memory and no agent lists it. `source` is `bungalow` for a
 * guardrail the owner wrote as a file (COR-2120): its `id` is the file's stem, and no plugin holds it.
 */
export type InstalledGuardrail = BureauOutput<'bureau.guardrails.list'>['guardrails'][number];

/** Every guardrail installed in the Bureau, the host's first, then each running plugin's. */
export async function listGuardrails(options?: Options): Promise<readonly InstalledGuardrail[]> {
  const answer = await bureauClient['bureau.guardrails.list']({}, options);
  return answer.guardrails;
}
