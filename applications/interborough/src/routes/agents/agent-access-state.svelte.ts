/**
 * The Access tab's state (board PageAgent, rows 38l to 39k): which tools an agent may call and when
 * each asks first, the skills it may activate, the plugin guardrails it runs, and its spend limit
 * per chat, filled from the agent's file.
 *
 * Each change saves at once (rows 39h to 39k). A row applies its change to the state, which marks
 * that row `saving`, and the write goes into a queue, so writes go one at a time and each names the
 * hash the one before it returned. A write that fails undoes its own row's change and marks the row
 * `failed`, with a retry that applies the change again; no version is saved. A queued change that a
 * write before it already carried is not written again.
 *
 * Every write sends a whole definition, because `bureau.agents.definitions.update` removes `tools`
 * and `models` when they are left out. The keys the tab does not edit (`limits.steps`,
 * `limits.tools`, `references`, `retry`, `compaction`, `hooks`) are left out of the write, which
 * keeps the file's value.
 *
 * `approvals` may only name a tool the file lists, or the Bureau refuses the write, so a tool that
 * is not allowed has its approval left out of the write. The approval itself is kept in the state,
 * so allowing the tool again restores what was chosen instead of loosening it. A tool the file says
 * nothing about shows its own default (`defaultAsks`); a level picked for it is written, except
 * `on-changes` on a tool whose default that is, which is what the file saying nothing runs.
 *
 * `skills` is written whole, so a skill the file names that the host no longer offers stays until
 * someone withdraws it. A file with no list keeps none until a skill is granted.
 *
 * An agent the page cannot write (one defined in code, or a plugin's) gets a state too, with no
 * writer, so the tab shows the same table read-only.
 */
import { SvelteMap } from 'svelte/reactivity';

import {
  guardrailEntriesFor,
  guardrailEntryId,
  type AgentCatalog,
  type AgentDefinitionInput,
  type AgentDetail,
  type AgentLimitsInput,
  type ToolApproval,
} from '../../lib/agent-definitions.ts';
import type { Skill } from '../../lib/bureau-skills.ts';
import { LIMIT_BOUNDS, parseLimit } from '../agent-editor/agent-editor-state.svelte.ts';
import {
  defaultAsks,
  matchesFilter,
  matchesToolFilter,
  toolGroup,
  toolHeading,
} from '../capabilities/capability-presentation.ts';

/** One row of the tools table: a tool the host offers, or one the file lists that the host no longer does. */
export type AccessTool = {
  readonly name: string;
  /** The catalog's entry, or `undefined` for a tool the file lists and the host no longer offers. */
  readonly catalog: AgentCatalog['tools'][number] | undefined;
  /** The Asks level the tool has when the file says nothing about it. */
  readonly fallback: ToolApproval;
};

/** What a tool the host no longer offers asks when the file says nothing: the Bureau's own default. */
export const DEFAULT_APPROVAL: ToolApproval = 'on-changes';

/** The key of the group of tools the file lists that the host no longer offers. */
export const RETIRED_GROUP = 'retired';

/** The key of the group of tools Bureau adds, which the table shows first. */
const BUILT_IN_GROUP = 'bureau:';

/** One collapsible group of the tools table: the rows of one source (row 38m). */
export interface AccessGroup {
  /** The source's key, which its segment reports too. */
  readonly key: string;
  /** The source as its rows say it ("Built in", "Github"), or `undefined` for the retired group. */
  readonly label: string | undefined;
  readonly rows: readonly AccessTool[];
}

/**
 * The rows put into their groups: Built in first, the other sources by name, and the tools the host
 * no longer offers last, each group's rows in the order the catalog gave them.
 */
