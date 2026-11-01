/**
 * The agent editor's form: what a person has typed, and what saving it would send.
 *
 * An agent is a Markdown file whose name is its identifier, so the form works from three facts the
 * Bureau holds. The catalog says which models and tools an agent may name. The loaded definition
 * says what the file holds now, `skillDescriptors` included, which the editor never edits and sends back
 * unchanged. The `hash` says which version of the file the form was filled from, and every write
 * names it, so a file that changed since is refused rather than overwritten.
 */
import { AGENT_EDITOR_COPY } from '../../app/copy.ts';
import {
  AGENT_IDENTIFIER_MAX_LENGTH,
  AGENT_IDENTIFIER_PATTERN,
  type AgentCatalog,
  type AgentDefinitionInput,
  type AgentDetail,
  type AgentSkill,
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
 * limit. `warnAt` is the file's own, which neither surface edits and a save sends back.
 */
export function limitsOf(
  fields: LimitFields,
  warnAt: readonly number[] | undefined,
): Pick<AgentDefinitionInput, 'guardrails' | 'stepLimit' | 'costBudget' | 'toolBudget'> {
  const guardrails = parseGuardrails(fields.guardrails);
  const perRun = parseLimit(fields.spendPerRun, false, LIMIT_BOUNDS.spendUsd) ?? null;
  const perChat = parseLimit(fields.spendPerChat, false, LIMIT_BOUNDS.spendUsd) ?? null;
  const calls = parseLimit(fields.toolCalls, true, LIMIT_BOUNDS.toolCalls) ?? null;
  const seconds = parseLimit(fields.toolSeconds, false, LIMIT_BOUNDS.toolSeconds) ?? null;
  return {
    guardrails: guardrails.length === 0 ? null : guardrails,
    stepLimit: parseLimit(fields.stepLimit, true, LIMIT_BOUNDS.stepLimit) ?? null,
    costBudget:
      perRun === null
        ? null
        : {
            perRunUsd: perRun,
            ...(perChat === null ? {} : { perChatUsd: perChat }),
            ...(warnAt === undefined ? {} : { warnAt }),
          },
    toolBudget:
      calls === null && seconds === null
        ? null
        : {
            ...(calls === null ? {} : { maxCalls: calls }),
            ...(seconds === null ? {} : { maxDurationSeconds: seconds }),
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

export class AgentEditorState {
  readonly mode: 'create' | 'edit';
  /** The identifier of the agent being edited. A new agent has none until it is named. */
  readonly #editedId: string | undefined;
  /** The models grouped by provider, as the field lists them; fixed when the form is built. */
  readonly modelGroups: readonly ModelGroup[];
  /** Whether the catalog holds any model row at all, offered or not. */
  readonly #catalogHasModels: boolean;
  readonly toolChoices: AgentCatalog['tools'];
  /** `skillDescriptors` is carried through a save untouched. */
  readonly skillDescriptors: readonly AgentSkill[];
  /**
   * The models a session may be switched to (COR-1559), as the file lists them, or `null` when it
   * lists none. Carried through a save untouched, like `skillDescriptors`: the editor shows no control for
   * it, and an update that left it out would remove the list.
   */
  readonly models: readonly string[] | null;
  /** The model the file wrote, and the option it names, so an unchanged model is written back as it was. */
  readonly #writtenModel: string;
  readonly #writtenModelOption: string;

  name = $state('');
  description = $state('');
  model = $state('');
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
   * When each tool asks first, as the file wrote it (the Access tab edits it): carried through a
   * save, pruned to the tools still chosen, because the Bureau refuses a file whose `toolApproval`
   * names a tool that `tools` does not.
   */
  readonly #toolApproval: Readonly<Record<string, ToolApproval>> | null;

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
  ) {
    this.mode = mode;
    this.toolChoices = catalog.tools;
    const definition = detail?.definition ?? null;
    this.#editedId = detail?.id;
    this.skillDescriptors = definition?.skillDescriptors ?? [];
    this.models = definition?.models ?? null;
    this.#warnAt = definition?.costBudget?.warnAt;
    this.#toolApproval = definition?.toolApproval ?? null;
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
      this.model = firstAvailableModel(this.modelGroups);
      return;
    }
    this.name = definition.name;
    this.description = definition.description ?? '';
    this.model = this.#writtenModelOption;
    this.tools = [...definition.tools];
    this.instructions = definition.instructions;
    this.hash = detail?.hash ?? null;
    this.a2a = definition.a2a;
    this.guardrails = (definition.guardrails ?? []).join('\n');
    this.stepLimit = definition.stepLimit === null ? '' : String(definition.stepLimit);
    this.spendPerRun =
      definition.costBudget === null ? '' : String(definition.costBudget.perRunUsd);
    this.spendPerChat =
      definition.costBudget?.perChatUsd === undefined
        ? ''
        : String(definition.costBudget.perChatUsd);
    this.toolCalls =
      definition.toolBudget?.maxCalls === undefined ? '' : String(definition.toolBudget.maxCalls);
    this.toolSeconds =
      definition.toolBudget?.maxDurationSeconds === undefined
        ? ''
        : String(definition.toolBudget.maxDurationSeconds);
  }

  /** A form for a new agent, with the first model that can be chosen. */
  static create(catalog: AgentCatalog, context: ModelContext = {}): AgentEditorState {
    return new AgentEditorState('create', catalog, undefined, context);
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
    return new AgentEditorState('edit', catalog, detail, context);
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
    const taken = this.#taken;
    if (taken !== null && taken.identifier === this.identifier) {
      return AGENT_EDITOR_COPY.identifierTaken[taken.reason];
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

  #identifierIsValid(): boolean {
    return (
      this.identifier !== RESERVED_IDENTIFIER &&
      this.identifier.length <= AGENT_IDENTIFIER_MAX_LENGTH &&
      AGENT_IDENTIFIER_PATTERN.test(this.identifier)
    );
  }

  /** Whether the catalog holds any model at all. */
  get hasModels(): boolean {
    return this.#catalogHasModels;
  }

  /** The model the field has chosen, or `undefined` while it has none. */
  get chosenModel(): ModelChoice | undefined {
    return choiceOf(this.modelGroups, this.model);
  }

  /** Why each limit field cannot be saved as typed, in words; a field with nothing wrong has no entry. */
  get limitErrors(): Readonly<Partial<Record<LimitField, string>>> {
    return limitErrorsOf(this);
  }

  /** Whether the form holds what a save needs. A save also waits for any request in flight. */
  get canSave(): boolean {
    if (!this.hasModels || this.model === '') return false;
    if (Object.keys(this.limitErrors).length > 0) return false;
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
    const written = this.#toolApproval;
    return written !== null && Object.hasOwn(written, name) ? written[name] : undefined;
  }

  /** Whether the tool asks first, runs, or is refused for this agent. */
  standingOf(tool: AgentCatalog['tools'][number]): ToolStanding {
    return standingOf(tool, this.approvalOf(tool.name));
  }

  /** The limits as the Bureau takes them: a field left empty is `null`, which removes the limit. */
  #limits(): Pick<AgentDefinitionInput, 'guardrails' | 'stepLimit' | 'costBudget' | 'toolBudget'> {
    return limitsOf(this, this.#warnAt);
  }

  /** The tool approvals that still name a chosen tool: `undefined` when the file had none, `null` when none is left. */
  #approvalsFor(chosen: readonly string[]): AgentDefinitionInput['toolApproval'] {
    if (this.#toolApproval === null) return undefined;
    const kept = Object.entries(this.#toolApproval).filter(([tool]) => chosen.includes(tool));
    return kept.length === 0 ? null : Object.fromEntries(kept);
  }

  /** The definition to write: the form's fields and the carried skill descriptors and models. */
  toDefinition(): AgentDefinitionInput {
    const name = this.name.trim();
    const offered = this.toolChoices.map((tool) => tool.name);
    const chosen = offered.filter((tool) => this.tools.includes(tool));
    const toolApproval = this.#approvalsFor(chosen);
    return {
      ...(name === '' ? {} : { name }),
      description: this.description.trim() === '' ? null : this.description,
      model: this.model === this.#writtenModelOption ? this.#writtenModel : this.model,
      ...(this.models === null ? {} : { models: this.models }),
      tools: chosen,
      skillDescriptors: this.skillDescriptors,
      a2a: this.a2a,
      ...(toolApproval === undefined ? {} : { toolApproval }),
      ...this.#limits(),
      instructions: this.instructions,
    };
  }
}
