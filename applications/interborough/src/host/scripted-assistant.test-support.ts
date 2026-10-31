/**
 * An agent named `assistant` that answers every message with one scripted reply, for a host test
 * whose workflow files or schedules name an agent and do not care which. It is passed as
 * `HostOptions.extraAgents`, so the test does not depend on the demo plugin.
 */
import { createAgent, createScriptedGenerate, stopWhen } from '@lostgradient/operative';

import type { ExtraAgents } from './host.ts';

/** What the scripted `assistant` says. */
export const SCRIPTED_ASSISTANT_REPLY = 'Hello from the assistant. This reply is scripted.';

/** A fresh `assistant`, so no two hosts share a script's position. */
export function scriptedAssistantAgents(): ExtraAgents {
  return {
    agents: {
      assistant: createAgent({
        name: 'assistant',
        description: 'Answers every message with the same scripted reply.',
        generate: createScriptedGenerate(
          Array.from({ length: 50 }, () => ({
            kind: 'respond' as const,
            response: { content: SCRIPTED_ASSISTANT_REPLY, toolCalls: [] },
          })),
        ),
        stopWhen: stopWhen.noToolCalls(),
      }),
    },
  };
}
