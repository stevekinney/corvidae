/**
 * COR-1883 — a Bureau that loads one plugin, for the plugin conformance suite and for a plugin's
 * own tests (`@lostgradient/bureau/testing`).
 *
 * @module plugin-test-host
 */
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PluginDescriptor } from '@lostgradient/interborough-plugin';
import { MemoryStorage } from '@lostgradient/storage';
import { createTool } from 'armorer';
import { z } from 'zod';

import type { AgentDefinitions } from '../agent-catalog.ts';
import { createBureau } from '../create-bureau.ts';
import type { BureauPlugins } from '../plugins/plugin-types.ts';
import { agentFileDirectory } from '../sources/agent-file-directory.ts';
import { layeredAgentSource } from '../sources/layered-source.ts';
import type { Bureau } from '../types.ts';

/** What {@link createPluginTestHost} takes beside the plugin. */
export interface PluginTestHostOptions {
  /** The value the plugin's `configuration` schema parses; absent parses `{}`. */
  readonly configuration?: unknown;
}

/** A Bureau that loads one plugin. */
export interface PluginTestHost {
  /** The Bureau itself, for a plugin's own tests to drive. */
  readonly bureau: Bureau<AgentDefinitions>;
  /** `bureau.plugins`: the one plugin and what is wrong with it. */
  readonly plugins: BureauPlugins;
  /** `bureau.agents`: every agent the Bureau lists, including the files the plugin ships. */
  readonly agents: Bureau<AgentDefinitions>['agents'];
  /**
   * Runs the scripted agent once (see {@link PluginScriptedRunRequest}): a file agent of the
   * owner's layer that chooses the named interceptors and calls the scripted model. It runs on the
   * same Bureau, so the plugin's every-agent sets apply to it as they do to any run.
   */
  scriptedRun(request: PluginScriptedRunRequest): Promise<PluginScriptedRunOutcome>;
  /** Stops the Bureau and removes the directory it kept the owner's files in. */
  dispose(): Promise<void>;
}

/** What {@link PluginTestHost.scriptedRun} runs: which scripted model, and which interceptors the agent chooses. */
export interface PluginScriptedRunRequest {
  /**
   * `answer` replies once with no tool call; `tool` replies with a call to a read-only tool, then
   * answers; `failure` throws from the model, so the run ends in an error.
   */
  readonly scenario: 'answer' | 'tool' | 'failure';
  /** The names of the plugin's interceptors the agent lists, as `plugin:name`. */
  readonly interceptors: readonly string[];
}

/** How a scripted run ended. */
export interface PluginScriptedRunOutcome {
  /** The run's finish reason; `error` when the run failed or could not settle. */
  readonly finishReason: string;
}

/** The scripted agent's file name (and so its agent identifier) in the owner's layer. */
const SCRIPTED_AGENT = 'contract-probe';

/** The one tool the scripted agent may call; read-only, so a call runs without an approval. */
const probeTool = createTool({
  name: 'contract-probe-tool',
  description: 'Answers the scripted run',
  input: z.object({}),
  metadata: { readOnly: true },
  execute: async () => 'probed',
});

/** A model the Bureau's default catalog holds, so the scripted agent file validates. */
const SCRIPTED_MODEL = 'anthropic/claude-opus-5-5';

/** The directory of agent files `plugin.content` ships, or `undefined` when it ships none. */
function shippedAgentDirectory(content: URL | undefined): string | undefined {
  if (content === undefined) return undefined;
  const directory = fileURLToPath(new URL('agents/', content));
  return existsSync(directory) ? directory : undefined;
}

/**
 * Starts a Bureau over memory storage that loads only `plugin`. Every secret the plugin declares
 * has a value, so a conforming plugin is `running` rather than `needs-setup`. The agent files in
 * the `agents/` directory of the plugin's `content` are layered beneath an empty owner directory
 * as the plugin's read-only layer, so a file naming a contribution the plugin does not hold is
 * reported on `plugins.list()` as `reference-unresolved`. The plugin is enabled whatever its
 * `enabledByDefault`, and every other way a shipped file can be invalid is on `agents.list()`. Models are scripted: nothing calls a
 * provider. The `workflows/` and `skills/` directories of `content` are not loaded.
 *
 * Call `dispose` when the test ends.
 */
export async function createPluginTestHost(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each plugin declares its own configuration schema.
  plugin: PluginDescriptor<z.ZodType<any>>,
  options: PluginTestHostOptions = {},
): Promise<PluginTestHost> {
  const owner = await mkdtemp(join(tmpdir(), 'bureau-plugin-test-host-'));
  const shipped = shippedAgentDirectory(plugin.content);
  // What the scripted model does now; absent outside a scripted run, when it answers its own name.
  let scripted:
    { readonly scenario: PluginScriptedRunRequest['scenario']; calls: number } | undefined;
  try {
    const bureau = await createBureau<AgentDefinitions>({
      agents: {},
      agentSource: layeredAgentSource([
        agentFileDirectory(owner, { tools: { [probeTool.name]: probeTool } }),
        ...(shipped === undefined ? [] : [agentFileDirectory(shipped, { plugin: plugin.name })]),
      ]),
      storage: new MemoryStorage(),
      durable: true,
      models: {
        generate: (descriptor) => async () => {
          if (scripted?.scenario === 'failure') throw new Error('The scripted model failed.');
          if (scripted?.scenario === 'tool' && scripted.calls++ === 0) {
            return { content: '', toolCalls: [{ name: probeTool.name, arguments: {} }] };
          }
          return { content: descriptor.model, toolCalls: [] };
        },
      },
      plugins: [{ descriptor: plugin, source: 'folder', location: plugin.name }],
      pluginSecrets: {
        get: async (key) => `test-secret:${key}`,
        watch: () => () => {},
      },
      // Enabled outright: a plugin that is off by default is still the plugin under test.
      pluginConfiguration: {
        [plugin.name]: {
          enabled: true,
          ...(options.configuration === undefined ? {} : { configuration: options.configuration }),
        },
      },
    });
    return {
      bureau,
      plugins: bureau.plugins,
      agents: bureau.agents,
      async scriptedRun({ scenario, interceptors }) {
        const listed = interceptors.map((name) => `${plugin.name}:${name}`);
        await writeFile(
          join(owner, `${SCRIPTED_AGENT}.md`),
          [
            '---',
            `model: ${SCRIPTED_MODEL}`,
            `tools: [${probeTool.name}]`,
            ...(listed.length === 0 ? [] : [`interceptors: [${listed.join(', ')}]`]),
            '---',
            'You are the scripted agent of the plugin contract.',
            '',
          ].join('\n'),
        );
        await bureau.agents.refresh();
        scripted = { scenario, calls: 0 };
        try {
          const task = await bureau.tasks.start(SCRIPTED_AGENT, 'Run the plugin contract.');
          const result = await task.result();
          return { finishReason: result.finishReason };
        } catch {
          return { finishReason: 'error' };
        } finally {
          scripted = undefined;
        }
      },
      async dispose() {
        try {
          await bureau.dispose();
        } finally {
          await rm(owner, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await rm(owner, { recursive: true, force: true });
    throw error;
  }
}
