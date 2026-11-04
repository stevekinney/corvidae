/**
 * The browser's view of what needs attention: `bureau.health.attention`, which lists the system
 * problems that need a person now (an alert rule firing, a schedule that missed runs, a hook whose
 * delivery failed, a plugin that did not load, no model provider connected). Reviews waiting on a
 * person are never on it: they are Needs you, which the reviews count reads.
 *
 * The sidebar's Health dot reads only how many there are, so only that is parsed here. The Health
 * page reads the items themselves, which are the Bureau's own records and not restated here.
 */
import { z } from 'zod';

import { callBureau, type Fetcher } from './bureau-client.ts';

const attentionCountSchema = z.object({ count: z.number().int().nonnegative() });

/**
 * How many problems need attention now. A caller without `bureau.diagnostics:read` is refused with
 * a fault, which the caller of this function lets through so the sidebar can leave its dot out
 * instead of showing a count it could not read.
 */
export async function getAttentionCount(options?: {
  readonly signal?: AbortSignal;
  readonly fetch?: Fetcher;
}): Promise<number> {
  return attentionCountSchema.parse(await callBureau('bureau.health.attention', {}, options)).count;
}
