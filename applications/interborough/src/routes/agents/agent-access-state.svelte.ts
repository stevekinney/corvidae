/**
 * The Access tab's form: which tools an agent may call, when each asks first, the plugin
 * guardrails it runs, and its spend and tool budgets. It is filled from the agent's file and sends
 * a whole definition back, because `bureau.agents.definitions.update` removes `tools` and `models`
 * when they are left out. The keys the tab does not edit (`stepLimit`, `references`, `retry`,
 * `compaction`, `hooks`) are left out of the write, which keeps the file's value.
 *
 * `toolApproval` may only name a tool the file lists, or the Bureau refuses the write, so clearing
 * a tool's Allow drops its approval in the same write.
 */
import { SvelteMap } from 'svelte/reactivity';

import {
  type AgentCatalog,
  type AgentDefinitionInput,
  type AgentDetail,
  type ToolApproval,
} from '../../lib/agent-definitions.ts';
import {
  limitErrorsOf,
  limitsOf,
  type LimitField,
} from '../agent-editor/agent-editor-state.svelte.ts';

/** One row of the tools list: a tool the host offers, or one the file lists that the host no longer does. */
export type AccessTool = {
  readonly name: string;
  /** The catalog's entry, or `undefined` for a tool the file lists and the host no longer offers. */
  readonly catalog: AgentCatalog['tools'][number] | undefined;
};

/** What a tool does when its file states nothing. */
export const DEFAULT_APPROVAL: ToolApproval = 'on-changes';

type Definition = NonNullable<AgentDetail['definition']>;

export class AgentAccessState {
  /** The hash of the file this form was filled from; the write names it. */
  readonly hash: string;
  readonly rows: readonly AccessTool[];
  readonly #definition: Definition;
  readonly #baseline: string;

  /** The tools the agent may call, in the order the file lists them and then the order they were allowed. */
  tools = $state<string[]>([]);
  /** The approvals the file states. A tool absent here asks `on-changes`. */
  readonly approvals = new SvelteMap<string, ToolApproval>();
  /** The plugin guardrails as typed, one per line. */
  guardrails = $state('');
  spendPerRun = $state('');
  spendPerChat = $state('');
  toolCalls = $state('');
  toolSeconds = $state('');

  private constructor(detail: AgentDetail, definition: Definition, catalog: AgentCatalog) {
    this.hash = detail.hash ?? '';
    this.#definition = definition;
    const offered = new Set(catalog.tools.map((tool) => tool.name));
    this.rows = [
      ...catalog.tools.map((tool) => ({ name: tool.name, catalog: tool })),
      ...definition.tools
        .filter((tool) => !offered.has(tool))
        .map((tool) => ({ name: tool, catalog: undefined })),
    ];
    this.tools = [...definition.tools];
    for (const [tool, approval] of Object.entries(definition.toolApproval ?? {})) {
      this.approvals.set(tool, approval);
    }
    this.guardrails = (definition.guardrails ?? []).join('\n');
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
    this.#baseline = JSON.stringify(this.toDefinition());
  }

  /** A form for an agent file that loaded, or `undefined` for an agent that has no file to change. */
  static from(detail: AgentDetail, catalog: AgentCatalog): AgentAccessState | undefined {
    if (detail.source !== 'file' || detail.definition === null || detail.hash === null) {
      return undefined;
    }
    return new AgentAccessState(detail, detail.definition, catalog);
  }

  /** Whether the agent may call the tool. */
  isAllowed(name: string): boolean {
    return this.tools.includes(name);
  }

  /** Allows or withdraws one tool. Withdrawing it drops its approval, which the Bureau would refuse to keep. */
  setAllowed(name: string, allowed: boolean): void {
    if (allowed) {
      if (!this.tools.includes(name)) this.tools = [...this.tools, name];
      return;
    }
    this.tools = this.tools.filter((tool) => tool !== name);
    this.approvals.delete(name);
  }

  /** When the tool asks first: the file's statement, or `on-changes`. */
  approvalOf(name: string): ToolApproval {
    return this.approvals.get(name) ?? DEFAULT_APPROVAL;
  }

  /** Sets when the tool asks first. `on-changes` is what a file says by saying nothing, so it is not written. */
  setApproval(name: string, approval: ToolApproval): void {
    if (approval === DEFAULT_APPROVAL) this.approvals.delete(name);
    else this.approvals.set(name, approval);
  }

  /** How many tools the host offers. */
  get offeredCount(): number {
    return this.rows.filter((row) => row.catalog !== undefined).length;
  }

  /** How many tools are allowed. */
  get allowedCount(): number {
    return this.tools.length;
  }

  /** Why each limit field cannot be saved as typed; a field with nothing wrong has no entry. */
  get limitErrors(): Readonly<Partial<Record<LimitField, string>>> {
    return limitErrorsOf(this.#fields());
  }

  /** Whether anything differs from the file the form was filled from. */
  get dirty(): boolean {
    return JSON.stringify(this.toDefinition()) !== this.#baseline;
  }

  /** Whether the form holds what a save needs. */
  get canSave(): boolean {
    return this.dirty && Object.keys(this.limitErrors).length === 0;
  }

  #fields(): Readonly<Record<LimitField, string>> {
    return {
      guardrails: this.guardrails,
      // The step limit is on the Settings tab and is not edited here.
      stepLimit: '',
      spendPerRun: this.spendPerRun,
      spendPerChat: this.spendPerChat,
      toolCalls: this.toolCalls,
      toolSeconds: this.toolSeconds,
    };
  }

  /** The approvals of the tools still allowed, or `null` when none is left to state. */
  #approvalsToWrite(): Record<string, ToolApproval> | null {
    const kept = [...this.approvals].filter(([tool]) => this.tools.includes(tool));
    return kept.length === 0 ? null : Object.fromEntries(kept);
  }

  /** The definition to write: the file's own, with the access this form edits. */
  toDefinition(): AgentDefinitionInput {
    const file = this.#definition;
    const limits = limitsOf(this.#fields(), file.costBudget?.warnAt);
    return {
      name: file.name,
      description: file.description,
      model: file.model,
      ...(file.models === null ? {} : { models: file.models }),
      tools: this.tools,
      skillDescriptors: file.skillDescriptors,
      a2a: file.a2a,
      guardrails: limits.guardrails ?? null,
      costBudget: limits.costBudget ?? null,
      toolBudget: limits.toolBudget ?? null,
      toolApproval: this.#approvalsToWrite(),
      instructions: file.instructions,
    };
  }
}
