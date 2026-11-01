/**
 * The model an agent's chat runs on when the chat was never switched (the chat's own model is
 * `bureau.contexts.get`'s). `bureau.agents.models` names the agent's default when it knows it; an
 * agent that allows exactly one model has no other to run on, so that one is its model even when the
 * Bureau names no default. Anything else is unknown, and the page says "Agent default".
 */
import type { AgentModels } from '../../lib/bureau-client.ts';

/** The model name an agent runs on with no override, or `null` when it is not known. */
export function agentModel(
  models: AgentModels | undefined,
): { readonly provider: string | null; readonly model: string } | null {
  if (models === undefined) return null;
  if (models.default !== null) return models.default;
  const [only, ...others] = models.models;
  return only !== undefined && others.length === 0
    ? { provider: only.provider, model: only.model }
    : null;
}
