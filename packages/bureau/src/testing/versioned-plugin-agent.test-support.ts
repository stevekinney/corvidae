/**
 * A plugin `p` whose one code agent, `p:echo`, is built from the options a test gives it
 * (COR-2233, COR-2230): the plugin's version, the agent's own `version`, `title` and `visibility`,
 * and the `generate` the agent answers with. The agent holds one tool, `next`, so a script can
 * take a step before it stops.
 */
import { definePlugin, type PluginAgentVisibility } from '@lostgradient/interborough-plugin';
import {
  createAgent,
  type GenerateFunction,
  stopWhen,
  type Toolbox,
} from '@lostgradient/operative';
import { createTool, createToolbox } from 'armorer';
import { z } from 'zod';

const next = createTool({
  name: 'next',
  description: 'continue',
  input: z.object({}),
  execute: async () => 'ok',
});

/** What a test decides about the plugin and its agent. */
export interface VersionedPluginOptions {
  /** The plugin's version. */
  readonly version: string;
  /** The agent's own `version`, which replaces the plugin's in a run's pin. */
  readonly agentVersion?: string;
  readonly title?: string;
  readonly visibility?: PluginAgentVisibility;
  /** The agent's model. */
  readonly generate: GenerateFunction;
  /** The agent's name inside the plugin. Defaults to `echo`. */
  readonly name?: string;
  /** Declares the secret `p-key`, so the plugin's secret gate wraps its agents. */
  readonly secret?: boolean;
  /** The agent's tools; by default the one tool, `next`. */
  readonly toolbox?: Toolbox;
}

/** The secret a plugin built with `secret: true` declares. */
export const VERSIONED_PLUGIN_SECRET = 'p-key';

/** The plugin entry `BureauOptions.plugins` takes. */
export function versionedPlugin(options: VersionedPluginOptions) {
  const name = options.name ?? 'echo';
  return {
    descriptor: definePlugin({
      name: 'p',
      version: options.version,
      description: 'A plugin whose agent carries metadata.',
      ...(options.secret === true ? { secrets: [VERSIONED_PLUGIN_SECRET] } : {}),
      setup: () => ({
        agents: [
          {
            name,
            ...(options.agentVersion === undefined ? {} : { version: options.agentVersion }),
            ...(options.title === undefined ? {} : { title: options.title }),
            ...(options.visibility === undefined ? {} : { visibility: options.visibility }),
            agent: createAgent({
              name,
              toolbox: options.toolbox ?? createToolbox([next]),
              stopWhen: stopWhen.noToolCalls(),
              generate: options.generate,
            }),
          },
        ],
      }),
    }),
    source: 'package' as const,
    location: '@example/p',
  };
}
