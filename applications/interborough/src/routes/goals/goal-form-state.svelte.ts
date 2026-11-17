/**
 * Draft state for the form that makes a goal (`bureau.goals.create`) and the form that changes one
 * (`bureau.goals.update`), which are one form: what the agent should do, the check, the agent, and
 * the attempt limit (COR-2017, rows 68b to 68s). A plain rune-backed class, so validation and the
 * payloads are testable without a DOM.
 *
 * The Bureau takes more than the form asks for, and the form fills in the rest:
 *
 * - The goal's name is the first line of the prompt, and its version is always `1`.
 * - The check is one the Bureau lists (`bureau.validators.list`, COR-2124): the form is given that
 *   catalog, and a check is chosen by the exact name and version of a row. A check that takes a
 *   configuration is drawn as a form from its JSON Schema, and what that form holds is sent with
 *   the name and version. A check opened from a goal is the goal's own validator, name, version and
 *   configuration exactly, even when the Bureau no longer lists it, so Edit never renames a check it
 *   did not change and sends the validator only when its name, version or configuration changed.
 * - A goal needs a bound on all its attempts together besides how many it may make, so the form
 *   always names the steps.
 *
 * The goal's view never carries its prompt, so a goal opened for Edit has an empty prompt that means
 * "keep the current one", and Start again opens with the goal's name as the first line.
 */
import { GOALS_COPY } from '../../app/copy/goals.ts';
import type { AgentSummary } from '../../lib/bureau-client.ts';
import type { Goal, GoalChange, GoalInput, GoalValidatorChoice } from '../../lib/bureau-goals.ts';
import type { GoalValidator } from '../../lib/bureau-validators.ts';
import { isSameJson } from '../../lib/contributed-configuration.ts';
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

/** The version every goal's name is created at. */
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

/**
 * The key a check is chosen by in the picker: its exact name and version. A version holds no `@`
 * (the Bureau refuses one), so the last `@` divides them whatever the name holds.
 */
export function checkKey(validator: { readonly name: string; readonly version: string }): string {
  return `${validator.name}@${validator.version}`;
}

/** The name and version a {@link checkKey} stands for, or `undefined` for text that is not one. */
export function parseCheckKey(key: string): { name: string; version: string } | undefined {
  const at = key.lastIndexOf('@');
  if (at <= 0 || at === key.length - 1) return undefined;
  return { name: key.slice(0, at), version: key.slice(at + 1) };
}

/** One choice of the picker: a check by its exact name and version, and the schema of what it takes. */
export type CheckChoice = {
  readonly key: string;
  readonly name: string;
  readonly version: string;
  /** The check's words, from its name alone ("Contains phrase"); a goal's own check adds its settings. */
  readonly label: string;
  /** The heading the picker lists it under: where it comes from. `undefined` for a check not listed. */
  readonly group: string | undefined;
  /** The JSON Schema of the configuration it takes, or `null` when it takes none. */
  readonly configuration: Readonly<Record<string, unknown>> | null;
  /** Whether the Bureau lists it. The goal's own check stays a choice when it no longer does. */
  readonly listed: boolean;
};

/** The heading a listed check goes under: "Built in", the plugin's name in words, or the owner's files. */
function groupOfSource(source: GoalValidator['source']): string {
  if (source.kind === 'bureau') return copy.checkGroups.builtIn;
  if (source.kind === 'bungalow') return copy.checkGroups.own;
  return checkText(source.name);
}

/** The check a new goal starts with: the first the Bureau lists, or none while it lists none. */
export function defaultCheckKey(
  validators: readonly Pick<GoalValidator, 'name' | 'version'>[],
): string {
  const first = validators[0];
  return first === undefined ? '' : checkKey(first);
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
  /** The configuration the goal's check holds, `undefined` when it holds none. */
  readonly configuration: unknown;
  readonly maximumAttempts: number;
};

/** A field the Bureau refused inside the check's configuration, by its path within it. */
export type ConfigurationIssue = {
  readonly path: readonly (string | number)[];
  readonly message: string;
};

