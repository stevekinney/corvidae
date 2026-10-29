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
} from '../../lib/agent-definitions.ts';

/**
 * An identifier the Bureau accepts and the editor refuses: `/agents/new` creates an agent, so an
 * agent whose identifier is `new` could be saved and then never opened.
 */
export const RESERVED_IDENTIFIER = 'new';

/** One model an agent may name, written `<provider>/<model>`. */
export type ModelOption = { readonly value: string; readonly label: string };

/** The models the catalog offers, one option each, in the catalog's order. */
export function modelOptions(catalog: AgentCatalog): readonly ModelOption[] {
  const seen = new Set<string>();
  const options: ModelOption[] = [];
  for (const row of catalog.models) {
    const value = `${row.provider}/${row.model}`;
    if (seen.has(value)) continue;
    seen.add(value);
    options.push({ value, label: value });
  }
  return options;
}

/**
 * The option a written model names, or `''` when the catalog offers no such model. A file may
 * write an alias (`anthropic/sonnet`), and the option is the model it resolves to.
 */
export function canonicalModel(written: string, catalog: AgentCatalog): string {
  const separator = written.indexOf('/');
  if (separator === -1) return '';
  const provider = written.slice(0, separator);
  const name = written.slice(separator + 1);
  const row = catalog.models.find(
    (candidate) =>
      candidate.provider === provider &&
      (candidate.model === name || candidate.aliases.some((entry) => entry.alias === name)),
  );
  return row === undefined ? '' : `${row.provider}/${row.model}`;
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

export class AgentEditorState {
  readonly mode: 'create' | 'edit';
  /** The identifier of the agent being edited. A new agent has none until it is named. */
  readonly #editedId: string | undefined;
  readonly modelChoices: readonly ModelOption[];
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
  ) {
    this.mode = mode;
    this.modelChoices = modelOptions(catalog);
    this.toolChoices = catalog.tools;
    const definition = detail?.definition ?? null;
    this.#editedId = detail?.id;
    this.skillDescriptors = definition?.skillDescriptors ?? [];
    this.models = definition?.models ?? null;
    this.#writtenModel = definition?.model ?? '';
    this.#writtenModelOption = canonicalModel(this.#writtenModel, catalog);
    if (definition === null) {
      this.model = this.modelChoices[0]?.value ?? '';
      return;
    }
    this.name = definition.name;
    this.description = definition.description ?? '';
    this.model = this.#writtenModelOption;
    this.tools = [...definition.tools];
    this.instructions = definition.instructions;
    this.hash = detail?.hash ?? null;
    this.a2a = definition.a2a;
  }

  /** A form for a new agent, with the catalog's first model chosen. */
  static create(catalog: AgentCatalog): AgentEditorState {
    return new AgentEditorState('create', catalog, undefined);
  }

  /** A form filled from an agent file that loaded. */
  static edit(detail: AgentDetail, catalog: AgentCatalog): AgentEditorState {
    if (detail.definition === null || detail.hash === null) {
      throw new TypeError(`The agent "${detail.id}" has no definition to edit.`);
    }
    return new AgentEditorState('edit', catalog, detail);
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

  /** Whether the catalog offers any model at all. */
  get hasModels(): boolean {
    return this.modelChoices.length > 0;
  }

  /** Whether the form holds what a save needs. A save also waits for any request in flight. */
  get canSave(): boolean {
    if (!this.hasModels || this.model === '') return false;
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

  /** The definition to write: the form's fields and the carried skill descriptors and models. */
  toDefinition(): AgentDefinitionInput {
    const name = this.name.trim();
    const offered = this.toolChoices.map((tool) => tool.name);
    return {
      ...(name === '' ? {} : { name }),
      description: this.description.trim() === '' ? null : this.description,
      model: this.model === this.#writtenModelOption ? this.#writtenModel : this.model,
      ...(this.models === null ? {} : { models: this.models }),
      tools: offered.filter((tool) => this.tools.includes(tool)),
      skillDescriptors: this.skillDescriptors,
      a2a: this.a2a,
      instructions: this.instructions,
    };
  }
}
