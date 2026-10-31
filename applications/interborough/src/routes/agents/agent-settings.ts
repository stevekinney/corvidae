/**
 * What the Settings tab shows of an agent, put as words: the model and the models a chat may be
 * switched to, and, for an agent with a file, its guardrail preset and its limits. A limit the file
 * does not set is `null`, which the tab says as "No limit".
 */
import { AGENT_PAGE_COPY } from '../../app/copy.ts';
import type { AgentDetail } from '../../lib/agent-definitions.ts';

/** The settings of one agent, each already worded or `null` when the file sets none. */
export interface AgentSettingsView {
  readonly model: string | null;
  readonly models: readonly string[];
  readonly guardrails: string | null;
  readonly stepLimit: string | null;
  readonly spendPerRun: string | null;
  readonly spendPerChat: string | null;
  readonly toolCalls: string | null;
  readonly toolTime: string | null;
}

/** The settings of `detail`: the file's for an agent with one, the agent's own statement for one in code. */
export function settingsOf(detail: AgentDetail): AgentSettingsView {
  const copy = AGENT_PAGE_COPY.settings;
  const definition = detail.definition;
  if (detail.source !== 'file' || definition === null) {
    return {
      model: detail.codeDefinition?.model ?? null,
      models: detail.codeDefinition?.models ?? [],
      guardrails: null,
      stepLimit: null,
      spendPerRun: null,
      spendPerChat: null,
      toolCalls: null,
      toolTime: null,
    };
  }
  return {
    model: definition.model,
    models: definition.models ?? [],
    guardrails: definition.guardrails,
    stepLimit: definition.stepLimit === null ? null : String(definition.stepLimit),
    spendPerRun: definition.costBudget === null ? null : copy.usd(definition.costBudget.perRunUsd),
    spendPerChat:
      definition.costBudget?.perChatUsd === undefined
        ? null
        : copy.usd(definition.costBudget.perChatUsd),
    toolCalls:
      definition.toolBudget?.maxCalls === undefined ? null : String(definition.toolBudget.maxCalls),
    toolTime:
      definition.toolBudget?.maxDurationSeconds === undefined
        ? null
        : copy.seconds(definition.toolBudget.maxDurationSeconds),
  };
}
