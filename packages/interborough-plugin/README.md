# @lostgradient/interborough-plugin

The authoring package for Interborough plugins. A plugin is trusted, in-process code that the host loads once at startup; this package gives it `definePlugin`, the descriptor it declares, the context `setup` receives, the host API `afterStart` receives, and the types of everything it can contribute. Bureau depends on this package and never the other way around, so a plugin imports nothing from Bureau.

| Export | What it is |
| --- | --- |
| `definePlugin` | Declares a plugin and refuses a malformed descriptor where it is written. |
| `PluginDescriptor` | `name`, `version`, `description`, `required`, `enabledByDefault`, `configuration`, `secrets`, `content`, and `setup`. |
| `PluginSetupContext` | The parsed `configuration`, the `secrets` reader, `storage` confined to the key prefix `plugin:<name>:`, the `host` API, and `toolApprovalHooks`, the host's tool-approval rule as a `policy` for a toolbox the plugin builds for a code agent. |
| `PluginSetupResult` | What `setup` returns: the contributions, and `afterStart(bureau, context)`. |
| `PluginHostApi` | The structural slice of Bureau `afterStart` receives: `agents.list`, `schedules.list`, `schedules.create`, `goals.create`. |
| `PluginContributions` | Tools, activities, validators, guardrails, run hooks, decision routers, trigger kinds, hook action kinds, providers (each with its catalog rows), embedders, memory detectors, eval judges, MCP apps, event formatters, and code agents. |
| `createPluginStorage` | Scopes a `Storage` to a plugin's key prefix. The host calls it; a plugin receives the result. |

## Where a plugin lives

A plugin is a module whose default export is `definePlugin(...)`. There are two homes for one, and the code is the same in both.

- **A workspace package** under `plugins/<name>`. Its `package.json` `exports["."]` points at the module (`./src/plugin.ts`), the host lists it in `applications/interborough/src/host/plugins.ts`, and it commits a `plugin-identities.json`. Its `dependencies` may name this package, the libraries a contribution is built from and external packages; `@lostgradient/bureau` and the `testing/*` workspaces belong in `devDependencies` only (`scripts/plugin-dependency-rules.ts`).
- **A folder** in Bungalow's `plugins/` directory (`<bungalow>/plugins/<name>/plugin.ts`), which needs no install and no workspace. The next sections use a folder because that is what the scaffold writes.

Workspace plugins load first, in the order the host lists them, and folder plugins after them by folder name. The first plugin to claim a name keeps it; a later one is skipped with `name-clash`.

Plugin code is trusted and runs in the host's process. It loads once, when the host starts. There is no sandbox and no hot reload of code; the files a plugin ships (below) are the one thing that reloads while the host runs.

## Scaffold your first plugin

```sh
bun scripts/create-plugin.ts example --to ~/plugins
bun scripts/check-plugin.ts ~/plugins/example
```

The first command writes `~/plugins/example/` with `plugin.ts`, `content/agents/assistant.md`, `content/workflows/digest.json`, `content/skills/greeting/SKILL.md` and `plugin.test.ts`. It refuses a name outside the plugin grammar and a folder that already exists. The plugin contributes one tool, `example:greet`, and ships an agent that uses it, a workflow that runs the agent when a signal arrives (so nothing fires by itself) and a skill.

The second command type-checks `plugin.ts` against this package's declarations and runs the conformance suite with Bureau's test host. It exits 0 when the plugin conforms, 1 when it does not and 2 on a usage error. It does not type-check `plugin.test.ts`, which imports Bureau. `scripts/create-plugin.slow.test.ts` runs both commands in a temporary directory on every `test:slow`, so this walkthrough cannot drift from the scaffold.

To run it, copy the folder into `<bungalow>/plugins/` (usually `~/.interborough/plugins/`) and restart the host, or point the development entry at the folder where it is and let it restart for you:

```sh
bun run --filter=@lostgradient/interborough dev --plugin ~/plugins/example
```

`--plugin` is repeatable. The plugin is listed with a `development-source` problem, which only tells the owner it is a work in progress, and under `bun --watch` an edit to its `plugin.ts` restarts the host in place.

## Declare a plugin

