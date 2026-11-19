/**
 * The browser's view of the Bureau's goals: `bureau.goals.*` (COR-1482), through the generated client.
 * A goal runs a catalog agent on a prompt until a validator the Bureau was configured with passes,
 * within bounds. A goal belongs to the principal that created it, and its view leaves out the
 * instructions, and a list leaves out its prompt too: it is the goal's control-plane state, where
 * it stands and what it has used. `get` adds the prompt and each attempt's validator feedback for
 * the goal's owner (COR-2425), which the edit form and the goal's page show. It does name the goal
 * (`identity`) and its check (`validator`), which a list titles a row with and shows on line two.
 *
 * `cancel` names the revision of the goal the caller read. A goal's revision advances on every write
 * to its record, a controller transition included, so a goal that moved since is refused instead of
 * being cancelled against a state the caller did not see. `update` always names it, for the same
 * reason.
 */
import { bureauClient, type BureauOutput } from './bureau-api.ts';
import type { Fetcher } from './bureau-client.ts';

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

type GoalRecord = BureauOutput<'bureau.goals.get'>;

/**
 * One attempt of a goal. `agentName` is the agent the attempt ran as, which is not the goal's
 * `agentName` once the goal's agent changed; a Bureau before it says none, which reads as the
 * goal's own agent.
 */
export type GoalAttempt = Omit<GoalRecord['attempts'][number], 'agentName'> & {
  readonly agentName?: string | undefined;
};

/** One goal as `bureau.goals.list`, `get`, and `create` show it. */
export type Goal = Omit<GoalRecord, 'attempts'> & { readonly attempts: readonly GoalAttempt[] };

/** One page of the caller's goals, oldest first, ended ones included. */
export type GoalPage = BureauOutput<'bureau.goals.list'>;

/** One page of goals, from `offset`. */
export async function listGoals(
  input: { readonly limit?: number; readonly offset?: number } = {},
  options?: Options,
): Promise<GoalPage> {
  return bureauClient['bureau.goals.list'](input, options);
}

/** One goal by its identifier (`bureau.goals.get`); a goal that is not the caller's is `NotFound`. */
export async function getGoal(goalRunId: string, options?: Options): Promise<Goal> {
  return bureauClient['bureau.goals.get']({ goalRunId }, options);
}

/** What the check said about one attempt (`bureau.goals.verdict`, COR-2112). */
export type GoalVerdict = BureauOutput<'bureau.goals.verdict'>;

/**
 * One attempt's verdict: its outcome, feedback, evidence, the configuration it was given and what
 * judged it. These are the goal's content, which the Bureau gives its owner and a caller holding
 * `bureau.goals:content`: any other caller, and an attempt with no verdict yet, is `NotFound`.
 */
export async function getGoalVerdict(
  goalRunId: string,
  attemptIndex: number,
  options?: Options,
): Promise<GoalVerdict> {
  return bureauClient['bureau.goals.verdict']({ goalRunId, attemptIndex }, options);
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

/**
 * A validator as a goal names it: the exact name and version the Bureau lists (`bureau.validators.list`),
 * and the configuration its schema takes, when it takes one.
 */
export type GoalValidatorChoice = {
  /** The validator's name, as the Bureau lists it. */
  readonly name: string;
  /** The validator's version, as the Bureau lists it. */
  readonly version: string;
  /** The validator's configuration, validated by the Bureau against the validator's own schema. */
  readonly configuration?: unknown;
};

/** What a goal is created from. The validator is one the Bureau lists. */
export type GoalInput = {
  readonly agentName: string;
  readonly prompt: string;
  readonly identity: { readonly name: string; readonly version: string };
  readonly validator: GoalValidatorChoice;
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

/** What creating a goal answers: the goal, and how its controller stood once the call returned. */
export type GoalCreated = BureauOutput<'bureau.goals.create'>;

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
  return bureauClient['bureau.goals.create'](params, options);
}

/** What cancelling answers: how far it has got, and the goal's status and revision. */
export type GoalCancelled = BureauOutput<'bureau.goals.cancel'>;

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
  return bureauClient['bureau.goals.cancel'](params, options);
}

/**
 * What a goal's Edit page changes (COR-2017): the four fields of New goal. Each field left out
 * keeps its value, and at least one is named. The change applies to the attempts the goal has not
 * yet made; an attempt already made keeps the check it ran against.
 */
export type GoalChange = {
  /** The goal's new prompt; omitted when it is unchanged. */
  readonly prompt?: string;
  /**
   * The agent the goal's next attempts run as; an attempt already made keeps the agent it ran as.
   * The Bureau changes it only while an attempt is in flight, and refuses it between attempts as a
   * `Conflict` (`agent-between-attempts`).
   */
  readonly agentName?: string;
  /** Named exactly as when the goal was created; sent only when its name, version or configuration changed. */
  readonly validator?: GoalValidatorChoice;
  /** It must leave room for an attempt beyond those already opened. */
  readonly maximumAttempts?: number;
};

/** What changing a goal answers: whether anything changed, and the goal's status and revision. */
export type GoalUpdated = BureauOutput<'bureau.goals.update'>;

/**
 * Changes a goal, if it is still at `expectedRevision` (`bureau.goals.update`). A goal that moved
 * since is a `StaleRevision` fault and nothing is written; saving starts no attempt.
 */
export async function updateGoal(
  goalRunId: string,
  expectedRevision: number,
  change: GoalChange,
  options?: Options,
): Promise<GoalUpdated> {
  const params = {
    goalRunId,
    expectedRevision,
    ...(change.prompt === undefined ? {} : { prompt: change.prompt }),
    ...(change.agentName === undefined ? {} : { agentName: change.agentName }),
    ...(change.validator === undefined ? {} : { validator: change.validator }),
    ...(change.maximumAttempts === undefined ? {} : { maximumAttempts: change.maximumAttempts }),
  };
  return bureauClient['bureau.goals.update'](params, options);
}
