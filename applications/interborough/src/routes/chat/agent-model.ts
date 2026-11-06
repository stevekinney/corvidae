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

/**
 * A model's name as a person reads it. The Bureau's catalog holds no label of its own, so its
 * `displayName` is the provider-native model name; an Anthropic name of the form
 * `claude-<family>-<major>-<minor>` reads as "Claude Sonnet 5.5", and any other name is its own.
 */
export function modelDisplayName(model: string): string {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(model);
  if (match === null) return model;
  const [, family = '', major = '', minor] = match;
  const name = family.charAt(0).toUpperCase() + family.slice(1);
  return `Claude ${name} ${major}${minor === undefined ? '' : `.${minor}`}`;
}

/**
 * The model a chat ran on, as a person reads it, and the name the Bureau knows it by. It is the
 * chat's own when it was switched, else its agent's (`agentModel`), else the model that wrote its
 * latest reply (`lastReply`: a chat on an agent that names none still records the model of each
 * reply); `null` when none of them is known. The agent's listing names the model when it has a
 * label of its own, and otherwise {@link modelDisplayName} does.
 */
export function modelInUse(
  own: { readonly provider: string | null; readonly model: string } | null | undefined,
  models: AgentModels | undefined,
  lastReply?: { readonly provider: string | null; readonly model: string },
): { readonly displayName: string; readonly model: string } | null {
  const name = own ?? agentModel(models) ?? lastReply ?? null;
  if (name === null) return null;
  const listed = models?.models.find(
    (choice) =>
      choice.model === name.model && (name.provider === null || choice.provider === name.provider),
  );
  const labelled =
    listed !== undefined && listed.displayName !== listed.model ? listed.displayName : undefined;
  return { displayName: labelled ?? modelDisplayName(name.model), model: name.model };
}