`definePlugin` infers the type of `configuration` inside `setup` from the schema, so `configuration.teamKey` below is a `string`. It refuses a malformed descriptor where it is written: a name outside the grammar, an empty version or description, or a secret that is empty or declared twice.

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
  content: new URL('./content/', import.meta.url),
  setup({ configuration }) {
    return {
      tools: [
        createTool({
          name: 'echo',
          description: 'Echo.',
          input: z.object({ text: z.string() }),
          execute: async ({ text }) => `${configuration.teamKey}: ${text}`,
        }),
      ],
    };
  },
});
```

The descriptor's members:

- `name`, `version`, `description`: required. The name prefixes every contribution's id.
- `required`: the owner cannot disable the plugin.
- `enabledByDefault`: whether the plugin runs before the owner has chosen. It defaults to `true`; the demo plugin sets `false`.
- `configuration`: a Zod schema. The owner's value for it is parsed before `setup` runs.
- `secrets`: the Bungalow secret keys the plugin needs.
- `content`: the directory of agent, workflow and skill files the plugin ships.
- `setup`: builds the contributions once at startup and may return `afterStart`.

## What a plugin can contribute

`setup` returns an object whose members are all optional, so a plugin names only the kinds it contributes.

| Member | What it adds |
| --- | --- |
| `tools` | Tools agents can call. |
| `activities` | Activities a shipped workflow calls as `plugin:name`. |
| `validators` | Goal validators, registered by name and version. |
| `guardrails` | `inputDetectors` and `outputValidators`, added to the ones Operative applies to every agent. |
| `runHooks` | Hooks added to every run. |
| `decisionRouters` | Decision models that answer decisions of the kinds they name. |
| `triggerKinds` | New external sources that start work. |
| `hookActionKinds` | New things a hook can do when its event happens. |
| `providers` | Model providers, each with the catalog rows of its models. |
| `embedders` | Embedders the `memory.embedder` setting can name. |
| `memoryDetectors` | Detectors run after the default poisoning detector, on memory admission and on recall. |
| `evalJudges` | Judges that score a sample of completed runs. |
| `mcpApps` | Interface panels. |
| `eventFormatters` | Titles and bodies for the activity views. |
| `codeAgents` | Agents defined in code. |

Four kinds are worth seeing in code, because they take a schema or a callback whose shape is not obvious from the name. A trigger kind starts listening and resolves with the function that stops it; a hook action kind receives an `idempotencyKey` that is the same for every attempt of one delivery, because a delivery interrupted by a restart is attempted again.

```ts
import { definePlugin } from '@lostgradient/interborough-plugin';
import { z } from 'zod';

export default definePlugin({
  name: 'notifier',
  version: '1.0.0',
  description: 'Fires on a timer, notifies on an event, and formats its own events.',
  setup: () => ({
    activities: [
      {
        name: 'lookup',
        execute: async (argument: { input: unknown }) => ({ found: argument.input }),
      },
    ],
    triggerKinds: [
      {
        name: 'heartbeat',
        description: 'Fires every interval.',
        configuration: z.object({ seconds: z.number().int().positive() }),
        async start({ configuration, fire, signal }) {
          const { seconds } = z.object({ seconds: z.number() }).parse(configuration);
          const timer = setInterval(() => {
            if (!signal.aborted) void fire({ at: Date.now() });
          }, seconds * 1000);
          return () => clearInterval(timer);
        },
      },
    ],
    hookActionKinds: [
      {
        name: 'notify',
        description: 'Posts the event somewhere, once per delivery.',
        configuration: z.object({ channel: z.string() }),
        async run({ event, idempotencyKey, signal }) {
          signal.throwIfAborted();
          console.log(idempotencyKey, event.kind);
        },
      },
    ],
    eventFormatters: [
      {
        name: 'completed',
        eventKinds: ['run.completed'],
        format: (event) => ({ title: `A run completed on ${event.bureauId}` }),
      },
    ],
  }),
});
```

An interface panel is a page the host bundles from a browser entry at startup and serves as a `ui://` resource, under a content security policy that denies every origin and permission. A panel may call only the tools in `allowedTools`, and `opensFromTool` is the one of them a client runs to open it. The tool must be unique across plugins, because a tool links to one page: a second app that opens from the same tool is skipped with `name-clash`. Put the version in the `uri`, so a changed contract is a new resource.

```ts
import { definePlugin, type PluginMcpApp } from '@lostgradient/interborough-plugin';

const runInspector: PluginMcpApp = {
  name: 'run-inspector',
  title: 'Run inspector',
  uri: 'ui://example/run-inspector/v1',
  entry: new URL('./run-inspector/app.ts', import.meta.url),
  allowedTools: ['bureau.tasks.inspect', 'bureau.tasks.cancel'],
  opensFromTool: 'bureau.tasks.inspect',
};

export default definePlugin({
  name: 'inspector',
  version: '1.0.0',
  description: 'A run inspector panel.',
  setup: () => ({ mcpApps: [runInspector] }),
});
```

