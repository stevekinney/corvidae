/**
 * What the Settings tab shows of an agent, put as words: the model and the models a chat may be
 * switched to, and, for an agent with a file, its step limit. A limit the file does not set is
 * `null`, which the tab says as "No limit".
 */
import type { AgentDetail } from '../../lib/agent-definitions.ts';

/** The settings of one agent, each already worded or `null` when the file sets none. */
export interface AgentSettingsView {
  readonly model: string | null;
  readonly models: readonly string[];
  readonly stepLimit: string | null;
}

/** The settings of `detail`: the file's for an agent with one, the agent's own statement for one in code. */
export function settingsOf(detail: AgentDetail): AgentSettingsView {
  const definition = detail.definition;
  if (detail.source !== 'file' || definition === null) {
    return {
      model: detail.codeDefinition?.model ?? null,
      models: detail.codeDefinition?.models ?? [],
      stepLimit: null,
    };
  }
  return {
    model: definition.model,
    models: definition.models ?? [],
    stepLimit: definition.stepLimit === null ? null : String(definition.stepLimit),
  };
}
