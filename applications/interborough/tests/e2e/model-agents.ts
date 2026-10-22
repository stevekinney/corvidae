/**
 * The agent the end-to-end model picker spec uses to show that the picker is hidden when an agent
 * allows one model (COR-1565). The seeded `model-switcher` allows two, and `echo` none. This one
 * names a single catalog model in `allowedCandidates`, so `bureau.agents.models` lists one and
 * Chat shows no choice.
 */
import { createAgent, createScriptedGenerate, stopWhen } from '@lostgradient/operative';

/** The name the e2e host publishes the one-model agent under. */
export const SINGLE_MODEL_AGENT_NAME = 'single-model';

export function createModelAgents() {
  return {
    [SINGLE_MODEL_AGENT_NAME]: createAgent({
      name: SINGLE_MODEL_AGENT_NAME,
      description: 'Allows one model, so a chat with it has nothing to switch.',
      generate: createScriptedGenerate(
        Array.from({ length: 20 }, () => ({
          kind: 'respond' as const,
          response: { content: 'This agent allows one model.', toolCalls: [] },
        })),
      ),
      allowedCandidates: [{ provider: 'anthropic', model: 'claude-sonnet-5' }],
      stopWhen: stopWhen.noToolCalls(),
    }),
  };
}
