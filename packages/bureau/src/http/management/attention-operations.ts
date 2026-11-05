import { authorizeWorkspaceOperation } from '../workspace-authorization.ts';

/**
 * `bureau.health.attention`: what needs attention now (COR-2009), through `Bureau.attention()`.
 *
 * It requires `bureau.diagnostics:read`, because the list is deployment-wide: a schedule, hook or
 * plugin on it may belong to any owner. Each item names the thing to look at (a schedule, a hook, a
 * plugin, a metric) and the times and counts a sentence about it needs, never a message, a
 * request body, a credential or a stack. Reviews waiting on a person are never listed.
 *
 * @module attention-operations
 */

import { defineOperation, type AlertMetric } from '@lostgradient/weft';
import { z } from 'zod';

import {
  ATTENTION_AREAS,
  type BureauAttention,
  type BureauAttentionItem,
} from '../../attention-feed.ts';
import { unaryTransports as transports, unknownKeyPolicy } from './management-schemas.ts';

/** What the attention operation reads from the handler's `host`. */
export type BureauAttentionOperationHost = {
  /** The Bureau's `attention()`, read at the moment of the call. */
  readonly attention: () => Promise<BureauAttention>;
};

/** Weft's alert metrics; the `satisfies` fails to compile when Weft adds or renames one. */
const alertMetric = z.enum([
  'workflow.failure_rate',
  'activity.p99_duration',
  'storage.size',
] as const satisfies readonly AlertMetric[]) satisfies z.ZodType<AlertMetric>;

const at = z.number().int().describe('When it happened, in epoch milliseconds.');
const area = z.enum(ATTENTION_AREAS).describe('The check the problem counts under.');

const item = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('alert'),
    area,
    at: at.describe('When the rule last started firing, in epoch milliseconds.'),
    metric: alertMetric.describe('The metric the rule watches.'),
    currentValue: z.number().describe('The metric’s value when it was last evaluated.'),
    threshold: z.number().describe('The value at or above which the rule fires.'),
  }),
  z.object({
    kind: z.literal('missed-runs'),
    area,
    at: at.describe('When the latest miss was recorded, in epoch milliseconds.'),
    scheduleId: z.string(),
    scheduleName: z.string().nullable().describe('The schedule’s description, or `null`.'),
    count: z.number().int().describe('How many occurrences it missed in the last seven days.'),
    since: z.number().int().describe('The first missed occurrence, in epoch milliseconds.'),
    occurrences: z
      .array(z.object({ occurrence: z.number().int(), count: z.number().int() }))
      .describe(
        'Each recorded miss, oldest first: when it was due and how many fires it stands for.',
      ),
  }),
  z.object({
    kind: z.literal('hook-failed'),
    area,
    at: at.describe('When the last attempt ended, in epoch milliseconds.'),
    hookId: z.string(),
    hookName: z.string().nullable(),
    gaveUp: z
      .boolean()
      .describe('`true` once the delivery stopped for good; `false` while it retries.'),
    status: z
      .number()
      .int()
      .nullable()
      .describe('The HTTP status the receiver answered, or `null`.'),
    host: z.string().nullable().describe('The host a webhook posts to, or `null`.'),
    attempts: z.number().int().describe('How many attempts the delivery made.'),
    error: z
      .string()
      .nullable()
      .describe('Why the last attempt failed when nobody answered, or `null`.'),
  }),
  z.object({
    kind: z.literal('plugin-not-loaded'),
    area,
    at: at.nullable(),
    plugin: z.string(),
    problems: z.array(z.string()).describe('The codes of the problems that kept it from loading.'),
  }),
  z.object({
    kind: z.literal('no-provider'),
    area,
    at: at.nullable().describe('When the last provider was removed, or `null` when none ever was.'),
    provider: z.string().nullable().describe('The provider removed last, such as `anthropic`.'),
  }),
]);

/** One item as the wire carries it: its own copy of every list. */
function wireItem(entry: BureauAttentionItem): z.infer<typeof item> {
  if (entry.kind === 'missed-runs') {
    return {
      ...entry,
      occurrences: entry.occurrences.map((row) => ({
        occurrence: row.occurrence,
        count: row.count,
      })),
    };
  }
  if (entry.kind === 'plugin-not-loaded') return { ...entry, problems: [...entry.problems] };
  return { ...entry };
}

const attentionInput = z.object({});

const attentionOutput = z.object({
  items: z.array(item).describe('Every problem, most recent first; one with no known time first.'),
  count: z.number().int().nonnegative().describe('How many items there are.'),
  checks: z
    .array(z.object({ area, count: z.number().int().positive() }))
    .describe('The same items counted by area; only areas with a problem are listed.'),
});

export const healthAttentionOperation = defineOperation<
  typeof attentionInput,
  typeof attentionOutput,
  BureauAttentionOperationHost
>({
  name: 'bureau.health.attention',
  authorize: authorizeWorkspaceOperation('bureau.health.attention'),
  mcpExposable: false,
  summary: 'List what needs attention',
  description:
    'Lists the system problems that need attention now, most recent first: an alert rule that is firing (`alert`), a schedule that missed runs in the last seven days and has not run since (`missed-runs`), an enabled hook whose newest delivery failed or gave up (`hook-failed`), a plugin that did not load (`plugin-not-loaded`), and what the host reports, such as no model provider connected (`no-provider`). `count` is the number of items, and `checks` counts the same items by area. Reviews waiting on a person are never listed. Requires `bureau.diagnostics:read`.',
  destructive: false,
  tags: ['Deployment'],
  inputSchema: attentionInput,
  outputSchema: attentionOutput,
  producibleFaults: ['Forbidden'],
  access: { kind: 'scoped', scopes: { kind: 'allOf', scopes: ['bureau.diagnostics:read'] } },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ host, principal }) => {
    const attention = await host.attention();
    if (principal.method !== 'unauthenticated' && principal.workspace !== undefined) {
      const items = attention.items
        .filter((entry) => entry.kind === 'plugin-not-loaded' || entry.kind === 'no-provider')
        .map(wireItem);
      const counts = new Map<z.infer<typeof area>, number>();
      for (const entry of items) counts.set(entry.area, (counts.get(entry.area) ?? 0) + 1);
      return {
        items,
        count: items.length,
        checks: [...counts].map(([entryArea, count]) => ({ area: entryArea, count })),
      };
    }
    return {
      items: attention.items.map(wireItem),
      count: attention.count,
      checks: attention.checks.map((check) => ({ area: check.area, count: check.count })),
    };
  },
});