export function groupAccessRows(rows: readonly AccessTool[]): AccessGroup[] {
  const groups = new Map<string, { label: string | undefined; rows: AccessTool[] }>();
  for (const row of rows) {
    const { key, label } =
      row.catalog === undefined ? { key: RETIRED_GROUP, label: undefined } : toolGroup(row.catalog);
    const group = groups.get(key) ?? { label, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .sort(([leftKey, left], [rightKey, right]) => {
      if (leftKey === rightKey) return 0;
      if (leftKey === BUILT_IN_GROUP || rightKey === RETIRED_GROUP) return -1;
      if (rightKey === BUILT_IN_GROUP || leftKey === RETIRED_GROUP) return 1;
      return (left.label ?? '').localeCompare(right.label ?? '');
    })
    .map(([key, group]) => ({ key, label: group.label, rows: group.rows }));
}

/** Whether a row matches what was typed in the toolbar's search: by its name for a person or its identifier. */
export function matchesAccessRow(row: AccessTool, typed: string): boolean {
  return row.catalog === undefined
    ? matchesFilter(row.name, typed)
    : matchesToolFilter(row.catalog, typed);
}

/** The name a row shows: the tool's name for a person, or its identifier when the host no longer offers it. */
export function accessRowHeading(row: AccessTool): string {
  return row.catalog === undefined ? row.name : toolHeading(row.catalog);
}

/**
 * Whether a skill's box cannot be changed. A skill an agent cannot activate (an untrusted source,
 * say) cannot be granted, but one the file already names can be withdrawn. A name with an available
 * record is that record's row: its shadowed twin is only a report.
 */
export function skillGrantLocked(
  skill: Skill,
  skills: readonly Skill[],
  granted: boolean,
): boolean {
  if (skill.available) return false;
  return !granted || skills.some((other) => other.name === skill.name && other.available);
}

/** What one row shows of its own save (rows 39j, 39k). */
export type RowSave =
  | { readonly kind: 'saving' }
  | {
      readonly kind: 'failed';
      /** What the failure line calls the row's subject: "Issue refund", "the spend limit". */
      readonly subject: string;
      /** The words of the value the row went back to: "Always", "not allowed". */
      readonly restored: string;
      /** The fault the write failed with. */
      readonly error: unknown;
      /** Applies the change again and saves it. */
      readonly retry: () => void;
    };

/** What one change's write came to. */
export type SaveOutcome =
  | { readonly kind: 'saved'; readonly hash: string }
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'failed'; readonly error: unknown };

/** Sends one write: the definition, over the hash of the file as last read or written. */
export type AccessWriter = (
  expectedHash: string,
  definition: AgentDefinitionInput,
) => Promise<{ readonly hash: string }>;

/** One change a row makes: which row it is, what to call it if it fails, and how to apply and undo it. */
export interface AccessChange {
  /** The row's key: `tool:<name>`, `skill:<name>`, `guardrail:<id>` or `spend`. */
  readonly key: string;
  readonly subject: string;
  /** The words of the value the row had before the change, which a failure puts back. */
  readonly restored: string;
  readonly apply: () => void;
  readonly undo: () => void;
}

type Definition = NonNullable<AgentDetail['definition']>;

export class AgentAccessState {
  /** The hash of the file as last read or written; the next write names it. */
  hash = $state('');
  readonly rows: readonly AccessTool[];
  /** Whether a change here is saved; `false` for an agent the page cannot write. */
  readonly editable: boolean;
  /** The skills the file defines itself, which the tab lists as granted (sweep S65). */
  readonly ownSkills: readonly {
    readonly id: string;
    readonly name: string;
    readonly description: string;
  }[];
  readonly #definition: Definition | null;
  readonly #writer: AccessWriter | undefined;
  readonly #fallbacks: ReadonlyMap<string, ToolApproval>;
  /** The definition last on disk, as text, so a change a write already carried is not written again. */
  #committed = '';
  /** The hashes this state's own writes returned, so a refetch that reads one is not a change. */
  readonly #written = new Set<string>();
  /** The writes in flight or waiting, which run one at a time. */
  #queue: Promise<unknown> = Promise.resolve();
  /** How many changes of each row wait on their write. */
  readonly #waiting = new Map<string, number>();
  #pending = $state(0);

  /** The tools the agent may call, in the order the file lists them and then the order they were allowed. */
  tools = $state<string[]>([]);
  /** The approvals the file states. A tool absent here asks at its own default. */
  readonly approvals = new SvelteMap<string, ToolApproval>();
  /** The skills the agent may activate, in the order the file lists them and then the order they were granted. */
  skills = $state<string[]>([]);
  /** The plugin guardrails the agent runs, by id, in the order the file lists them and then the order they were turned on. */
  guardrails = $state<string[]>([]);
  /** The spend limit per chat as typed, in US dollars; empty for none. */
  spendPerChat = $state('');
  /** The spend limit as last applied, which a failed save of a typed one goes back to. */
  spendApplied = $state('');
  /** Each row's own save, by the row's key; a row with no entry is at rest. */
  readonly saves = new SvelteMap<string, RowSave>();

  private constructor(
    detail: AgentDetail,
    definition: Definition | null,
    catalog: AgentCatalog,
    writer: AccessWriter | undefined,
  ) {
    this.hash = detail.hash ?? '';
    this.#definition = definition;
    this.#writer = writer;
    this.editable = writer !== undefined && definition !== null && detail.hash !== null;
    const listed = definition?.tools ?? detail.codeDefinition?.tools ?? [];
    const offered = new Set(catalog.tools.map((tool) => tool.name));
    this.rows = [
      ...catalog.tools.map((tool) => ({
        name: tool.name,
        catalog: tool,
        fallback: defaultAsks(tool),
      })),
      ...listed
        .filter((tool) => !offered.has(tool))
        .map((tool) => ({ name: tool, catalog: undefined, fallback: DEFAULT_APPROVAL })),
    ];
    this.#fallbacks = new Map(this.rows.map((row) => [row.name, row.fallback]));
    this.ownSkills = (definition?.card ?? detail.codeDefinition?.card ?? []).map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
    }));
    this.tools = [...listed];
    for (const [tool, approval] of Object.entries(definition?.approvals ?? {})) {
      this.approvals.set(tool, approval);
    }
    this.skills = [...(definition?.skills ?? detail.codeDefinition?.skills ?? [])];
    this.guardrails = (definition?.guardrails ?? []).map(guardrailEntryId);
    const chat = definition?.limits.cost?.chat;
    this.spendPerChat = chat === undefined ? '' : String(chat);
    this.spendApplied = this.spendPerChat;
    if (detail.hash !== null) this.#written.add(detail.hash);
    if (definition !== null) this.#committed = JSON.stringify(this.toDefinition());
  }

  /**
   * The state for an agent as the Bureau shows it, or `undefined` for an agent file that does not
   * load. With a `writer` and a file to write, each change saves; without one the state is
   * read-only.
   */
  static from(
    detail: AgentDetail,
    catalog: AgentCatalog,
    writer?: AccessWriter,
  ): AgentAccessState | undefined {
    if (detail.source === 'file') {
      if (detail.definition === null) return undefined;
      return new AgentAccessState(
        detail,
        detail.definition,
        catalog,
        detail.hash === null ? undefined : writer,
      );
    }
    // An agent in code states its own tools; one a disabled plugin ships states none the page can
    // read (row 39n), so its table shows every tool off.
    return new AgentAccessState(detail, null, catalog, undefined);
  }

  /** Whether the agent may call the tool. */
  isAllowed(name: string): boolean {
    return this.tools.includes(name);
  }

  /** Allows or withdraws one tool. A withdrawn tool's approval stays in the state and is left out of the write. */
  setAllowed(name: string, allowed: boolean): void {
    if (allowed) {
      if (!this.tools.includes(name)) this.tools = [...this.tools, name];
      return;
    }
    this.tools = this.tools.filter((tool) => tool !== name);
  }

  /** Whether the agent may activate the skill. */
  isGranted(name: string): boolean {
    return this.skills.includes(name);
  }

  /** Grants or withdraws one skill. */
  setGranted(name: string, granted: boolean): void {
    if (granted) {
      if (!this.skills.includes(name)) this.skills = [...this.skills, name];
      return;
    }
    this.skills = this.skills.filter((skill) => skill !== name);
  }

  /** Whether the agent runs the plugin guardrail. */
  hasGuardrail(id: string): boolean {
    return this.guardrails.includes(id);
  }

  /** Turns one plugin guardrail on or off. */
  setGuardrail(id: string, on: boolean): void {
    if (on) {
      if (!this.guardrails.includes(id)) this.guardrails = [...this.guardrails, id];
      return;
    }
    this.guardrails = this.guardrails.filter((entry) => entry !== id);
  }

  /** The Asks level a tool has when the file says nothing about it. */
  fallbackOf(name: string): ToolApproval {
    return this.#fallbacks.get(name) ?? DEFAULT_APPROVAL;
  }

  /** When the tool asks first: the file's statement, or the tool's own default. */
  approvalOf(name: string): ToolApproval {
    return this.approvals.get(name) ?? this.fallbackOf(name);
  }

  /**
   * Sets when the tool asks first. A file that says nothing runs the tool `on-changes`, so only
   * that level, on a tool whose default it is, is left out of the write. Every other level is
   * written, the tool's shown default included: a dangerous tool shown at Always asks on every
   * call either way, but only a written `always` is never skipped by a chat's Allow all or by a
   * tool allowed for the rest of a chat.
   */
  setApproval(name: string, approval: ToolApproval): void {
    if (approval === DEFAULT_APPROVAL && this.fallbackOf(name) === DEFAULT_APPROVAL) {
      this.approvals.delete(name);
    } else {
      this.approvals.set(name, approval);
    }
  }

  /** How many rows the tools table has: the one total the toolbar's count is out of (row 38l). */
  get totalCount(): number {
    return this.rows.length;
  }

  /** How many tools are allowed. */
  get allowedCount(): number {
    return this.tools.length;
  }

  /** How many of `rows` are allowed: a group header's count. */
  allowedAmong(rows: readonly AccessTool[]): number {
    return rows.filter((row) => this.tools.includes(row.name)).length;
  }

  /** The spend limit as typed: no limit (`null`), an amount, or `undefined` when it is not one the Bureau takes. */
  get spendLimit(): number | null | undefined {
    return parseLimit(this.spendPerChat, false, LIMIT_BOUNDS.spendUsd);
  }

  /** Whether a write is in flight or waiting. */
  get busy(): boolean {
    return this.#pending > 0;
  }

  /**
   * Whether `hash` is the one this state was filled from or one its own writes returned, so a
   * refetch that answers with it, even one older than the last write, is not a change on disk.
   */
  wrote(hash: string): boolean {
    return this.#written.has(hash);
  }

  /**
   * Applies one change and saves it at once, after any write already waiting. The row reads
   * `saving` until its write answers, and `failed`, with its change undone, when it fails. The
   * promise never rejects: it resolves with what the write came to.
   */
  change(change: AccessChange): Promise<SaveOutcome> {
    change.apply();
    if (!this.editable) return Promise.resolve({ kind: 'unchanged' });
    this.saves.set(change.key, { kind: 'saving' });
    this.#waiting.set(change.key, (this.#waiting.get(change.key) ?? 0) + 1);
    this.#pending += 1;
    const run = this.#queue.then(() => this.#save(change));
    this.#queue = run;
    return run;
  }

  async #save(change: AccessChange): Promise<SaveOutcome> {
    try {
      const writer = this.#writer;
      const definition = this.toDefinition();
      const text = JSON.stringify(definition);
      if (writer === undefined || text === this.#committed) {
        this.#settle(change.key);
        return { kind: 'unchanged' };
      }
      try {
        const result = await writer(this.hash, definition);
        this.hash = result.hash;
        this.#written.add(result.hash);
        this.#committed = text;
        this.#settle(change.key);
        return { kind: 'saved', hash: result.hash };
      } catch (error) {
        change.undo();
        this.#settle(change.key);
        this.saves.set(change.key, {
          kind: 'failed',
          subject: change.subject,
          restored: change.restored,
          error,
          retry: () => void this.change(change),
        });
        return { kind: 'failed', error };
      }
    } finally {
      this.#pending -= 1;
    }
  }

  /** One of a row's waiting changes has its answer: the row is at rest once none waits. */
  #settle(key: string): void {
    const left = (this.#waiting.get(key) ?? 1) - 1;
    if (left > 0) {
      this.#waiting.set(key, left);
      return;
    }
    this.#waiting.delete(key);
    this.saves.delete(key);
  }

  /** The approvals of the tools still allowed, or `null` when none is left to state. */
  #approvalsToWrite(): Record<string, ToolApproval> | null {
    const kept = [...this.approvals].filter(([tool]) => this.tools.includes(tool));
    return kept.length === 0 ? null : Object.fromEntries(kept);
  }

  /**
   * The spend limits to write. A chat limit sits on a run limit in the file, so one set where the
   * file has no run limit writes the run limit at the same amount, which a run inside that chat can
   * never pass anyway. Clearing the chat limit keeps the file's run limit.
   */
  #costToWrite(file: Definition): AgentLimitsInput['cost'] {
    const kept = file.limits.cost;
    const warn = kept?.warn === undefined ? {} : { warn: kept.warn };
    const chat = this.spendLimit ?? null;
    if (chat === null) return kept === null ? null : { run: kept.run, ...warn };
    return { run: kept?.run ?? chat, chat, ...warn };
  }

  /** The definition to write: the file's own, with the access this tab edits. */
  toDefinition(): AgentDefinitionInput {
    const file = this.#definition;
    if (file === null) throw new TypeError('An agent with no file has no definition to write.');
    return {
      name: file.name,
      description: file.description,
      model: file.model,
      ...(file.models === null ? {} : { models: file.models }),
      tools: this.tools,
      card: file.card,
      skills: file.skills === null && this.skills.length === 0 ? null : this.skills,
      a2a: file.a2a,
      guardrails:
        this.guardrails.length === 0 ? null : guardrailEntriesFor(this.guardrails, file.guardrails),
      limits: { cost: this.#costToWrite(file) },
      approvals: this.#approvalsToWrite(),
      instructions: file.instructions,
    };
  }
}
