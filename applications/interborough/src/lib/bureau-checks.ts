/**
 * The browser's view of the results of every check Bureau keeps: `bureau.checks.list` (COR-2113),
 * parsed at the boundary. A result is a goal's validator verdict, a guardrail that blocked, warned,
 * sanitized, redacted or tripped a run, a scorer's score of a run, or a session a guardrail flagged,
 * newest first, paged by a cursor the answer hands back. A row names the check, the agent, the
 * outcome, the time and the run, and never any text a check produced.
 */
import { z } from 'zod';

import { callBureau, type Fetcher } from './bureau-client.ts';

/** Where a check result is kept, as the operation names it. */
export const CHECK_KINDS = [
  'goal.attempt.validated',
  'run.guardrail',
  'run.tripwire',
  'scorer.recorded',
  'session.tainted',
] as const;

/** One of {@link CHECK_KINDS}. */
export type CheckKind = (typeof CHECK_KINDS)[number];

/** What a check decided, as the operation names it. */
export const CHECK_OUTCOMES = [
  'pass',
  'fail',
  'error',
  'unavailable',
  'canceled',
  'indeterminate',
  'block',
  'warn',
  'sanitize',
  'redact',
  'tripwire',
  'tainted',
] as const;

/** One of {@link CHECK_OUTCOMES}. */
export type CheckOutcome = (typeof CHECK_OUTCOMES)[number];

const checkRowSchema = z.object({
  kind: z.enum(CHECK_KINDS),
  /** `validator@version` or `scorer@version`, a guardrail's name, or a session's detector. */
  checkId: z.string(),
  /** The agent the check judged, or `null` when it cannot be told. */
  agentName: z.string().nullable(),
  outcome: z.enum(CHECK_OUTCOMES),
  /** ISO-8601. */
  timestamp: z.string(),
  runId: z.string(),
  /** The goal a goal check judged; `null` for a run row. */
  goalRunId: z.string().nullable(),
  attemptId: z.string().nullable(),
  /** A scorer's score from 0 to 1 when it gave one; `null` for every other row. */
  score: z.number().nullable(),
});

/** One check result, as `bureau.checks.list` shows it. */
export type CheckRow = z.infer<typeof checkRowSchema>;

const pageSchema = z.object({
  checks: z.array(checkRowSchema),
  nextCursor: z.string().nullable(),
});

/** One page of check results, and the cursor for the next, or `null` on the last. */
export type CheckPage = z.infer<typeof pageSchema>;

/** What a read narrows the results to. A field that is absent narrows nothing. */
export type CheckFilter = {
  readonly kind?: CheckKind;
  /** Exactly as a row names the check, `name@version`. */
  readonly checkId?: string;
  readonly agentName?: string;
  readonly outcome?: CheckOutcome;
  /** Only results at or after this time, in epoch milliseconds. */
  readonly since?: number;
  /** Only results at or before this time, in epoch milliseconds. */
  readonly until?: number;
};

type Options = { readonly signal?: AbortSignal; readonly fetch?: Fetcher };

/** How many results one page holds, which is the operation's own default. */
export const CHECK_PAGE_SIZE = 50;

/**
 * One page of results for `filter`, from `cursor` when it is given. An absent filter field is not
 * sent. Newest first; a cursor continues into older results.
 */
export async function listChecks(
  filter: CheckFilter,
  cursor: string | undefined,
  options?: Options & { readonly limit?: number },
): Promise<CheckPage> {
  const params: Record<string, unknown> = {
    limit: options?.limit ?? CHECK_PAGE_SIZE,
    ...(filter.kind === undefined ? {} : { kind: filter.kind }),
    ...(filter.checkId === undefined ? {} : { checkId: filter.checkId }),
    ...(filter.agentName === undefined ? {} : { agentName: filter.agentName }),
    ...(filter.outcome === undefined ? {} : { outcome: filter.outcome }),
    ...(filter.since === undefined ? {} : { since: filter.since }),
    ...(filter.until === undefined ? {} : { until: filter.until }),
    ...(cursor === undefined ? {} : { cursor }),
  };
  return pageSchema.parse(await callBureau('bureau.checks.list', params, options));
}
