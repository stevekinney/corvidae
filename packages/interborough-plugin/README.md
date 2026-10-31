# @lostgradient/interborough-plugin

The authoring package for Interborough plugins. A plugin is trusted, in-process code that the host loads once at startup; this package gives it `definePlugin`, the descriptor it declares, the context `setup` receives, the host API `afterStart` receives, and the types of everything it can contribute. Bureau depends on this package and never the other way around, so a plugin imports nothing from Bureau.

| Export | What it is |
| --- | --- |
| `definePlugin` | Declares a plugin and refuses a malformed descriptor where it is written. |
| `PluginDescriptor` | `name`, `version`, `description`, `required`, `enabledByDefault`, `configuration`, `secrets`, `content`, and `setup`. |
| `PluginSetupContext` | The parsed `configuration`, the `secrets` reader, and `storage` confined to the key prefix `plugin:<name>:`. |
| `PluginSetupResult` | What `setup` returns: the contributions, and `afterStart(bureau, context)`. |
| `PluginHostApi` | The structural slice of Bureau `afterStart` receives: `agents.list`, `schedules.list`, `schedules.create`, `goals.create`. |
| `PluginContributions` | Tools, activities, validators, guardrails, run hooks, decision routers, trigger kinds, hook action kinds, providers (each with its catalog rows), embedders, memory detectors, eval judges, MCP apps, event formatters, and code agents. |
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

## Test a plugin

`@lostgradient/interborough-plugin/testing` holds `pluginContract`, the conformance suite every plugin runs. It takes the host as an argument, so this package never imports Bureau; Bureau's `@lostgradient/bureau/testing` supplies `createPluginTestHost`, a Bureau that loads only your plugin with a value for every secret it declares and the files in your `content/agents/` directory.

```ts
import { definePlugin } from '@lostgradient/interborough-plugin';
import {
  type CreatePluginTestHost,
  pluginContract,
} from '@lostgradient/interborough-plugin/testing';

// In a plugin's own test this is `import { createPluginTestHost } from '@lostgradient/bureau/testing'`.
declare const createPluginTestHost: CreatePluginTestHost;

const plugin = definePlugin({
  name: 'example',
  version: '1.0.0',
  description: 'An example plugin.',
});

pluginContract(plugin, { createHost: createPluginTestHost });
```

The suite registers one test per check. The descriptor must be valid, the identities it holds must read without a host and never repeat, and the host must report the plugin `running` with no problems, which includes every file it ships resolving the contributions it names (`reference-unresolved`). `checkPluginContract` runs the same checks and returns the failures instead of registering tests.

## Commit the plugin's identities

A durable record pins a contribution's id and version, so a schema must not change under a version a plugin already shipped. Each `plugins/*` workspace commits a `plugin-identities.json` with its configuration and every contribution's id, version and schema digest. Write or refresh it from the repository root:

```sh
bun scripts/check-plugin-identities.ts --write plugins/example
```

`bun run lint:root` runs `scripts/check-plugin-identities.ts`, which fails when a workspace has no file, when a file no longer matches its plugin, and when a digest differs from the same file at the baseline ref while the version does not. The baseline is `CORVIDAE_PLUGIN_IDENTITY_BASE` when it is set and `origin/main` otherwise; a ref that does not resolve fails the guard and names the variable. A plugin whose file is absent at the baseline is new and passes. A plugin workspace's entry is its `package.json` `exports["."]`, and the plugin is that module's default export.

## Write a folder plugin

`bun scripts/create-plugin.ts <name> --to <directory>` writes `<directory>/<name>/` with `plugin.ts`, `content/agents/assistant.md` and `plugin.test.ts`. `bun scripts/check-plugin.ts <directory>/<name>` type-checks `plugin.ts` against this package's declarations and runs the contract. Test files are not type-checked by that script, because they import Bureau.
