/**
 * The agent editor's form: what a person has typed, and what saving it would send.
 *
 * An agent is a Markdown file whose name is its identifier, so the form works from three facts the
 * Bureau holds. The catalog says which models and tools an agent may name. The loaded definition
 * says what the file holds now, `card` included, which the editor never edits and sends back
 * unchanged. The `hash` says which version of the file the form was filled from, and every write
 * names it, so a file that changed since is refused rather than overwritten.
 */
import { AGENT_EDITOR_COPY, EFFORT_LABELS } from '../../app/copy.ts';
import {
  AGENT_IDENTIFIER_MAX_LENGTH,
  AGENT_IDENTIFIER_PATTERN,
  EFFORTS,
  guardrailEntriesFor,
  guardrailEntryId,
  type AgentCatalog,
  type AgentDefinitionInput,
  type AgentDetail,
  type AgentGuardrailEntry,
  type AgentSkill,
  type Effort,
  type IdentifierConflictReason,
  type ToolApproval,
} from '../../lib/agent-definitions.ts';
import { standingOf, type ToolStanding } from '../../lib/tool-standing.ts';
import {
  canonicalModel,
  choiceOf,
  firstAvailableModel,
  modelGroups,
  NO_RESTRICTIONS,
  type ModelChoice,
  type ModelGroup,
  type ModelRestrictions,
} from './agent-editor-models.ts';

/**
 * An identifier the Bureau accepts and the editor refuses: `/agents/new` creates an agent, so an
 * agent whose identifier is `new` could be saved and then never opened.
 */
export const RESERVED_IDENTIFIER = 'new';

/**
 * The bounds the Bureau puts on a limit (`agent-file.ts`). The editor refuses a number outside them
 * before a save, so the person reads the reason beside the field instead of in a refused write.
 */
export const LIMIT_BOUNDS = {
  stepLimit: 1000,
  spendUsd: 1_000_000,
  toolCalls: 100_000,
  toolSeconds: 86_400,
} as const;

/** The limit and guardrail fields, so an error can be asked for by field. */
export type LimitField =
  'guardrails' | 'stepLimit' | 'spendPerRun' | 'spendPerChat' | 'toolCalls' | 'toolSeconds';

/** What a limit field holds: no limit (`null`), a number, or something that is not a valid number (`undefined`). */
export function parseLimit(
  text: string,
  whole: boolean,
  maximum: number,
): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0 || value > maximum) return undefined;
  return whole && !Number.isInteger(value) ? undefined : value;
}

/** The guardrail ids a field holds, separated by commas, spaces or new lines. */
export function parseGuardrails(text: string): string[] {
  return text.split(/[\s,]+/).filter((entry) => entry !== '');
}

/** Whether an id is a plugin contribution, `plugin:name`. */
export function isContributionId(id: string): boolean {
  const separator = id.indexOf(':');
  return separator > 0 && separator < id.length - 1;
}

/** The limit and guardrail fields as typed: what both the editor and the Access tab hold. */
export type LimitFields = Readonly<Record<LimitField, string>>;

/** Why each of `fields` cannot be saved as typed, in words; a field with nothing wrong has no entry. */
export function limitErrorsOf(fields: LimitFields): Readonly<Partial<Record<LimitField, string>>> {
  const copy = AGENT_EDITOR_COPY.limits.errors;
  const errors: Partial<Record<LimitField, string>> = {};
  if (!parseGuardrails(fields.guardrails).every(isContributionId)) {
    errors.guardrails = copy.guardrails;
  }
  if (parseLimit(fields.stepLimit, true, LIMIT_BOUNDS.stepLimit) === undefined) {
    errors.stepLimit = copy.stepLimit(LIMIT_BOUNDS.stepLimit);
  }
  const perRun = parseLimit(fields.spendPerRun, false, LIMIT_BOUNDS.spendUsd);
  if (perRun === undefined) errors.spendPerRun = copy.spend(LIMIT_BOUNDS.spendUsd);
  const perChat = parseLimit(fields.spendPerChat, false, LIMIT_BOUNDS.spendUsd);
  if (perChat === undefined) errors.spendPerChat = copy.spend(LIMIT_BOUNDS.spendUsd);
  else if (perChat !== null && perRun === null) errors.spendPerChat = copy.chatNeedsRun;
  if (parseLimit(fields.toolCalls, true, LIMIT_BOUNDS.toolCalls) === undefined) {
    errors.toolCalls = copy.toolCalls(LIMIT_BOUNDS.toolCalls);
  }
  if (parseLimit(fields.toolSeconds, false, LIMIT_BOUNDS.toolSeconds) === undefined) {
    errors.toolSeconds = copy.toolSeconds(LIMIT_BOUNDS.toolSeconds);
  }
  return errors;
}

