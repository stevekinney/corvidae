/**
 * COR-1883 — a Bureau that loads one plugin, for the plugin conformance suite and for a plugin's
 * own tests (`@lostgradient/bureau/testing`).
 *
 * @module plugin-test-host
 */
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PluginDescriptor } from '@lostgradient/interborough-plugin';
import { MemoryStorage } from '@lostgradient/storage';
import type { z } from 'zod';

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
  /** Stops the Bureau and removes the directory it kept the owner's files in. */
  dispose(): Promise<void>;
}

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
  try {
    const bureau = await createBureau<AgentDefinitions>({
      agents: {},
      agentSource: layeredAgentSource([
        agentFileDirectory(owner),
        ...(shipped === undefined ? [] : [agentFileDirectory(shipped, { plugin: plugin.name })]),
      ]),
      storage: new MemoryStorage(),
      durable: true,
      models: {
        generate: (descriptor) => async () => ({ content: descriptor.model, toolCalls: [] }),
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