export class GoalFormState {
  prompt = $state('');
  /** The key of the check chosen ({@link checkKey}), or an empty string while none is. */
  #check = $state('');
  /** What the chosen check's configuration form holds, or `undefined` while it holds nothing. */
  configuration = $state<unknown>(undefined);
  /** The Bureau's refusals of the configuration, each shown on the field its path names. */
  configurationIssues = $state<readonly ConfigurationIssue[]>([]);
  /** The checks the Bureau lists, or `undefined` while they are read or when they could not be. */
  validators = $state<readonly GoalValidator[] | undefined>(undefined);
  agentName = $state('');
  /** The name of the goal Edit opened on: the first line of the prompt it keeps, the most the view says of it. */
  currentName = $state('');
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
  prefill(
    goal: Pick<Goal, 'agentName' | 'identity' | 'validator' | 'validatorConfiguration' | 'bounds'>,
  ): void {
    this.agentName = goal.agentName;
    this.currentName = goal.identity.name.trim();
    this.maximumAttempts = goal.bounds.maximumAttempts;
    this.prompt = this.#mode === 'create' ? goal.identity.name.trim() : '';
    const configuration = goal.validatorConfiguration ?? undefined;
    this.#source = {
      validator: goal.validator,
      configuration,
      maximumAttempts: goal.bounds.maximumAttempts,
    };
    // The goal's own check is chosen, with its configuration, whether or not the Bureau lists it.
    this.#check = checkKey(goal.validator);
    this.configuration = configuration;
    this.configurationIssues = [];
  }

  /** The key of the check chosen, or an empty string while none is. */
  get check(): string {
    return this.#check;
  }

  /**
   * Chooses a check. Its configuration form starts over, with what the goal held when the check is
   * the goal's own, so a configuration is never kept for another check than the one it was written for.
   */
  set check(key: string) {
    if (key === this.#check) return;
    this.#check = key;
    const source = this.#source;
    this.configuration =
      source !== undefined && checkKey(source.validator) === key ? source.configuration : undefined;
    this.configurationIssues = [];
  }

  /**
   * The checks the picker offers: each the Bureau lists, then the goal's own when the Bureau no
   * longer lists it, so a goal opened for Edit never loses the check it has.
   */
  get choices(): readonly CheckChoice[] {
    const listed: CheckChoice[] = (this.validators ?? []).map((validator) => ({
      key: checkKey(validator),
      name: validator.name,
      version: validator.version,
      label: checkText(validator.name),
      group: groupOfSource(validator.source),
      configuration: validator.configuration,
      listed: true,
    }));
    const source = this.#source?.validator;
    if (source !== undefined && !listed.some((choice) => choice.key === checkKey(source))) {
      listed.push({
        key: checkKey(source),
        name: source.name,
        version: source.version,
        // Said as the goal's own page says it, with the settings the goal holds.
        label: checkText(source.name, this.#source?.configuration),
        group: undefined,
        // Its schema is unknown, so what the goal holds is kept and no form is drawn for it.
        configuration: null,
        listed: false,
      });
    }
    return listed;
  }

  /**
   * The settings a check the Bureau no longer lists still holds, as term and words, to be shown
   * read-only: there is no schema to draw a form from, and what the goal keeps is not lost. `undefined`
   * when the chosen check is listed, is not the goal's own, or holds none.
   */
  get storedSettings():
    readonly { readonly term: string; readonly definition: string }[] | undefined {
    const source = this.#source;
    const chosen = this.chosen;
    if (source === undefined || chosen === undefined || chosen.listed) return undefined;
    const held = source.configuration;
    if (held === undefined || held === null) return undefined;
    if (typeof held === 'object' && !Array.isArray(held)) {
      const rows = Object.entries(held).map(([term, value]) => ({
        term,
        definition: typeof value === 'string' ? value : JSON.stringify(value),
      }));
      return rows.length === 0 ? undefined : rows;
    }
    return [{ term: copy.checkSettingsTerm, definition: JSON.stringify(held) }];
  }

  /** The choice the form holds, or `undefined` while none is chosen or the chosen one is not offered. */
  get chosen(): CheckChoice | undefined {
    return this.choices.find((choice) => choice.key === this.#check);
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
    if (this.validators !== undefined && this.choices.length === 0) problems.check = copy.noChecks;
    else if (this.chosen === undefined) problems.check = copy.checkRequired;
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

  /**
   * The validator the check chosen stands for: its exact name and version, and what its configuration
   * form holds. A check that takes no configuration is sent none, whatever the form once held.
   */
  #validator(): GoalValidatorChoice {
    const chosen = this.chosen;
    const named = chosen ?? parseCheckKey(this.#check) ?? { name: '', version: '' };
    // A check the Bureau no longer lists has no known schema, so what the goal holds is kept as it is.
    const takesConfiguration =
      chosen === undefined || !chosen.listed || chosen.configuration !== null;
    return {
      name: named.name,
      version: named.version,
      ...(takesConfiguration && this.configuration !== undefined
        ? { configuration: this.configuration }
        : {}),
    };
  }

  /**
   * Whether the check is the one the form was opened with: the same name and version, and the same
   * configuration whatever order its keys came in.
   */
  #validatorUnchanged(validator: GoalValidatorChoice): boolean {
    const source = this.#source;
    return (
      source !== undefined &&
      validator.name === source.validator.name &&
      validator.version === source.validator.version &&
      isSameJson(validator.configuration ?? null, source.configuration ?? null)
    );
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
      ...(this.#validatorUnchanged(validator) ? {} : { validator }),
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
