/**
 * COR-1879 — a contributed tool under its plugin's identity.
 *
 * A tool's id is `plugin:name`, and a durable record pins `plugin:name@version`. A tool that
 * declares its own version keeps it; one that declares none takes its plugin's, so a tool call
 * recorded against plugin `p` at `2.0.0` resumes only while `p` is loaded at `2.0.0`.
 *
 * @module plugin-tools
 */

import { createToolbox, type AnyTool, type Tool } from 'armorer';

/**
 * `tool` with the identity `plugin:<name>@<version>`, where the version is the tool's own when it
 * declares one and `pluginVersion` otherwise. Everything else the tool carries (its schema,
 * execute, policy, risk, metadata) is kept: the tool is rebuilt from its own configuration.
 */
export function pluginTool(tool: AnyTool, plugin: string, pluginVersion: string): Tool {
  const { id: _id, identity, ...configuration } = tool.configuration;
  const [rebuilt] = createToolbox([
    {
      ...configuration,
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