An entry that does not build leaves the plugin `running` with an `mcp-app-failed` problem, and the other contributions keep working.

## Identities: files float, records pin

Every contribution has an id, `plugin:name`, and a name matches `^[a-z](?:[a-z0-9-]*[a-z0-9])?$` in the plugin and in each contribution. A tool's id carries its version, `plugin:name@version`.

- **Files float.** An agent or workflow file names a contribution as `plugin:name` with no version and uses whichever version is loaded. A skill or an allow or deny list matches the unversioned id.
- **Records pin.** A durable record (a run's tool calls, a goal's validator, a workflow revision's activities, a hook delivery) stores `plugin:name@version` and resolves only that version. If the version is not loaded, the record reports `missing` or `version-mismatch`, never another version, and the plugin gets a `pinned-version-unavailable` problem. A waiting run pinned to it is not resumed on another version.
- **Which version.** A contribution's own `version` when it declares one, otherwise the plugin's. A tool without a version registers with its plugin's: a plugin at `2.0.0` contributing the tool `t` registers `p:t@2.0.0`.
- **What the model sees.** The provider-facing tool name is `plugin__tool`, because providers restrict the characters in a tool name. You write `plugin:tool` everywhere else.

So the rule for changing a plugin is: bump the version whenever a contribution's schema changes, because something durable may be holding the old one.

An event a plugin causes through its host API (a schedule or a goal it creates) carries `source: '<plugin>'`; an event from Bureau core carries none.

## Commit the plugin's identities

Each `plugins/*` workspace commits a `plugin-identities.json` with its configuration and every contribution's id, version and a digest of its schema. Write or refresh it from the repository root:

```sh
bun scripts/check-plugin-identities.ts --write plugins/example
```

`bun run lint:root` runs `scripts/check-plugin-identities.ts`, which fails when a workspace has no file, when a file no longer matches its plugin, and when a digest differs from the same file at the baseline ref while the version does not. That last case is a schema that changed under a version records may already hold. The baseline is `CORVIDAE_PLUGIN_IDENTITY_BASE` when it is set and `origin/main` otherwise; a ref that does not resolve fails the guard and names the variable. A plugin whose file is absent at the baseline is new and passes. A schema must describe itself the same way on every run: only a function default (such as a generated id) may vary, and the digest records it as volatile. A plugin workspace's entry is its `package.json` `exports["."]`, and the plugin is that module's default export. Folder plugins have no workspace and no guard; the discipline is the same.

## Ship agents, workflows and skills

Set `content` to a directory and put files in it:

- `content/agents/<name>.md`: an agent, with front matter for `name`, `model` and `tools`.
- `content/workflows/<name>.json`: a workflow definition whose `name` is `plugin:name`.
- `content/skills/<name>/SKILL.md`: a skill, taken from a trusted plugin source.

The scaffold's agent and workflow show the shape:

```md
---
name: example assistant
model: anthropic/claude-opus-5-5
tools: [example:greet]
---

You greet people with the example:greet tool.
```

```json
{
  "name": "example:digest",
  "description": "Asks the example assistant to greet the team.",
  "trigger": { "kind": "signal", "name": "example-digest" },
  "steps": [
    {
      "kind": "activity",
      "handler": "agent",
      "input": { "agent": "example:assistant", "message": "Greet the team." }
    }
  ]
}
```

A running plugin's agents and workflows are listed as `plugin:name`, and a plugin that is disabled or skipped ships nothing. Files reload while the host runs, but they are read-only: the host refuses to write or delete a definition a plugin holds, and says to duplicate it. Duplicate writes an editable copy into the owner's directory, and an owner file's stem has no `:`, so a copy can never claim a plugin's namespace. A workflow file calls a plugin activity as `plugin:name`, with no version.

A file that names a contribution nothing loaded holds (a tool you misspelled, a plugin that is disabled) is invalid with a `reference-unresolved` problem naming the file and the id. The plugin stays `running`.

## Configuration and secrets

The owner's choices persist under `plugins.<name>` in Bungalow's `configuration.json`, as `{ "enabled": true, "configuration": { ... } }`, and `setup` receives only that entry's `configuration`, parsed by your schema. A value the schema refuses skips the plugin with a `configuration-invalid` problem naming the field, and the host still starts. Give every field a default so the plugin works with no entry at all.

A secret is declared by its full Bungalow key, or as `{ key, generated: true }`, which asks the host to create a random value the first time the plugin is enabled. A remote deployment cannot write secrets, so a generated secret there must be set in the environment. A key the host keeps for itself is refused with `secret-refused`. Read a secret inside the contribution, when you need it:

```ts
import { definePlugin } from '@lostgradient/interborough-plugin';
import { createTool } from 'armorer';
import { z } from 'zod';

export default definePlugin({
  name: 'tracker',
  version: '1.0.0',
  description: 'Reads an issue tracker.',
  secrets: ['tracker-api-key', { key: 'tracker-signing-key', generated: true }],
  setup: ({ secrets }) => ({
    tools: [
      createTool({
        name: 'search',
        description: 'Searches the tracker.',
        input: z.object({ query: z.string() }),
        metadata: { readOnly: true },
        execute: async ({ query }) => {
          const key = await secrets.get('tracker-api-key');
          return key === undefined ? 'unavailable' : `searched ${query}`;
        },
      }),
    ],
  }),
});
```

A plugin whose declared secret is missing still loads. Every contribution it registered is available but refuses to run, and the plugin is `needs-setup` with one `secret-missing` problem per key. Saving the secret (`PUT /host/plugins/<name>/secrets/<key>`) makes them available at once, and removing it makes them refuse again, with no restart. Because the check is per call, read the secret inside `execute`, not once in `setup`. The only contributions the gate does not cover are providers and MCP apps, which the host handles itself. No listing, response or log line contains a secret's value.

`setup`'s `storage` is confined to the key prefix `plugin:<name>:`, so a plugin cannot read another's records.

## Do work after Bureau starts

`afterStart` runs once, after Bureau has been built, with the host API and the same context `setup` received, `secrets` and `storage` included. It runs even when a secret is missing. A rejection marks the plugin with an `after-start-failed` problem and leaves its contributions registered.

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

`afterStart` runs on every start, so record that you did the work (here, in `storage`) and check before repeating it. A contributed tool that needs the host API reads it from the setup context's `host`; a call made from `setup` itself, before the host has started, rejects.

## Problems and statuses

`GET /host/plugins` reports each plugin with a status (`running`, `needs-setup`, `disabled` or `skipped`) and its problems. Settings › Plugins shows the same.

| Code | Status | Meaning and fields |
| --- | --- | --- |
| `secret-missing` | `needs-setup` | A declared secret is not set. `key`, `contributions` (the ids that wait). |
| `configuration-invalid` | `skipped` | The configuration does not parse. `field`, `message`. |
| `reference-unresolved` | `running` | A shipped file names a contribution nothing holds. `file`, `id`. |
| `name-clash` | `skipped` | A name is already held; the first loaded wins. `name`, `first`, `second` (each `{ source, location }`). |
| `pinned-version-unavailable` | `running` | Work recorded a version that is not loaded. `id`, `version`, `waitingRuns`. |
| `setup-failed` | `skipped` | `setup` threw, or returned something that cannot be registered. `message`. |
| `after-start-failed` | `running` | `afterStart` threw. `message`. |
| `mcp-app-failed` | `running` | An app's entry did not build. `app`, `message`. |
| `secret-refused` | `skipped` | The host cannot honor a declared secret. `key`, `message`. |
| `load-failed` | not listed | A folder's code could not load, such as an import nothing provides. `message`. The folder appears in the `unloaded` array. |
| `development-source` | as its own | Loaded with `--plugin`. `path`. |

The host starts whatever a plugin does. A message never contains a secret value.

## Restarts

Plugin code loads once, so changing a plugin's `enabled` flag or its configuration (`PUT /host/plugins/<name>`) is stored at once and applies on the next start; the answer says `restartRequired`. A secret needs no restart. `POST /host/restart` answers 202, shuts the host down and exits with code 75, which the supervisor behind `bun run dev` answers by starting a fresh process. Under `bun --watch`, an edit to a `--plugin` folder's `plugin.ts` does the same. The shipped files reload without any of this.

## Test a plugin

`@lostgradient/interborough-plugin/testing` holds `pluginContract`, the conformance suite every plugin runs. It takes the host as an argument, so this package never imports Bureau; Bureau's `@lostgradient/bureau/testing` supplies `createPluginTestHost`, a Bureau that loads only your plugin with a value for every secret it declares and the files in your `content/` directory.

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

The suite registers one test per check. The descriptor must be valid, the identities it holds must read without a host and never repeat, and the host must report the plugin `running` with no problems, which includes every file it ships resolving the contributions it names. `checkPluginContract` runs the same checks and returns the failures instead of registering tests.

For the host's side of all this, the routes and the Settings screen, see the Plugins section of [the Interborough README](../../applications/interborough/README.md).