/**
 * The limits of `fields` as the Bureau takes them: a field left empty is `null`, which removes the
 * limit. `warn` is the file's own, which neither surface edits and a save sends back. A surface
 * that does not edit the step limit (`editsSteps` false, the Access tab) leaves `steps` out of
 * `limits`, so a save keeps the file's step limit instead of removing it.
 */
export function limitsOf(
  fields: LimitFields,
  warn: readonly number[] | undefined,
  editsSteps = true,
  keptGuardrails: readonly AgentGuardrailEntry[] | null = null,
): Pick<AgentDefinitionInput, 'guardrails' | 'limits'> {
  // The field holds ids alone; an id the file configures keeps its configuration (COR-2118).
  const guardrails = guardrailEntriesFor(parseGuardrails(fields.guardrails), keptGuardrails);
  const perRun = parseLimit(fields.spendPerRun, false, LIMIT_BOUNDS.spendUsd) ?? null;
  const perChat = parseLimit(fields.spendPerChat, false, LIMIT_BOUNDS.spendUsd) ?? null;
  const calls = parseLimit(fields.toolCalls, true, LIMIT_BOUNDS.toolCalls) ?? null;
  const seconds = parseLimit(fields.toolSeconds, false, LIMIT_BOUNDS.toolSeconds) ?? null;
  return {
    guardrails: guardrails.length === 0 ? null : guardrails,
    limits: {
      ...(editsSteps
        ? { steps: parseLimit(fields.stepLimit, true, LIMIT_BOUNDS.stepLimit) ?? null }
        : {}),
      cost:
        perRun === null
          ? null
          : {
              run: perRun,
              ...(perChat === null ? {} : { chat: perChat }),
              ...(warn === undefined ? {} : { warn }),
            },
      tools:
        calls === null && seconds === null
          ? null
          : {
              ...(calls === null ? {} : { calls }),
              ...(seconds === null ? {} : { seconds }),
            },
    },
  };
}

/** An identifier a name suggests: lowercase letters and digits, joined by single hyphens. */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, AGENT_IDENTIFIER_MAX_LENGTH);
  return slug.replace(/-+$/, '');
}

/**
 * What the model field is narrowed by besides the catalog: the providers the host reports, with
 * whether each has a key, and what the model policy forbids. Either is left out when it could not
 * be read, and the field then offers what the catalog lists.
 */
export type ModelContext = {
  readonly hostProviders?:
    readonly { readonly name: string; readonly hasKey: boolean }[] | undefined;
  readonly restrictions?: ModelRestrictions | undefined;
};

/** The fields of an agent definition a form is filled from: a file agent's, or a copy's. */
export type DefinitionSeed = NonNullable<AgentDetail['definition']>;

/**
 * The catalog of a form built before the catalog could be read (row 42v): nothing to offer yet. The
 * form keeps what is typed, and adopts the catalog when a retry reads it
 * ({@link AgentEditorState.withCatalog}).
 */
const NO_CATALOG: AgentCatalog = { models: [], tools: [] };

/** Why a model the agent names cannot be saved as it is: the Bureau refuses each of these. */
const REFUSED_MODEL_REASONS: ReadonlySet<string> = new Set([
  'provider-denied',
  'model-denied',
  'retired',
  'not-in-catalog',
]);

/**
 * The id of the element a submit focuses for each field that can stop a save, in the order the form
 * shows them, so the first problem is the first one a person reads.
 */
export const FIELD_IDS = {
  name: 'agent-name',
  identifier: 'agent-identifier',
  model: 'agent-model',
  effort: 'agent-default-effort',
  guardrails: 'agent-guardrails',
  stepLimit: 'agent-step-limit',
  spendPerRun: 'agent-spend-per-run',
  spendPerChat: 'agent-spend-per-chat',
  toolCalls: 'agent-tool-calls',
  toolSeconds: 'agent-tool-seconds',
} as const;

/** The parts of the form the leave question names, in the form's order (row 42o). */
type FormPart =
  'name' | 'identifier' | 'description' | 'model' | 'instructions' | 'tools' | 'limits' | 'a2a';

