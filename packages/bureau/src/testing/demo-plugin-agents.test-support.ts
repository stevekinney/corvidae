/**
 * A `demo` plugin that ships two code agents, for the tests of code agent overrides (COR-2228):
 * `demo:echo`, which resolves its run options and records what its model was shown, and
 * `demo:scripted`, whose definition resolver is hidden, so no override can reach it. The plugin
 * contributes one tool, `demo:lookup`, and declares the secret {@link DEMO_SECRET_KEY} when asked.
 */
import { definePlugin } from '@lostgradient/interborough-plugin';
import { createAgent, OPERATIVE_RESOLVE_RUN_OPTIONS, stopWhen } from '@lostgradient/operative';
import { createTool, createToolbox } from 'armorer';
import { z } from 'zod';

import type { AnyRunnableAgent } from '../agent-catalog.ts';

/** The secret the demo plugin declares when it needs setup. */
export const DEMO_SECRET_KEY = 'demo-api-key';
/** What each agent's model was shown at a step: its system message and the tools it was offered. */
export const seen: {
  readonly agent: string;
  readonly system?: string;
  readonly tools: string[];
}[] = [];

const lookup = createTool({
  name: 'lookup',
  description: 'Looks something up',
  input: z.object({}),
  metadata: { readOnly: true },
  execute: async () => ({ found: true }),
});

function echoAgent(name: string): AnyRunnableAgent {
  return createAgent({
    name,
    instructions: 'You echo.',
    toolbox: createToolbox([]),
    stopWhen: stopWhen.noToolCalls(),
    generate: async ({ conversation, toolbox }) => {
      const system = conversation.getFirstSystemMessage()?.content;
      seen.push({
        agent: name,
        ...(typeof system === 'string' ? { system } : {}),
        tools: toolbox.tools().map((tool) => tool.name),
      });
      return { content: `${name} answered`, toolCalls: [] };
    },
  });
}

/** An agent whose definition resolver is hidden: Bureau can run it, but no override can reach it. */
function withoutResolver(agent: AnyRunnableAgent): AnyRunnableAgent {
  return new Proxy(agent, {
    get: (target, key, receiver) =>
      key === OPERATIVE_RESOLVE_RUN_OPTIONS ? undefined : Reflect.get(target, key, receiver),
  });
}

export function demoPlugin(options: { readonly secret?: boolean } = {}) {
  return {
    descriptor: definePlugin({
      name: 'demo',
      version: '1.0.0',
      description: 'A plugin with agents.',
      ...(options.secret === true ? { secrets: [DEMO_SECRET_KEY] } : {}),
      setup: () => ({
        tools: [lookup],
        agents: [
          { name: 'echo', agent: echoAgent('echo') },
          { name: 'scripted', agent: withoutResolver(echoAgent('scripted')) },
        ],
      }),
    }),
    source: 'package' as const,
    location: '@example/demo',
  };
}
