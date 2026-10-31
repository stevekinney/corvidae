/**
 * COR-1879 — a contributed tool under its plugin's identity.
 *
 * A tool's id is `plugin:name`, and a durable record pins `plugin:name@version`. A tool that
 * declares its own version keeps it; one that declares none takes its plugin's, so a tool call
 * recorded against plugin `p` at `2.0.0` resumes only while `p` is loaded at `2.0.0`.
 *
 * @module plugin-tools
 */

import { createToolbox, formatToolId, type AnyTool, type Tool } from 'armorer';

import type { PluginSecretGate } from './plugin-secret-gate';

type Execute = (params: unknown, context?: unknown) => Promise<unknown>;

/** `execute` (a function or a promise of one) refusing through `gate` before it is called. */
function gatedExecute(gate: PluginSecretGate, id: string, execute: unknown): Execute {
  return async (params, context) => {
    gate.assertAvailable(id);
    const run = (await execute) as Execute;
    return run(params, context);
  };
}

/**
 * `tool` with the identity `plugin:<name>@<version>`, where the version is the tool's own when it
 * declares one and `pluginVersion` otherwise. Everything else the tool carries (its schema,
 * execute, policy, risk, metadata) is kept: the tool is rebuilt from its own configuration. With
 * a `gate`, its `execute` (and `rawExecute`, which Armorer prefers when present) refuses while a
 * secret the plugin declared is not set.
 */
export function pluginTool(
  tool: AnyTool,
  plugin: string,
  pluginVersion: string,
  gate?: PluginSecretGate,
): Tool {
  const { id: _id, identity, ...configuration } = tool.configuration;
  const contribution = formatToolId({ namespace: plugin, name: identity.name });
  const rawExecute: unknown = Reflect.get(configuration, 'rawExecute');
  const [rebuilt] = createToolbox([
    {
      ...configuration,
      ...(gate === undefined
        ? {}
        : {
            execute: gatedExecute(gate, contribution, configuration.execute),
            ...(typeof rawExecute === 'function'
              ? { rawExecute: gatedExecute(gate, contribution, rawExecute) }
              : {}),
          }),
      identity: {
        namespace: plugin,
        name: identity.name,
        version: identity.version ?? pluginVersion,
      },
    },
  ]).tools();
  if (rebuilt === undefined) {
    throw new TypeError(`The tool "${identity.name}" of plugin "${plugin}" could not be rebuilt.`);
  }
  return rebuilt;
}
