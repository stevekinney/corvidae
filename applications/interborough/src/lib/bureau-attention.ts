/**
 * The browser's view of what needs attention: `bureau.health.attention`, which lists the system
 * problems that need a person now (an alert rule firing, a schedule that missed runs, a hook whose
 * delivery failed, a plugin that did not load, no model provider connected). Reviews waiting on a
 * person are never on it: they are Needs you, which the reviews count reads.
 *
 * The sidebar's Health dot reads only how many there are. The notification bell reads the rules
 * that are firing, so those are parsed here too; the Health page reads the items themselves, which
 * are the Bureau's own records and not restated here beyond that.
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

/** A rule of the host's that is firing, as `bureau.health.attention` lists it. */
export interface AttentionAlert {
  /** The metric the rule watches, such as `storage.size`. */
  readonly metric: string;
  /** When the rule last started firing, in epoch milliseconds. */
  readonly at: number;
  /** The metric's value when it was last evaluated, such as the storage size in bytes. */
  readonly currentValue: number;
}

const attentionAlertSchema = z.object({
  kind: z.literal('alert'),
  metric: z.string(),
  at: z.number(),
  currentValue: z.number(),
});

const attentionItemsSchema = z.object({ items: z.array(z.looseObject({ kind: z.string() })) });

/**
 * The rules that are firing now (`bureau.health.attention`), newest first as the Bureau lists
 * them. Every other kind of problem is left out: the bell words only the alerts. A caller without
 * `bureau.diagnostics:read` is refused with a fault, which the caller lets through.
 */
export async function listAttentionAlerts(options?: {
  readonly signal?: AbortSignal;
  readonly fetch?: Fetcher;
}): Promise<readonly AttentionAlert[]> {
  const { items } = attentionItemsSchema.parse(
    await callBureau('bureau.health.attention', {}, options),
  );
  return items.flatMap((item) => {
    const alert = attentionAlertSchema.safeParse(item);
    return alert.success
      ? [{ metric: alert.data.metric, at: alert.data.at, currentValue: alert.data.currentValue }]
      : [];
  });
}
