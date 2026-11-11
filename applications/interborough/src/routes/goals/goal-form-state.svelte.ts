/**
 * Draft state for the form that makes a goal (`bureau.goals.create`) and the form that changes one
 * (`bureau.goals.update`), which are one form: what the agent should do, the check, the agent, and
 * the attempt limit (COR-2017, rows 68b to 68s). A plain rune-backed class, so validation and the
 * payloads are testable without a DOM.
 *
 * The Bureau takes more than the form asks for, and the form fills in the rest:
 *
 * - The goal's name is the first line of the prompt, and its version is always `1`.
 * - The check is a statement a person writes ("Reply says hello"). The Bureau names a check by an
 *   exact validator name, which is that statement as a slug (`reply-says-hello`) at version `1`, as
 *   the checks this host ships are named. A name that is already a slug, such as `demo:never-passes`,
 *   is sent as it is. A check opened from a goal and left as it was is sent as that goal's own
 *   validator, name and version exactly, so Edit never renames a check it did not change.
 * - A goal needs a bound on all its attempts together besides how many it may make, so the form
 *   always names the steps.
 *
 * The goal's view never carries its prompt, so a goal opened for Edit has an empty prompt that means
 * "keep the current one", and Start again opens with the goal's name as the first line.
 */
import { GOALS_COPY } from '../../app/copy.ts';
import type { AgentSummary } from '../../lib/bureau-client.ts';
import type { Goal, GoalChange, GoalInput } from '../../lib/bureau-goals.ts';
import { checkText } from './goal-rows.ts';

const copy = GOALS_COPY.form;

/** The fewest attempts a goal may be limited to. */
export const MINIMUM_ATTEMPTS = 1;

/** The most attempts a goal may be limited to. */
export const MAXIMUM_ATTEMPTS = 20;

/** Attempts a goal makes unless the person says otherwise. */
export const DEFAULT_MAXIMUM_ATTEMPTS = 5;

/** Steps, across all its attempts, every goal is bounded by: the Bureau needs one bound on them together. */
export const MAXIMUM_TOTAL_STEPS = 50;

/** The version every goal's name and every typed check is created at. */
export const FORM_VERSION = '1';

/** The fields that can have a problem, in the order the form draws them. */
export type GoalField = 'prompt' | 'check' | 'agent' | 'attempts';

/** The fields in the order the form draws them, so the first problem is the first one down the page. */
export const GOAL_FIELD_ORDER: readonly GoalField[] = ['prompt', 'check', 'agent', 'attempts'];

/** The `id` of each field's control, which a failed submit moves focus to. */
export const GOAL_FIELD_IDS: Readonly<Record<GoalField, string>> = {
  prompt: 'weft-goal-prompt',
  check: 'weft-goal-check',
  agent: 'weft-goal-agent',
  attempts: 'weft-goal-maximum-attempts',
};

/** What is wrong with each field, in the words shown at it. A field with nothing wrong has no key. */
export type GoalProblems = Partial<Record<GoalField, string>>;

/** A name already written as a validator's name: lowercase, with no spaces. */
const VALIDATOR_NAME = /^[a-z0-9][a-z0-9._:-]*$/;

/**
 * The validator name a typed check stands for: a name that is already one is kept, and a statement
 * is lowercased with each run of other characters made one hyphen ("Reply says hello" is
 * `reply-says-hello`).
 */
export function validatorNameOf(check: string): string {
  const text = check.trim();
  if (VALIDATOR_NAME.test(text)) return text;
  const slug = text
    .toLowerCase()
    .replaceAll(/[^a-z0-9._:]+/g, '-')
    .replaceAll(/^[-.:]+|[-.:]+$/g, '');
  return slug === '' ? text : slug;
}

/** The goal's name: the first line of its prompt that says something. */
export function goalNameOf(prompt: string): string {
  return (
    prompt
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== '') ?? ''
  );
}

type AgentChoice = Pick<AgentSummary, 'name' | 'media'>;

/**
 * The agent that needs no provider, which a goal starts with: Assistant when the catalog lists it,
 * else the first agent that names no model. A scripted agent names no model (`media` is null).
 */
export function scriptedAgent<Agent extends AgentChoice>(
  agents: readonly Agent[],
): Agent | undefined {
  const scripted = agents.filter((agent) => agent.media === null);
  return scripted.find((agent) => /(^|:)assistant$/i.test(agent.name)) ?? scripted[0];
}

/** The agent a new goal starts with: the scripted one, so nothing waits on a provider. */
export function defaultAgentName<Agent extends AgentChoice>(agents: readonly Agent[]): string {
  return (scriptedAgent(agents) ?? agents[0])?.name ?? '';
}

/**
 * Whether the agent chosen needs a model provider and none holds a key, so a goal cannot make
 * attempts yet. An agent that is not listed, a catalog that is not read, and providers the host
 * has not reported gate nothing: only a known model agent and a known absence of a key do.
 */
export function needsProvider(
  agents: readonly AgentChoice[] | undefined,
  agentName: string,
  providerConnected: boolean | undefined,
): boolean {
  const chosen = agents?.find((agent) => agent.name === agentName);
  return chosen !== undefined && chosen.media !== null && providerConnected === false;
}

/** What the form was opened from, kept so Edit sends only what changed. */
type Source = {
  readonly validator: Goal['validator'];
  readonly maximumAttempts: number;
};

