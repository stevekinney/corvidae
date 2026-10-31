/**
 * The browser's view of the Bureau's goals: `bureau.goals.*` (COR-1482), parsed at the boundary.
 * A goal runs a catalog agent on a prompt until a validator the Bureau was configured with passes,
 * within bounds. A goal belongs to the principal that created it, and its view leaves out the
 * prompt and instructions: it is the goal's control-plane state, where it stands and what it has
 * used.
 *
 * `cancel` names the revision of the goal the caller read. A goal's revision advances on every write
 * to its record, a controller transition included, so a goal that moved since is refused instead of
 * being cancelled against a state the caller did not see.
 */
import { z } from 'zod';

import { callBureau, type Fetcher } from './bureau-client.ts';

type Options = { readonly signal?: AbortSignal; readonly fetch?: Fetcher };

/** Every status a goal can have. A goal that is `succeeded`, `exhausted`, `failed`, or `canceled` has ended. */
export const GOAL_STATUSES = [
  'pending',
  'running',
  'evaluating',
  'retrying',
  'succeeded',
  'exhausted',
  'failed',
  'canceled',
] as const;

/** Where a goal is in its life, from queued through to one of the ending statuses. */
export type GoalStatus = (typeof GOAL_STATUSES)[number];

/** The statuses a goal ends in: it starts no new attempt, and there is nothing left to cancel. */
const ENDED: ReadonlySet<GoalStatus> = new Set(['succeeded', 'exhausted', 'failed', 'canceled']);

/** Whether a goal has ended, so it starts no new attempt and has nothing left to cancel. */
export function goalHasEnded(status: GoalStatus): boolean {
  return ENDED.has(status);
}

const usageSchema = z.object({
  steps: z.number(),
  tokens: z.number(),
  costUsd: z.number().nullable(),
});

const goalSchema = z.object({
  goalRunId: z.string(),
  owner: z.string(),
  agentName: z.string(),
  status: z.enum(GOAL_STATUSES),
  terminalReason: z.string().nullable(),
  revision: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  closedAt: z.string().nullable(),
  cancellation: z.object({ requestedAt: z.string(), reason: z.string().nullable() }).nullable(),
  bounds: z.object({
    maximumAttempts: z.number(),
    maximumTotalDurationMs: z.number().nullable(),
    maximumTotalSteps: z.number().nullable(),
    maximumTotalTokens: z.number().nullable(),
    maximumTotalCostUsd: z.number().nullable(),
  }),
  usage: usageSchema.extend({ attempts: z.number(), durationMs: z.number() }),
  attempts: z.array(
    z.object({
      attemptId: z.string(),
      attemptIndex: z.number().int(),
      runId: z.string(),
      /** The session the attempt ran in, which `bureau.contexts.get` reads. */
      sessionId: z.string(),
      status: z.enum(['running', 'evaluating', 'passed', 'failed', 'aborted']),
      startedAt: z.string(),
      completedAt: z.string().nullable(),
      finishReason: z.string().nullable(),
      usage: usageSchema,
    }),
  ),
});

/** One goal as `bureau.goals.list`, `get`, and `create` show it. */
export type Goal = z.infer<typeof goalSchema>;

const pageSchema = z.object({ goals: z.array(goalSchema), nextOffset: z.number().nullable() });

/** One page of the caller's goals, oldest first, ended ones included. */
export type GoalPage = z.infer<typeof pageSchema>;

/** One page of goals, from `offset`. */
export async function listGoals(
  input: { readonly limit?: number; readonly offset?: number } = {},
  options?: Options,
): Promise<GoalPage> {
  return pageSchema.parse(await callBureau('bureau.goals.list', input, options));
}

/** One goal by its identifier (`bureau.goals.get`); a goal that is not the caller's is `NotFound`. */
export async function getGoal(goalRunId: string, options?: Options): Promise<Goal> {
  return goalSchema.parse(await callBureau('bureau.goals.get', { goalRunId }, options));
}

/** How many goals one request of {@link listAllGoals} asks for. */
const GOALS_PAGE_SIZE = 100;

/**
 * Every goal the caller owns: pages are read, `nextOffset` followed, until the Bureau says there
 * are no more. A reader that took one page would lose the attempts of every goal after the first
 * hundred. An offset that does not move forward ends the read, so a Bureau that repeats itself
 * cannot loop it.
 */
export async function listAllGoals(options?: Options): Promise<Goal[]> {
  const goals: Goal[] = [];
  let offset = 0;
  for (;;) {
    const page = await listGoals({ limit: GOALS_PAGE_SIZE, offset }, options);
    goals.push(...page.goals);
    if (page.nextOffset === null || page.nextOffset <= offset) return goals;
    offset = page.nextOffset;
  }
}

/** What a goal is created from. A validator is named by free text, exactly, because the Bureau holds its own. */
export type GoalInput = {
  readonly agentName: string;
  readonly prompt: string;
  readonly identity: { readonly name: string; readonly version: string };
  readonly validator: { readonly name: string; readonly version: string };
  readonly maximumAttempts: number;
  /**
   * A goal needs at least one bound on all its attempts together, besides how many it may make: steps,
   * tokens, duration, or cost. The Bureau refuses one with none (`missing-aggregate-bound`), so the
   * browser always names the steps.
   */
  readonly maximumTotalSteps: number;
  /**
   * Makes the call idempotent for the caller: a request repeated under the same key is the same
   * goal, so a submit whose answer was lost and is sent again cannot make a second one. A different
   * request under a key it has used is refused, so the key follows the request.
   */
  readonly idempotencyKey: string;
};

const createdSchema = z.object({
  outcome: z.enum(['created', 'existing']),
  goal: goalSchema,
  controller: z
    .object({
      status: z.enum(['started', 'not-needed', 'start-failed']),
      reason: z.string().nullable(),
    })
    .nullable(),
});

/** What creating a goal answers: the goal, and how its controller stood once the call returned. */
export type GoalCreated = z.infer<typeof createdSchema>;

/**
 * Creates a goal the caller owns. A validator the Bureau lacks is an `Unprocessable` fault, and an
 * agent that is not in its catalog is `NotFound`.
 */
export async function createGoal(goal: GoalInput, options?: Options): Promise<GoalCreated> {
  const params = {
    idempotencyKey: goal.idempotencyKey,
    agentName: goal.agentName,
    prompt: goal.prompt,
    identity: goal.identity,
    validator: goal.validator,
    bounds: { maximumAttempts: goal.maximumAttempts, maximumTotalSteps: goal.maximumTotalSteps },
  };
  return createdSchema.parse(await callBureau('bureau.goals.create', params, options));
}

const cancelSchema = z.object({
  goalRunId: z.string(),
  outcome: z.enum(['canceled', 'cancellation-pending', 'already-terminal', 'contended']),
  status: z.enum(GOAL_STATUSES),
  revision: z.number().int(),
});

/** What cancelling answers: how far it has got, and the goal's status and revision. */
export type GoalCancelled = z.infer<typeof cancelSchema>;

/** Cancels a goal, if it is still at `expectedRevision`. */
export async function cancelGoal(
  goalRunId: string,
  expectedRevision: number | undefined,
  options?: Options,
): Promise<GoalCancelled> {
  const params = {
    goalRunId,
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
  };
  return cancelSchema.parse(await callBureau('bureau.goals.cancel', params, options));
}