/** The words the leave question uses for each part of the form. */
const PART_LABELS: Readonly<Record<FormPart, string>> = {
  name: AGENT_EDITOR_COPY.nameLabel,
  identifier: AGENT_EDITOR_COPY.identifierLabel,
  description: AGENT_EDITOR_COPY.descriptionLabel,
  model: AGENT_EDITOR_COPY.sections.model,
  instructions: AGENT_EDITOR_COPY.sections.instructions,
  tools: AGENT_EDITOR_COPY.sections.tools,
  limits: AGENT_EDITOR_COPY.sections.limits,
  a2a: AGENT_EDITOR_COPY.a2aLabel,
};

/** The parts in the form's order. */
const FORM_PARTS: readonly FormPart[] = [
  'name',
  'identifier',
  'description',
  'model',
  'instructions',
  'tools',
  'limits',
  'a2a',
];

/** The limit fields in the form's order, for the first problem a submit focuses. */
const LIMIT_FIELDS: readonly LimitField[] = [
  'guardrails',
  'stepLimit',
  'spendPerRun',
  'spendPerChat',
  'toolCalls',
  'toolSeconds',
];

/** The number of words in `text`, as the Instructions counter shows it (row 41i). */
export function wordCount(text: string): number {
  return text.split(/\s+/).filter((word) => word !== '').length;
}

export class AgentEditorState {
  readonly mode: 'create' | 'edit';
  /** The identifier of the agent being edited. A new agent has none until it is named. */
  readonly #editedId: string | undefined;
  /** The models grouped by provider, as the field lists them; fixed when the form is built. */
  readonly modelGroups: readonly ModelGroup[];
  /** Whether the catalog holds any model row at all, offered or not. */
  readonly #catalogHasModels: boolean;
  readonly toolChoices: AgentCatalog['tools'];
  /** `card` is carried through a save untouched. */
  readonly card: readonly AgentSkill[];
  /**
   * The skills a run may activate, as the file lists them, or `null` when it lists none. The Access
   * tab edits them. They are carried through a save so a copy of an agent keeps them; an update
   * that left them out would keep the file's too, but a create would have none.
   */
  readonly skills: readonly string[] | null;
  readonly children: readonly string[] | null;
  /**
   * The models a session may be switched to (COR-1559), as the file lists them, or `null` when it
   * lists none. Carried through a save untouched, like `card`: the editor shows no control for
   * it, and an update that left it out would remove the list.
   */
  readonly models: readonly string[] | null;
  /** The model the file wrote, and the option it names, so an unchanged model is written back as it was. */
  readonly #writtenModel: string;
  readonly #writtenModelOption: string;
  /** The effort the file wrote, so a cleared field is sent as `null` (which removes it) and not left out. */
  readonly #writtenEffort: Effort | null;

  name = $state('');
  description = $state('');
  #model = $state('');
  /**
   * The effort a chat of the agent starts at, or `''` for none. The default model must support it
   * (`effortChoices`); choosing another model clears one the new model cannot do.
   */
  effort = $state<Effort | ''>('');
  /** The effort a change of model cleared, and the model that could not do it, until another is chosen. */
  #clearedEffort = $state<{ readonly effort: Effort; readonly model: string } | null>(null);
  tools = $state<string[]>([]);
  instructions = $state('');
  /** The hash of the file this form was filled from; every write names it. `null` for a new agent. */
  hash = $state<string | null>(null);
  /** Whether the agent opts into A2A. Saved with the rest of the definition. */
  a2a = $state(false);
  /** The plugin guardrails the agent runs besides the default preset, as typed: `plugin:name` entries. */
  guardrails = $state('');
  /** The most steps a run may take, as typed. Empty is no limit, and so are the four below. */
  stepLimit = $state('');
  /** What one run may spend, in US dollars, as typed. */
  spendPerRun = $state('');
  /** What one chat may spend, in US dollars, as typed. A chat limit needs a run limit. */
  spendPerChat = $state('');
  /** The most tool calls one run may make, as typed. */
  toolCalls = $state('');
  /** The longest one run's tools may be called, in seconds, as typed. */
  toolSeconds = $state('');
  /** The fractions at which a run warns about its spend: not edited here, carried through a save. */
  readonly #warnAt: readonly number[] | undefined;
  /**
   * The guardrails as the file lists them, configurations included (COR-2118): the form edits the
   * ids, and a save keeps the configuration of each id it still lists.
   */
  #keptGuardrails: readonly AgentGuardrailEntry[] | null = null;
  /**
   * When each tool asks first, as the file wrote it (the Access tab edits it, and a new agent's form
   * sets it per row, row 41l): carried through a save, pruned to the tools still chosen, because
   * the Bureau refuses a file whose `approvals` names a tool that `tools` does not.
   */
  #approvals = $state<Readonly<Record<string, ToolApproval>> | null>(null);

