# @lostgradient/interborough-plugin

The authoring package for Interborough plugins. A plugin is trusted, in-process code that the host loads once at startup; this package gives it `definePlugin`, the descriptor it declares, the context `setup` receives, the host API `afterStart` receives, and the types of everything it can contribute. Bureau depends on this package and never the other way around, so a plugin imports nothing from Bureau.

| Export | What it is |
| --- | --- |
| `definePlugin` | Declares a plugin and refuses a malformed descriptor where it is written. |
| `PluginDescriptor` | `name`, `version`, `description`, `required`, `enabledByDefault`, `configuration`, `secrets`, `content`, and `setup`. |
| `PluginSetupContext` | The parsed `configuration`, the `secrets` reader, and `storage` confined to the key prefix `plugin:<name>:`. |
| `PluginSetupResult` | What `setup` returns: the contributions, and `afterStart(bureau, context)`. |
| `PluginHostApi` | The structural slice of Bureau `afterStart` receives: `agents.list`, `schedules.list`, `schedules.create`, `goals.create`. |
| `PluginContributions` | Tools, activities, validators, guardrails, run hooks, decision routers, trigger kinds, hook action kinds, providers, embedders, memory detectors, eval judges, MCP apps, event formatters, and code agents. |
| `createPluginStorage` | Scopes a `Storage` to a plugin's key prefix. The host calls it; a plugin receives the result. |

## Write a plugin

`definePlugin` infers the type of `configuration` inside `setup` from the schema, so `configuration.teamKey` below is a `string`.

```ts
import { definePlugin } from '@lostgradient/interborough-plugin';
import { createTool } from 'armorer';
import { z } from 'zod';

export default definePlugin({
  name: 'example',
  version: '1.0.0',
  description: 'An example plugin.',
  configuration: z.object({ teamKey: z.string().default('COR') }),
  secrets: ['example-api-key'],
  content: new URL('../content/', import.meta.url),
  setup({ configuration }) {
    return {
      tools: [
        createTool({
          name: 'echo',
          version: '1.0.0',
          description: 'Echo.',
          input: z.object({ text: z.string() }),
          execute: async ({ text }) => `${configuration.teamKey}: ${text}`,
        }),
      ],
    };
  },
});
```

A secret is either its Bungalow key or `{ key, generated: true }`, which asks the host to create a random value on first enable. A plugin whose required secret is missing still loads; the contributions that need it wait until the owner saves it.

## Do work after Bureau starts

`afterStart` receives the host API and the same context `setup` received.

```ts
import { definePlugin } from '@lostgradient/interborough-plugin';

export default definePlugin({
  name: 'digest',
  version: '1.0.0',
  description: 'Schedules a daily digest.',
  setup() {
    return {
      async afterStart(bureau, { storage }) {
        const existing = await bureau.schedules.list();
        const agent = bureau.agents.list().find((listing) => listing.state === 'ready');
        if (agent && existing?.items.length === 0) {
          await bureau.schedules.create({
            agentName: agent.name,
            input: 'Summarize today.',
            spec: '1d',
          });
          await storage.put('scheduled', new Uint8Array([1]));
        }
      },
    };
  },
});
```
