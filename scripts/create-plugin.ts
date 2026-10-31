/**
 * Writes a folder plugin (COR-1883): `bun scripts/create-plugin.ts <name> --to <directory>` creates
 * `<directory>/<name>/` with `plugin.ts`, `content/agents/assistant.md` and `plugin.test.ts`. The
 * plugin contributes one tool and ships one agent that uses it, so `bun scripts/check-plugin.ts
 * <directory>/<name>` passes on what it writes. It refuses a name outside the plugin grammar and a
 * folder that already exists.
 */
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { pluginNamePattern } from '../packages/interborough-plugin/src/plugin-name.ts';

/** The model the shipped agent names; the test host scripts models, so no provider is called. */
const agentModel = 'anthropic/claude-opus-5-5';

/** The files of a folder plugin named `name`, by path relative to its folder. */
export function pluginScaffold(name: string): Record<string, string> {
  return {
    'plugin.ts': `import { definePlugin } from '@lostgradient/interborough-plugin';
import { createTool } from 'armorer';
import { z } from 'zod';

export default definePlugin({
  name: '${name}',
  version: '0.1.0',
  description: 'The ${name} plugin.',
  content: new URL('./content/', import.meta.url),
  setup: () => ({
    tools: [
      createTool({
        name: 'greet',
        description: 'Greets someone by name.',
        input: z.object({ name: z.string() }),
        metadata: { readOnly: true },
        execute: async ({ name }) => \`Hello, \${name}.\`,
      }),
    ],
  }),
});
`,
    'content/agents/assistant.md': `---
name: ${name} assistant
model: ${agentModel}
tools: [${name}:greet]
---
You greet people with the ${name}:greet tool.
`,
    'plugin.test.ts': `import { createPluginTestHost } from '@lostgradient/bureau/testing';
import { pluginContract } from '@lostgradient/interborough-plugin/testing';

import plugin from './plugin.ts';

pluginContract(plugin, { createHost: createPluginTestHost });
`,
  };
}

/** Writes the scaffold under `directory/name` and returns that folder, or why it refused. */
export async function createPlugin(
  name: string | undefined,
  directory: string | undefined,
): Promise<{ folder: string } | { problem: string }> {
  if (name === undefined || directory === undefined) {
    return { problem: 'Usage: bun scripts/create-plugin.ts <name> --to <directory>' };
  }
  if (!pluginNamePattern.test(name)) {
    return {
      problem: `"${name}" is not a plugin name: start with a lowercase letter and use only lowercase letters, digits and hyphens, ending in a letter or digit.`,
    };
  }
  const folder = join(resolve(directory), name);
  if (existsSync(folder)) return { problem: `${folder} already exists.` };
  for (const [path, text] of Object.entries(pluginScaffold(name))) {
    await mkdir(join(folder, path, '..'), { recursive: true });
    await Bun.write(join(folder, path), text);
  }
  return { folder };
}

if (import.meta.main) {
  const argumentsList = process.argv.slice(2);
  const toIndex = argumentsList.indexOf('--to');
  const directory = toIndex === -1 ? undefined : argumentsList[toIndex + 1];
  const name = argumentsList.find(
    (argument, index) => !argument.startsWith('--') && index !== toIndex + 1,
  );
  const result = await createPlugin(name, directory);
  if ('problem' in result) {
    process.stderr.write(`${result.problem}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`Wrote ${result.folder}\n`);
  }
}
