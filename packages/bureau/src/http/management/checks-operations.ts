/**
 * `bureau.checks.list`: the results of every check Bureau keeps, newest first (COR-2113).
 *
 * One list answers "which checks failed this week, on which agents" across the goals' validator
 * verdicts, the guardrails that blocked, redacted or tripped a run, the scorers' scores (COR-2252),
 * and the sessions a guardrail flagged (COR-2116). A caller reads the rows about what it owns without any scope.
 * `bureau.audit:read` adds every owner's run rows and flagged sessions, and `bureau.goals:read`
 * every owner's goal rows; neither scope reaches across a workspace member's boundary, as for
 * `bureau.audit.query` and `bureau.goals.list`.
 *
 * A row names the check, the agent, the outcome, the time and the run, and carries no text a check
 * produced: not the text a guardrail flagged or its `detail`, not a validator's feedback or
 * evidence, and not a scorer's `message`. {@link listChecks} builds each row field by field, so a field a source gains reaches no
 * client until it is added there on purpose.
 *
 * @module checks-operations
 */

import { defineOperation } from '@lostgradient/backchannel';
import { z } from 'zod';

import { mayUseCrossOwnerScope, ownerOfPrincipal } from '../owner-predicate.ts';
import {
  CHECK_KINDS,
  CHECK_OUTCOMES,
  CHECK_TEXT_LIMIT,
  decodeChecksCursor,
  DEFAULT_CHECKS_PAGE_LIMIT,
  listChecks,
  MAXIMUM_CHECKS_CURSOR_LENGTH,
  MAXIMUM_CHECKS_PAGE_LIMIT,
  type ChecksSources,
} from './checks-reader.ts';
import { unaryTransports as transports, unknownKeyPolicy } from './management-schemas.ts';
import { authorizeWorkspaceOperation } from '../workspace-authorization.ts';

/** What the checks operation reads from the handler's `host`. */
export type BureauChecksOperationHost = {
  readonly checks: ChecksSources;
};

const rowSchema = z.object({
  kind: z.enum(CHECK_KINDS).describe('Where the result is kept.'),
  checkId: z
    .string()
    .describe(
      'The check: a validator’s or a scorer’s `name@version`, a guardrail’s name, or the detector that flagged a session.',
    ),
  agentName: z
    .string()
    .nullable()
    .describe('The agent the check judged, or `null` when it cannot be told.'),
  outcome: z.enum(CHECK_OUTCOMES).describe('What the check decided.'),
  timestamp: z.string().describe('When it decided, as an ISO-8601 time.'),
  runId: z.string().describe('The run the check judged.'),
  goalRunId: z.string().nullable().describe('The goal the check judged, or `null` for a run row.'),
  attemptId: z
    .string()
    .nullable()
    .describe('The goal attempt the check judged, or `null` for a run row.'),
  score: z
    .number()
    .nullable()
    .describe('A scorer’s score from 0 to 1 when it gave one, and `null` for every other row.'),
});

const listInput = z.object({
  kind: z.enum(CHECK_KINDS).optional().describe('Only results of this kind.'),
  checkId: z
    .string()
    .min(1)
    .max(CHECK_TEXT_LIMIT)
    .optional()
    .describe('Only results of this check, exactly as a row names it.'),
  agentName: z
    .string()
    .min(1)
    .max(CHECK_TEXT_LIMIT)
    .optional()
    .describe('Only results about this agent.'),
  outcome: z.enum(CHECK_OUTCOMES).optional().describe('Only results with this outcome.'),
  since: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Only results at or after this time, in epoch milliseconds.'),
  until: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Only results at or before this time, in epoch milliseconds.'),
  cursor: z
    .string()
    .max(MAXIMUM_CHECKS_CURSOR_LENGTH)
    .refine((cursor) => decodeChecksCursor(cursor) !== undefined, { message: 'Invalid cursor' })
    .optional()
    .describe('The `nextCursor` of the previous page, to continue after it.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAXIMUM_CHECKS_PAGE_LIMIT)
    .optional()
    .describe(
      `The most results to return in one page, from 1 to ${MAXIMUM_CHECKS_PAGE_LIMIT}. Defaults to ${DEFAULT_CHECKS_PAGE_LIMIT}.`,
    ),
});

const listOutput = z.object({
  checks: z.array(rowSchema),
  /** Pass it as `cursor` for the next page; `null` on the last. */
  nextCursor: z.string().nullable(),
});

export const checksListOperation = defineOperation<
  typeof listInput,
  typeof listOutput,
  BureauChecksOperationHost
>({
  name: 'bureau.checks.list',
  authorize: authorizeWorkspaceOperation('bureau.checks.list'),
  mcpExposable: false,
  summary: 'List check results',
  description:
    'Lists the results of the checks Bureau keeps, newest first: a goal’s validator verdicts, the guardrails that blocked, warned, sanitized, redacted or tripped a run, the scorers’ scores of completed runs (`scorer.recorded`, with the scorer’s `name@version` as the check, a validator outcome kind as the outcome, and the score when it gave one), and the sessions a guardrail flagged (`session.tainted`, read from the session’s stored taint, with the detector as the check and the time it was flagged). A caller sees the results about what it owns; a caller holding `bureau.audit:read` sees every owner’s run results and flagged sessions, and one holding `bureau.goals:read` every owner’s goal results. `kind`, `checkId`, `agentName` and `outcome` each narrow to one value, and `since` and `until` to a time range (both ends inclusive). A row names the check, the agent, the outcome, the time and the run, and never the text a guardrail flagged, a validator’s feedback or evidence, or a scorer’s message. Pages with `limit` (1 to 100, default 50) and `cursor`; `nextCursor` is `null` on the last page, and a page is filled from the results the caller may see, so a cursor advances across any number of results it may not.',
  destructive: false,
  tags: ['Checks'],
  inputSchema: listInput,
  outputSchema: listOutput,
  producibleFaults: ['InvalidParams'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const { limit = DEFAULT_CHECKS_PAGE_LIMIT, cursor, ...filter } = input;
    const page = await listChecks(
      host.checks,
      {
        caller: ownerOfPrincipal(principal),
        everyRunOwner: mayUseCrossOwnerScope(principal, 'bureau.audit:read'),
        everyGoalOwner: mayUseCrossOwnerScope(principal, 'bureau.goals:read'),
      },
      filter,
      { limit, ...(cursor === undefined ? {} : { cursor: decodeChecksCursor(cursor) }) },
    );
    return { checks: page.checks.map((row) => ({ ...row })), nextCursor: page.nextCursor };
  },
});