  /** Whether the form was built before the catalog could be read, so it offers nothing yet (row 42v). */
  readonly catalogMissing: boolean;

  /** Set by the first submit: from then on each field that stops a save says why (rows 42m, 42y). */
  #attempted = $state(false);

  /** What each part of the form held when it was built, so the leave question names what changed. */
  #baseline: Readonly<Record<FormPart, string>> | undefined;

  /**
   * The documents the file's `references` name, beside it. A save of an existing agent leaves them
   * to the file (an update that omits `references` keeps them); a copy is created with them, since it
   * lands in the directory they sit in (a plugin's agent is refused by the Bureau); a trial runs
   * without them, because there is no file for them to sit beside.
   */
  readonly references: readonly string[];

  /** The tools a copy was seeded with, before the catalog's offer was applied. */
  #seededTools: readonly string[] = [];

  /**
   * What the file says about retries, compaction and interceptors, which the editor shows no control
   * for: carried through a save, and into a copy.
   */
  readonly #carried: Pick<AgentDefinitionInput, 'retry' | 'compaction' | 'interceptors'>;

  /** What the person typed into the identifier field, or `null` while it follows the name. */
  #typedIdentifier = $state<string | null>(null);
  /** The identifier the Bureau refused, and why, so the answer goes when the identifier changes. */
  #taken = $state<{
    readonly identifier: string;
    readonly reason: IdentifierConflictReason;
  } | null>(null);

  private constructor(
    mode: 'create' | 'edit',
    catalog: AgentCatalog,
    detail: AgentDetail | undefined,
    context: ModelContext,
    seed?: DefinitionSeed,
  ) {
    this.mode = mode;
    this.catalogMissing = catalog === NO_CATALOG;
    this.toolChoices = catalog.tools;
    const definition = seed ?? detail?.definition ?? null;
    this.#editedId = detail?.id;
    this.card = definition?.card ?? [];
    this.skills = definition?.skills ?? null;
    this.children = definition?.children ?? null;
    this.models = definition?.models ?? null;
    this.#writtenEffort = definition?.effort ?? null;
    this.#warnAt = definition?.limits.cost?.warn;
    this.#approvals = definition?.approvals ?? null;
    this.references = definition?.references ?? [];
    this.#carried = {
      ...(definition?.retry == null ? {} : { retry: definition.retry }),
      ...(definition?.compaction == null ? {} : { compaction: definition.compaction }),
      ...(definition?.interceptors == null ? {} : { interceptors: definition.interceptors }),
    };
    this.#writtenModel = definition?.model ?? '';
    // The option the file's model names. A model the catalog lacks stays the selection under the
    // name the file wrote, so a save does not change it for another.
    const listed = canonicalModel(this.#writtenModel, catalog);
    this.#writtenModelOption = listed === '' ? this.#writtenModel : listed;
    this.#catalogHasModels = catalog.models.length > 0;
    this.modelGroups = modelGroups(
      catalog,
      context.hostProviders,
      context.restrictions ?? NO_RESTRICTIONS,
      listed === '' && this.#writtenModel !== '' ? this.#writtenModel : undefined,
    );
    if (definition === null) {
      this.#model = firstAvailableModel(this.modelGroups);
      return;
    }
    this.name = definition.name;
    this.description = definition.description ?? '';
    // A copy of an agent that names no model (a scripted one) starts on the first model offered.
    this.#model =
      this.#writtenModelOption === ''
        ? firstAvailableModel(this.modelGroups)
        : this.#writtenModelOption;
    this.effort = this.#writtenEffort ?? '';
    this.tools = [...definition.tools];
    if (mode === 'create') this.#seededTools = definition.tools;
    this.instructions = definition.instructions;
    this.hash = detail?.hash ?? null;
    this.a2a = definition.a2a;
    this.#keptGuardrails = definition.guardrails;
    this.guardrails = (definition.guardrails ?? []).map(guardrailEntryId).join('\n');
    this.stepLimit = definition.limits.steps === null ? '' : String(definition.limits.steps);
    this.spendPerRun = definition.limits.cost === null ? '' : String(definition.limits.cost.run);
    this.spendPerChat =
      definition.limits.cost?.chat === undefined ? '' : String(definition.limits.cost.chat);
    this.toolCalls =
      definition.limits.tools?.calls === undefined ? '' : String(definition.limits.tools.calls);
    this.toolSeconds =
      definition.limits.tools?.seconds === undefined ? '' : String(definition.limits.tools.seconds);
  }

  /** A form for a new agent, with the first model that can be chosen. */
  static create(catalog: AgentCatalog, context: ModelContext = {}): AgentEditorState {
    return new AgentEditorState('create', catalog, undefined, context).#settled();
  }

  /**
   * A form for a new agent built while the catalog could not be read (row 42v): it offers no model
   * and no tool, says so at the Model field, and keeps what is typed until {@link withCatalog}.
   */
  static withoutCatalog(context: ModelContext = {}): AgentEditorState {
    return new AgentEditorState('create', NO_CATALOG, undefined, context).#settled();
  }

  /**
   * This new agent's form again, built from a catalog that has now been read, with what was typed
   * carried over: the name, the identifier if it was typed, the description, the instructions and
   * the A2A switch. The model is the first one offered, and what counts as changed is still
   * measured from the form as it was first built.
   */
  withCatalog(catalog: AgentCatalog, context: ModelContext = {}): AgentEditorState {
    const next = new AgentEditorState('create', catalog, undefined, context);
    next.name = this.name;
    next.#typedIdentifier = this.#typedIdentifier;
    next.description = this.description;
    next.instructions = this.instructions;
    next.a2a = this.a2a;
    next.#attempted = this.#attempted;
    // The model the catalog starts the form on was not chosen by the person, so it is no change.
    const chosen = next.#parts();
    next.#baseline =
      this.#baseline === undefined ? undefined : { ...this.#baseline, model: chosen.model };
    return next;
  }

  /** Records what the form holds now as what it was built with: nothing has changed yet. */
  #settled(): AgentEditorState {
    this.#baseline = this.#parts();
    return this;
  }

  /**
   * A form for a new agent filled from `seed`, the definition of an agent being duplicated: a file
   * agent's, or a built-in agent's `codeDefinition` read as one (`agent-copy.ts`). Nothing is
   * written until it is saved, and the copy has no hash, so a save creates it. The identifier
   * starts as `identifier` (empty follows the name), which the person may change, and a taken one
   * is refused as for any new agent.
   */
  static copy(
    seed: DefinitionSeed,
    identifier: string,
    catalog: AgentCatalog,
    context: ModelContext = {},
  ): AgentEditorState {
    const state = new AgentEditorState('create', catalog, undefined, context, seed);
    if (identifier !== '') state.#typedIdentifier = identifier;
    return state.#settled();
  }

  /** A form filled from an agent file that loaded. */
  static edit(
    detail: AgentDetail,
    catalog: AgentCatalog,
    context: ModelContext = {},
  ): AgentEditorState {
    if (detail.definition === null || detail.hash === null) {
      throw new TypeError(`The agent "${detail.id}" has no definition to edit.`);
    }
    return new AgentEditorState('edit', catalog, detail, context).#settled();
  }

  /** The agent's identifier: fixed once it exists, otherwise what the person typed or the name suggests. */
  get identifier(): string {
    if (this.#editedId !== undefined) return this.#editedId;
    return this.#typedIdentifier ?? slugify(this.name);
  }

  set identifier(value: string) {
    if (this.#editedId === undefined) this.#typedIdentifier = value;
  }

  /** Why the identifier cannot be used, in words, or `''` when nothing is wrong with it yet. */
  get identifierError(): string {
    if (this.mode === 'edit') return '';
    if (this.#takenNow()) return AGENT_EDITOR_COPY.identifierTaken(this.identifier);
    // A typed identifier left empty says what it needs; one that follows an empty name says nothing.
    if (this.identifier === '' && !this.identifierFollowsName) {
      return AGENT_EDITOR_COPY.identifierInvalid;
    }
    if (this.identifier === RESERVED_IDENTIFIER) return AGENT_EDITOR_COPY.identifierReserved;
    return this.identifier !== '' && !this.#identifierIsValid()
      ? AGENT_EDITOR_COPY.identifierInvalid
      : '';
  }

  /** Records that the Bureau refused the identifier as it is now. */
  markIdentifierTaken(reason: IdentifierConflictReason): void {
    this.#taken = { identifier: this.identifier, reason };
  }

  /** Whether the Bureau refused the identifier as it is now. */
  #takenNow(): boolean {
    const taken = this.#taken;
    return taken !== null && taken.identifier === this.identifier;
  }

  /**
   * Whether the identifier still follows the name (rows 41e, 42x): a new agent's does until Change
   * is pressed, and a copy's starts as a field that holds the identifier the copy suggests.
   */
  get identifierFollowsName(): boolean {
    return this.mode === 'create' && this.#typedIdentifier === null;
  }

  /** The identifier the name sets, which Reset puts back (row 42x). */
  get suggestedIdentifier(): string {
    return slugify(this.name);
  }

  /** Change (rows 41e, 42x): the identifier becomes a field, holding the one the name set. */
  changeIdentifier(): void {
    if (this.mode === 'create' && this.#typedIdentifier === null) {
      this.#typedIdentifier = this.identifier;
    }
  }

  /** Reset (row 42x): the identifier follows the name again. */
  resetIdentifier(): void {
    if (this.mode === 'create') this.#typedIdentifier = null;
  }

  /** Whether a submit has been tried, so each field that stops a save says why. */
  get attempted(): boolean {
    return this.#attempted;
  }

  /** Records a submit: from now on each field that stops a save says why at the field. */
  attempt(): void {
    this.#attempted = true;
  }

  /**
   * Why the name cannot be saved, in words, or `''`. A new agent's identifier comes from its name
   * while it follows it, so what is wrong with that identifier is said at the name (rows 42m, 42n).
   */
  get nameError(): string {
    if (!this.identifierFollowsName) return '';
    const copy = AGENT_EDITOR_COPY.newAgent;
    if (this.name.trim() === '') return copy.nameRequired;
    if (this.#takenNow()) return copy.nameTaken(this.name.trim());
    if (this.identifier === RESERVED_IDENTIFIER) return AGENT_EDITOR_COPY.identifierReserved;
    return this.identifier === '' ? copy.nameNeedsLetters : '';
  }

  /** Why the model cannot be saved, in words, or `''`: a form with no model cannot (row 42m). */
  get modelError(): string {
    return this.model === '' ? AGENT_EDITOR_COPY.newAgent.modelRequired : '';
  }

  /**
   * Whether the chosen model is one the Bureau refuses at a save (one the policy forbids, or one
   * retired or gone from the catalog): a submit still sends it, so the Bureau's reason shows, and
   * focuses the field whose notice says so (row 43s).
   */
  get modelRefused(): boolean {
    const unavailable = this.chosenModel?.unavailable;
    return unavailable !== undefined && REFUSED_MODEL_REASONS.has(unavailable);
  }

  /**
   * The messages the name, identifier and model fields show: none until a submit, then why each
   * stops a save (rows 42m, 42y). A refusal from the Bureau answers a submit, so it shows as soon as
   * it comes. The effort and limit fields say what is wrong as it is typed, and are not here.
   */
  get shownErrors(): {
    readonly name: string;
    readonly identifier: string;
    readonly model: string;
  } {
    const follows = this.identifierFollowsName;
    if (!this.#attempted && !this.#takenNow()) return { name: '', identifier: '', model: '' };
    return {
      name: follows ? this.nameError : '',
      identifier: follows ? '' : this.identifierError,
      model: this.#attempted ? this.modelError : '',
    };
  }

  /**
   * The id of the field a submit focuses: the first one, in the form's order, that stops a save, or
   * the Model field when the Bureau will refuse its model; `undefined` when there is none (rows 14u,
   * 43s, W35).
   */
  get firstProblem(): string | undefined {
    if (this.mode === 'create') {
      const follows = this.identifierFollowsName;
      if (follows && this.nameError !== '') return FIELD_IDS.name;
      if (!follows && (this.identifierError !== '' || this.identifier === '')) {
        return FIELD_IDS.identifier;
      }
    }
    if (!this.hasModels || this.modelError !== '' || this.modelRefused) return FIELD_IDS.model;
    if (this.effortError !== '') return FIELD_IDS.effort;
    const limits = this.limitErrors;
    const field = LIMIT_FIELDS.find((candidate) => limits[candidate] !== undefined);
    return field === undefined ? undefined : FIELD_IDS[field];
  }

  /** What each part of the form holds now, as text the leave question compares. */
  #parts(): Record<FormPart, string> {
    return {
      name: this.name,
      identifier: this.#typedIdentifier ?? '',
      description: this.description,
      model: `${this.model}\n${this.effort}`,
      instructions: this.instructions,
      tools: JSON.stringify([
        [...this.tools].sort(),
        Object.entries(this.#approvals ?? {}).sort(([left], [right]) => left.localeCompare(right)),
      ]),
      limits: [
        this.guardrails,
        this.stepLimit,
        this.spendPerRun,
        this.spendPerChat,
        this.toolCalls,
        this.toolSeconds,
      ].join('\n'),
      a2a: String(this.a2a),
    };
  }

  /**
   * The parts of the form that differ from what it was built with, in its order, in the words the
   * leave question names them (row 42o). Empty while nothing has changed, so a new agent with
   * nothing typed is left without asking (row 42p).
   */
  get changedParts(): readonly string[] {
    const baseline = this.#baseline;
    if (baseline === undefined) return [];
    const now = this.#parts();
    return FORM_PARTS.filter((part) => now[part] !== baseline[part]).map(
      (part) => PART_LABELS[part],
    );
  }

  /** Whether anything in the form differs from what it was built with. */
  get changed(): boolean {
    return this.changedParts.length > 0;
  }

  /** How many words the instructions hold, for the counter beside their label (row 41i). */
  get instructionWords(): number {
    return wordCount(this.instructions);
  }

  #identifierIsValid(): boolean {
    return (
      this.identifier !== RESERVED_IDENTIFIER &&
      this.identifier.length <= AGENT_IDENTIFIER_MAX_LENGTH &&
      AGENT_IDENTIFIER_PATTERN.test(this.identifier)
    );
  }

  /**
   * The tools a copy was seeded with and the catalog does not offer, which a save leaves out. Empty
   * for a form that was not seeded, and for an agent whose tools are all offered.
   */
  get droppedTools(): readonly string[] {
    const offered = new Set(this.toolChoices.map((tool) => tool.name));
    return this.#seededTools.filter((tool) => !offered.has(tool));
  }

  /** Whether the catalog holds any model at all. */
  get hasModels(): boolean {
    return this.#catalogHasModels;
  }

  /** The model the form has chosen, written `<provider>/<model>`, or `''` while it has none. */
  get model(): string {
    return this.#model;
  }

  /**
   * Chooses the model. An effort the new model does not support is cleared, with a notice
   * (`effortNotice`); a model the catalog lacks is not judged, so the file's effort stays as written.
   */
  set model(next: string) {
    this.#model = next;
    this.#clearedEffort = null;
    const portable = this.chosenModel?.row?.effort.portable;
    if (this.effort !== '' && portable !== undefined && !portable.includes(this.effort)) {
      this.#clearedEffort = { effort: this.effort, model: next };
      this.effort = '';
    }
  }

  /**
   * The efforts the chosen model supports, from least to most, which the field offers. Empty for a
   * model with no effort control, and for one the catalog lacks, which cannot be judged.
   */
  get effortChoices(): readonly Effort[] {
    const portable = this.chosenModel?.row?.effort.portable;
    return portable === undefined ? [] : EFFORTS.filter((effort) => portable.includes(effort));
  }

  /**
   * Why the effort cannot be saved with the chosen model, in words, or `''`. Only the effort a file
   * already holds can be unsupported: a change of model clears it, and the field offers no other.
   */
  get effortError(): string {
    const effort = this.effort;
    const portable = this.chosenModel?.row?.effort.portable;
    if (effort === '' || portable === undefined || portable.includes(effort)) return '';
    return AGENT_EDITOR_COPY.effort.unsupported(EFFORT_LABELS[effort], this.model);
  }

  /** What a change of model did to the effort, in words, or `''` when it cleared none. */
  get effortNotice(): string {
    const cleared = this.#clearedEffort;
    if (cleared === null || this.effort !== '') return '';
    return AGENT_EDITOR_COPY.effort.cleared(EFFORT_LABELS[cleared.effort], cleared.model);
  }

  /** The model the field has chosen, or `undefined` while it has none. */
  get chosenModel(): ModelChoice | undefined {
    return choiceOf(this.modelGroups, this.model);
  }

  /** Why each limit field cannot be saved as typed, in words; a field with nothing wrong has no entry. */
  get limitErrors(): Readonly<Partial<Record<LimitField, string>>> {
    return limitErrorsOf(this);
  }

  /**
   * Whether the form holds what Try it needs: a model, and limits that parse. The identifier is not
   * needed, because nothing is saved.
   */
  get canTry(): boolean {
    return (
      this.hasModels &&
      this.model !== '' &&
      this.effortError === '' &&
      Object.keys(this.limitErrors).length === 0
    );
  }

  /** Whether the form holds what a save needs. A save also waits for any request in flight. */
  get canSave(): boolean {
    if (!this.hasModels || this.model === '') return false;
    if (this.effortError !== '' || Object.keys(this.limitErrors).length > 0) return false;
    return this.mode === 'edit' || (this.identifier !== '' && this.#identifierIsValid());
  }

  /** Whether the agent's tool is ticked. */
  hasTool(name: string): boolean {
    return this.tools.includes(name);
  }

  /** Ticks or clears one tool. */
  setTool(name: string, checked: boolean): void {
    this.tools = checked
      ? this.tools.includes(name)
        ? this.tools
        : [...this.tools, name]
      : this.tools.filter((tool) => tool !== name);
  }

  /**
   * The tools the agent has, in the catalog's order, which is the order a save writes them. A tool
   * the file lists and the catalog no longer offers is not here, because a save drops it.
   */
  get chosenTools(): AgentCatalog['tools'] {
    return this.toolChoices.filter((tool) => this.tools.includes(tool.name));
  }

  /** What the file says about when the tool asks first, or `undefined` when it says nothing. */
  approvalOf(name: string): ToolApproval | undefined {
    const written = this.#approvals;
    return written !== null && Object.hasOwn(written, name) ? written[name] : undefined;
  }

  /**
   * Sets when the tool asks first, on a new agent's form (row 41l). `fallback` is the level the
   * tool has when the file says nothing about it (`defaultAsks`), so choosing it writes nothing.
   */
  setApproval(name: string, approval: ToolApproval, fallback: ToolApproval): void {
    const kept = Object.entries(this.#approvals ?? {}).filter(([tool]) => tool !== name);
    if (approval !== fallback) kept.push([name, approval]);
    this.#approvals =
      kept.length === 0 && this.#approvals === null ? null : Object.fromEntries(kept);
  }

  /** Whether the tool asks first, runs, or is refused for this agent. */
  standingOf(tool: AgentCatalog['tools'][number]): ToolStanding {
    return standingOf(tool, this.approvalOf(tool.name));
  }

  /** The limits as the Bureau takes them: a field left empty is `null`, which removes the limit. */
  #limits(): Pick<AgentDefinitionInput, 'guardrails' | 'limits'> {
    return limitsOf(this, this.#warnAt, true, this.#keptGuardrails);
  }

  /** The tool approvals that still name a chosen tool: `undefined` when the file had none, `null` when none is left. */
  #approvalsFor(chosen: readonly string[]): AgentDefinitionInput['approvals'] {
    if (this.#approvals === null) return undefined;
    const kept = Object.entries(this.#approvals).filter(([tool]) => chosen.includes(tool));
    if (kept.length > 0) return Object.fromEntries(kept);
    // A new agent has no file to remove approvals from, so an empty set is left out.
    return this.mode === 'create' ? undefined : null;
  }

  /**
   * The definition to write: the form's fields and the carried skill descriptors and models. A copy
   * carries the original's `references`; an update leaves them out, which keeps the file's.
   */
  toDefinition(): AgentDefinitionInput {
    return {
      ...this.toTryDefinition(),
      ...(this.mode === 'create' && this.references.length > 0
        ? { references: this.references }
        : {}),
    };
  }

  /**
   * The default effort as the Bureau takes it: the one chosen; `null` for a file that had one and
   * now has none, which removes it; and nothing otherwise, which an update reads as keeping the
   * file's (there is none).
   */
  #effortInput(): Pick<AgentDefinitionInput, 'effort'> {
    if (this.effort !== '') return { effort: this.effort };
    return this.mode === 'edit' && this.#writtenEffort !== null ? { effort: null } : {};
  }

  /** The definition to try: the form's fields without `references`, which `bureau.agents.try` refuses. */
  toTryDefinition(): AgentDefinitionInput {
    const name = this.name.trim();
    const offered = this.toolChoices.map((tool) => tool.name);
    const chosen = offered.filter((tool) => this.tools.includes(tool));
    const approvals = this.#approvalsFor(chosen);
    return {
      ...(name === '' ? {} : { name }),
      description: this.description.trim() === '' ? null : this.description,
      model: this.model === this.#writtenModelOption ? this.#writtenModel : this.model,
      ...(this.models === null ? {} : { models: this.models }),
      ...this.#effortInput(),
      tools: chosen,
      card: this.card,
      ...(this.skills === null ? {} : { skills: this.skills }),
      ...(this.children === null ? {} : { children: this.children }),
      a2a: this.a2a,
      ...this.#carried,
      ...(approvals === undefined ? {} : { approvals }),
      ...this.#limits(),
      instructions: this.instructions,
    };
  }
}