export class GoalFormState {
  prompt = $state('');
  check = $state('');
  agentName = $state('');
  /** `null` while the field is empty, which is out of range. */
  maximumAttempts = $state<number | null>(DEFAULT_MAXIMUM_ATTEMPTS);
  /** Whether a submit has been tried, which is when the problems are shown. */
  attempted = $state(false);

  readonly #mode: 'create' | 'edit';
  #source: Source | undefined;

  constructor(mode: 'create' | 'edit' = 'create') {
    this.#mode = mode;
  }

  /**
   * Opens the form on `goal`: its agent, its check and its attempt limit. Start again also takes the
   * goal's name as the first line of the prompt, because the view carries no more of it. Edit leaves
   * the prompt empty, which keeps the one the goal has.
   */
  prefill(goal: Pick<Goal, 'agentName' | 'identity' | 'validator' | 'bounds'>): void {
    this.agentName = goal.agentName;
    this.check = checkText(goal.validator.name);
    this.maximumAttempts = goal.bounds.maximumAttempts;
    this.prompt = this.#mode === 'create' ? goal.identity.name.trim() : '';
    this.#source = { validator: goal.validator, maximumAttempts: goal.bounds.maximumAttempts };
  }

  /** Whether the attempt limit is a whole number from 1 to 20. */
  get attemptsValid(): boolean {
    const attempts = this.maximumAttempts;
    return (
      attempts !== null &&
      Number.isInteger(attempts) &&
      attempts >= MINIMUM_ATTEMPTS &&
      attempts <= MAXIMUM_ATTEMPTS
    );
  }

  /** What is wrong with each field now, whether or not a submit has been tried. */
  get problems(): GoalProblems {
    const problems: GoalProblems = {};
    // Edit leaves the prompt empty to keep the one the goal has.
    if (this.#mode === 'create' && this.prompt.trim() === '') problems.prompt = copy.promptRequired;
    if (this.check.trim() === '') problems.check = copy.checkRequired;
    if (this.agentName.trim() === '') problems.agent = copy.agentPlaceholder;
    if (!this.attemptsValid) problems.attempts = copy.maximumAttemptsInvalid;
    return problems;
  }

  /** The problems the form says so far: none until a submit is tried, then every one that is left. */
  get shownProblems(): GoalProblems {
    return this.attempted ? this.problems : {};
  }

  /** The first field down the page with a problem. */
  get firstProblem(): GoalField | undefined {
    const problems = this.problems;
    return GOAL_FIELD_ORDER.find((field) => problems[field] !== undefined);
  }

  get isValid(): boolean {
    return this.firstProblem === undefined;
  }

  /**
   * A submit was tried: the problems are shown from now on. Answers the field to focus, which is the
   * first with a problem, or `undefined` when the form can be sent.
   */
  attempt(): GoalField | undefined {
    this.attempted = true;
    return this.firstProblem;
  }

  /** The validator the check stands for: the goal's own while the check is as it was opened. */
  #validator(): { readonly name: string; readonly version: string } {
    const source = this.#source;
    const text = this.check.trim();
    if (source !== undefined && text === checkText(source.validator.name)) return source.validator;
    return { name: validatorNameOf(text), version: FORM_VERSION };
  }

  /** What the last request was, and the key it was sent under. Plain bookkeeping, not state. */
  #lastRequest = '';
  #lastKey = '';

  /**
   * The key for what the form holds now. It is the same for as long as the request is the same, so
   * sending one submission again after a lost answer is the same goal, and it is a new one as soon
   * as anything is changed, because the Bureau refuses a different request under a key it has seen.
   */
  #keyFor(request: Omit<GoalInput, 'idempotencyKey'>): string {
    const signature = JSON.stringify(request);
    if (signature !== this.#lastRequest) {
      this.#lastRequest = signature;
      this.#lastKey = crypto.randomUUID();
    }
    return this.#lastKey;
  }

  /** What `bureau.goals.create` is sent. Only valid when `isValid` is. */
  toInput(): GoalInput {
    const request = this.#request();
    return { ...request, idempotencyKey: this.#keyFor(request) };
  }

  #request(): Omit<GoalInput, 'idempotencyKey'> {
    const prompt = this.prompt.trim();
    return {
      agentName: this.agentName.trim(),
      prompt,
      identity: { name: goalNameOf(prompt), version: FORM_VERSION },
      validator: this.#validator(),
      maximumAttempts: this.maximumAttempts ?? DEFAULT_MAXIMUM_ATTEMPTS,
      maximumTotalSteps: MAXIMUM_TOTAL_STEPS,
    };
  }

  /**
   * What `bureau.goals.update` is sent: the fields the person changed, and nothing else. A prompt is
   * named only when one was typed, a check only when its text is not the one the form opened with,
   * and the attempt limit only when it moved. The agent is never named: a goal's agent cannot change.
   */
  toChange(): GoalChange {
    const source = this.#source;
    const prompt = this.prompt.trim();
    const validator = this.#validator();
    const attempts = this.maximumAttempts;
    return {
      ...(prompt === '' ? {} : { prompt }),
      ...(source !== undefined &&
      validator.name === source.validator.name &&
      validator.version === source.validator.version
        ? {}
        : { validator }),
      ...(attempts === null || attempts === source?.maximumAttempts
        ? {}
        : { maximumAttempts: attempts }),
    };
  }

  /** Whether `toChange` names anything, which is when a save has something to send. */
  get changed(): boolean {
    return Object.keys(this.toChange()).length > 0;
  }
}
