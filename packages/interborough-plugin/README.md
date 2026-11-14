# @lostgradient/interborough-plugin

The authoring package for Interborough plugins. A plugin is trusted, in-process code that the host loads once at startup; this package gives it `definePlugin`, the descriptor it declares, the context `setup` receives, the host API `start` receives, and the types of everything it can contribute. Bureau depends on this package and never the other way around, so a plugin imports nothing from Bureau.

| Export | What it is |
| --- | --- |
| `definePlugin` | Declares a plugin and refuses a malformed descriptor where it is written. |
| `PluginDescriptor` | `name`, `version`, `description`, `required`, `enabled`, `configuration`, `secrets`, `content`, and `setup`. |
| `PluginSetupContext` | The parsed `configuration`, the `secrets` reader, `storage` confined to the key prefix `plugin:<name>:`, the `host` API, and `approvals`, the host's tool-approval rule as a `policy` for a toolbox the plugin builds for a code agent. |
| `PluginSetupResult` | What `setup` returns: the contributions, and `start(bureau, context)`. |
| `PluginHost` | The structural slice of Bureau `start` receives: `agents.list`, `schedules.list`, `schedules.create`, `goals.create`. |
| `PluginContributions` | Tools, activities, code workflows, validators, guardrails, interceptors, triggers, reactions, providers (each with its catalog rows), embedders, scorers, panels, formatters, and agents. |
| `createPluginStorage` | Scopes a `Storage` to a plugin's key prefix. The host calls it; a plugin receives the result. |

## Where a plugin lives

A plugin is a module whose default export is `definePlugin(...)`. There are two homes for one, and the code is the same in both.

- **A workspace package** under `plugins/<name>`. Its `package.json` `exports["."]` points at the module (`./src/plugin.ts`), the host lists it in `applications/interborough/src/host/plugins.ts`, and it commits a `plugin-identities.json`. Its `dependencies` may name this package, the libraries a contribution is built from and external packages; `@lostgradient/bureau` and the `testing/*` workspaces belong in `devDependencies` only (`scripts/plugin-dependency-rules.ts`).
- **A folder** in Bungalow's `plugins/` directory (`<bungalow>/plugins/<name>/plugin.ts`), which needs no install and no workspace. The next sections use a folder because that is what the scaffold writes.

Workspace plugins load first, in the order the host lists them, and folder plugins after them by folder name. The first plugin to claim a name keeps it; a later one is skipped with `name-clash`.

Plugin code is trusted and runs in the host's process. It loads once, when the host starts. There is no sandbox and no hot reload of code; the files a plugin ships (below) are the one thing that reloads while the host runs. Deployment operators choose executable plugins; workspace administrators cannot install arbitrary code. A configured integration uses the workspace's external account and existing agent grants, so that account's third-party data is not partitioned per Interborough user. Invocation state, chats, and memory remain owner-private within Interborough unless explicitly shared.

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
- `enabled`: whether the plugin runs before the owner has chosen. It defaults to `true`; the demo plugin sets `false`.
- `configuration`: a Zod schema. The owner's value for it is parsed before `setup` runs.
- `secrets`: the Bungalow secret keys the plugin needs.
- `content`: the directory of agent, workflow and skill files the plugin ships.
- `setup`: builds the contributions once at startup and may return `start`.

## What a plugin can contribute

`setup` returns an object whose members are all optional, so a plugin names only the kinds it contributes.

| Member | What it adds |
| --- | --- |
| `tools` | Tools agents can call. |
| `activities` | Activities a shipped workflow calls as `plugin:name`; each needs a `title` and an `inputSchema`. |
| `workflows` | Workflows defined in code (`PluginWorkflow`), registered as `plugin:name` beside the workflow files. See [Code workflows](#code-workflows). |
| `validators` | Goal validators, registered by name and version. |
| `guardrails` | `input` detectors and `output` validators, added to the ones Operative applies to every agent, `tools` validators that judge each tool call before it runs (COR-2104), and `memory` detectors that guard governed memory (each may declare `gates`: `admission`, `recall`, or both by default). An `input` or `output` entry may be `{ guardrail, action }` to keep an action of its own whatever its group's, and a `tools` validator carries its own `action` (`block`, `warn` or `tripwire`). An agent file chooses an `input`, `output` or `tools` guardrail with `guardrails: [plugin:name]`. Every guardrail has a non-empty `description`. An `input`, `output` or `tools` guardrail may instead be a `PluginGuardrailFactory` (COR-2118): `{ name, description, configuration, create }`, where `configuration` is the Zod schema an agent's configuration is parsed with and `create` builds the guardrail from the parsed value. An agent file configures it as `{ id: plugin:name, configuration }` (a bare id is configured with `{}`), each agent gets its own guardrail, and a field the agent leaves out takes the schema's default, so a plugin-wide setting belongs in the schema as that field's `.default(...)`. A factory wrapped as `{ guardrail: factory, action }` gives every guardrail it builds that action. |
| `interceptors` | Run hooks, at any of Operative's hook points, that an agent file chooses with `interceptors: [plugin:name]`; they apply to the agents that select them, or to every agent with `appliesTo: 'every-agent'`. |
| `triggers` | New external sources that start work. |
| `reactions` | New things a hook can do when its event happens. |
| `providers` | Model providers, each with the catalog rows of its models (a row with `decisions: { kinds, only: true }` answers those decision kinds natively through the provider's `decide` and runs no agent, as the `typesafe` plugin's does) and, optionally, the `secretKey` of the declared secret that holds its API key (see [Provider keys](#provider-keys)). |
| `embedders` | Embedders the `memory.embedder` setting can name. |
| `scorers` | Scorers that score a sample of completed runs. |
| `panels` | Interface panels. |
| `formatters` | Titles and bodies for the activity views. |
| `agents` | Agents defined in code. Each may carry a `title` (its listing's label), a `visibility` (`'chat'` by default; `'hidden'` keeps it in `bureau.agents.list`, which marks it `visibility: "hidden"`, and Chat does not offer it, while workflows, children and a direct start still run it by `plugin:name`) and a `version` (a run pins it in place of the plugin's version; a run recovered under a different one settles failed with `definition-drifted`). |

### Code workflows

A `PluginWorkflow` is a Weft workflow built in code (`workflow({ name }).execute(...)`) with three more members: a required `title` (what the workflow list calls it), a required `inputSchema` (the schema a start's input must satisfy) and an optional `version`. A workflow without a `title` or an `inputSchema` skips the plugin with a `workflow-field-missing` problem.

- **Id and listing.** The host registers it as `plugin:name`, and `bureau.workflows.list` and the `workflows-list` tool list it beside the workflow files as an entry with `kind: 'code'`, its name, title, plugin and version. A code entry has no hash, state, pause or trigger; a file entry is unchanged. A workflow of a plugin that needs setup is listed and refuses to start.
- **Starting.** A run starts on the same envelope a workflow file's run does (`{ kind, input, origin, workspaceAuthority? }`), after Bureau checks `inputSchema` against the envelope's `input`. Its runs read back through the run operations in their ordinary shape.
- **The pin.** A run pins the workflow's own `version`, or else the plugin's version, and that is the version the engine registers it at. A plugin that is disabled takes its workflow with it: the workflow is not listed, a start is refused, and a run of it reports `missing` and stays resumable when the plugin returns, never on another version. A waiting run pinned to a version that is not loaded counts in `pinned-version-unavailable`'s `waitingRuns`.
- **Clashes.** A code workflow and a workflow file of one plugin with one name is a startup error from `createBureau` naming both. A file that starts to clash on a later rescan keeps its per-file `invalid` diagnostic, and the code workflow keeps running. A code workflow whose name a code workflow of the host already holds skips the plugin with `name-clash`; the first loaded wins.
- **Identity.** Its identity kind is `workflow`, with the id `plugin:name`, the workflow's version and a digest of its input and output schemas, as for an activity.
- **Calling it from a workflow file.** A file's `{ "kind": "workflow", "workflow": "plugin:name", "input": ... }` step starts it as a child on the same envelope, with the step's `input` and the calling instance's origin and workspace authority, and continues with its result. The revision pins the version that is loaded, so an instance parked across an upgrade is cancelled with `version-mismatch` (or `missing`) and never resumed on another version. See [Calling a code workflow](../bureau/documentation/workflow-files.md#calling-a-code-workflow). An activity a file calls may not define `compensate`.

```ts
import { definePlugin } from '@lostgradient/interborough-plugin';
import { workflow } from '@lostgradient/weft';
import { z } from 'zod';

const echo = workflow({ name: 'echo-input' }).execute(async function* (
  _context,
  envelope: unknown,
) {
  yield* [];
  return envelope;
});

export default definePlugin({
  name: 'example',
  version: '1.0.0',
  description: 'Contributes one code workflow.',
  setup: () => ({
    workflows: [
      { ...echo, title: 'Echo the input', inputSchema: z.object({ message: z.string() }) },
    ],
  }),
});
```

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
        title: 'Look something up',
        inputSchema: z.object({ query: z.string() }),
        execute: async (argument: { input: unknown }) => ({ found: argument.input }),
      },
    ],
    triggers: [
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
    reactions: [
      {
        name: 'notify',
        version: '1',
        description: 'Posts the event somewhere, once per delivery.',
        configuration: z.object({ channel: z.string() }),
        async run({ event, idempotencyKey, signal }) {
          signal.throwIfAborted();
          console.log(idempotencyKey, event.kind);
        },
      },
    ],
    formatters: [
      {
        name: 'completed',
        eventKinds: ['run.settled'],
        format: (event) => ({ title: `A run settled on ${event.bureauId}` }),
      },
    ],
  }),
});
```

A reaction must be safe to run twice: pass `idempotencyKey` to the service it calls, so an attempt repeated after a restart does not repeat the effect. Set the reaction's own `version`. A delivery pins the version of the reaction it was created against, and the pin defaults to the plugin's `version`, so without one every plugin release fails each delivery still pending (`version-mismatch`) instead of running it. A stored hook action, `{ type: 'plugin', plugin, kind }`, names the reaction by plugin and name, so it keeps delivering through the `reactions` contribution.

An interceptor has a member for each point of Operative's hook map (`onRunError`, `validateToolResult` and `selectTools` among them), and a point is written as the function or as `{ handler, replay, onError, priority }`. `replay: 'safe'` marks a hook with no external side effect, so a recovered durable run knows it can run again; a hook that says nothing is `effectful`. `onError` returns `'continue'` to go on to the next hook when this one throws, or `'abort'` to fail the step, which is also what a hook with no `onError` does. A `priority` sorts a higher number first, within a range of at most 999: a number below the one just above Operative's guardrails is raised to it, so a plugin never sorts behind them, and a number above 999 is lowered to it, because the host adds a tier's band to a priority and bands are 1000 apart, so a higher one would sort the plugin's hook ahead of the host's own invariants. The observing points (`onLLMInput`, `onLLMOutput`, `onRunComplete`, `onRunError`, `onRunAbort`) and `onError` are settled by Operative whatever `onError` says. While the plugin needs setup (a declared secret is missing), every hook of every interceptor refuses to run its handler.

An interceptor that declares `appliesTo: 'every-agent'` runs for every run the host starts (file agents, code agents, dispatched agents and their children) without any agent file listing it. The host composes it in a `plugin` tier between its own hooks and the agent's, so its entries show `tier: 'plugin'` in a run's hook plan. An agent file that also lists it gets it once, in its own tier, as an interceptor it chose. While its plugin needs setup, such an interceptor refuses for an agent that lists it, as any chosen interceptor does, and is skipped for every other agent: its handlers do not run, and the run goes on as if it were absent, so a missing secret never fails an agent that did not choose it.

The demo plugin's `audit` set (`plugins/demo/src/audit.ts`) is the worked example. It applies to every agent, because the demo's agents are code agents, which no agent file can list, and it has one `onStep` hook that writes what each step spent and which tool calls it made (their ids and the tools they named) to the plugin's own storage, keyed by the run and the step. The key is the point of the example: a hook declared `replay: 'effectful'` runs again when a durable run recovers a step, so an entry keyed by `run:<runId>:step:<n>` is overwritten by the replay instead of repeated. `runId` is on every `StepResult`, including a step that only called tools and committed no row, so it is the key to read, not a message id. A step with no `runId` (a run the host started with none) has no key, so the hook writes nothing for it.

```ts
import { definePlugin, type PluginInterceptor } from '@lostgradient/interborough-plugin';
import { textValueStore, type Storage } from '@lostgradient/storage';

/** The key one step's entry is stored under: the same for a step and its replay. */
function auditStepKey(runId: string, step: number): string {
  return `run:${runId}:step:${step}`;
}

/** The `audit` set over the plugin's own storage. */
function auditInterceptor(storage: Storage): PluginInterceptor {
  const entries = textValueStore(storage, { disposeUnderlyingStorage: false });
  return {
    name: 'audit',
    appliesTo: 'every-agent',
    onStep: {
      replay: 'effectful',
      handler: async (result) => {
        if (result.runId === undefined) return;
        const entry = {
          step: result.step,
          usage: result.usage ?? null,
          toolCallIds: result.toolCalls.map((call) => call.id),
          toolNames: result.toolCalls.map((call) => call.name),
        };
        await entries.set(auditStepKey(result.runId, result.step), JSON.stringify(entry));
      },
    },
  };
}

export default definePlugin({
  name: 'audit-example',
  version: '1.0.0',
  description: 'Records what each step of every run spent and which tools it called.',
  setup: ({ storage }) => ({ interceptors: [auditInterceptor(storage)] }),
});
```

An interface panel is a page the host bundles from a browser entry at startup and serves as a `ui://` resource, under a content security policy that denies every origin and permission. A panel may call only the tools in `allowedTools`, and `opensFromTool` is the one of them a client runs to open it. The tool must be unique across plugins, because a tool links to one page: a second app that opens from the same tool is skipped with `name-clash`. Put the version in the `uri`, so a changed contract is a new resource.

```ts
import { definePlugin, type PluginPanel } from '@lostgradient/interborough-plugin';

const runInspector: PluginPanel = {
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
  setup: () => ({ panels: [runInspector] }),
});
```

An entry that does not build leaves the plugin `running` with a `panel-failed` problem, and the other contributions keep working.

## Identities: files float, records pin

Every contribution has an id, `plugin:name`, and a name matches `^[a-z](?:[a-z0-9-]*[a-z0-9])?$` in the plugin and in each contribution. A tool's id carries its version, `plugin:name@version`.

- **Files float.** An agent or workflow file names a contribution as `plugin:name` with no version and uses whichever version is loaded. A skill or an allow or deny list matches the unversioned id.
- **Records pin.** A durable record (a run's tool calls, a goal's validator, a workflow revision's activities, a hook delivery) stores `plugin:name@version` and resolves only that version. If the version is not loaded, the record reports `missing` or `version-mismatch`, never another version, and the plugin gets a `pinned-version-unavailable` problem. A waiting run pinned to it is not resumed on another version.
- **Which version.** A contribution's own `version` when it declares one, otherwise the plugin's. A tool without a version registers with its plugin's: a plugin at `2.0.0` contributing the tool `t` registers `p:t@2.0.0`.
- **What the model sees.** The provider-facing tool name is `plugin__tool`, because providers restrict the characters in a tool name. You write `plugin:tool` everywhere else.

So the rule for changing a plugin is: bump the version whenever a contribution's schema changes, because something durable may be holding the old one.

An event a plugin causes through its host API (a schedule or a goal it creates) carries `source: '<plugin>'`; an event from Bureau core carries none.

## Commit the plugin's identities

Each `plugins/*` workspace commits a `plugin-identities.json` with its configuration and every contribution's id, version and a digest of its schema. A provider's digest covers its version (`PluginProvider.version`, the plugin's without one) and, for each of its catalog rows that declares `decisions`, the row's native decision kinds and whether it only decides, so a change to either fails the guard. Write or refresh it from the repository root:

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

A running plugin's agents and workflows are listed as `plugin:name`, and a plugin that is disabled or skipped ships nothing. The one exception is a disabled plugin's code agents: the host runs its `setup` once, with scratch storage, no secrets and no host API, keeps only `agents`, and lists each as `unavailable` with the reason `Plugin <title> is disabled`, so a person can read it and duplicate it but no run starts on it. Nothing else the plugin returns is registered, and `start` never runs, so keep `setup` free of side effects. Files reload while the host runs, but they are read-only: the host refuses to write or delete a definition a plugin holds, and says to duplicate it. Duplicate writes an editable copy into the owner's directory, and an owner file's stem has no `:`, so a copy can never claim a plugin's namespace. A workflow file calls a plugin activity as `plugin:name`, with no version.

A file that names a contribution nothing loaded holds (a tool you misspelled, a plugin that is disabled) is invalid with a `reference-unresolved` problem naming the file and the id. The plugin stays `running`.

## Configuration and secrets

The owner's choices persist under `plugins.<name>` in Bungalow's `configuration.json`, as `{ "enabled": true, "configuration": { ... } }`, and `setup` receives only that entry's `configuration`, parsed by your schema. A value the schema refuses skips the plugin with a `configuration-invalid` problem naming the field, and the host still starts. Give every field a default so the plugin works with no entry at all.

A secret is declared by its full Bungalow key, or as `{ key, generated: true }`, which asks the host to create a random value the first time the plugin is enabled. The default remote environment provider is read-only, so a generated secret there must be supplied by the deployment. Trusted composition may inject a writable workspace secret provider and enable revision-checked configuration writes; no production cloud-secret vendor adapter is included. A key the host keeps for itself is refused with `secret-refused`. Read a secret inside the contribution, when you need it:

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

A plugin whose declared secret is missing still loads. Every contribution it registered is available but refuses to run, and the plugin is `needs-setup` with one `secret-missing` problem per key. Saving the secret (`PUT /host/plugins/<name>/secrets/<key>`) makes them available at once, and removing it makes them refuse again, with no restart. Because the check is per call, read the secret inside `execute`, not once in `setup`. The only contributions the gate does not cover are providers and panels, which the host handles itself. No listing, response or log line contains a secret's value.

### Provider keys

A provider's API key is one of the plugin's declared secrets. Name it with the provider's optional `secretKey`, which must be a key the plugin declares:

```ts
secrets: ['tracker-signing-key', 'acme-api-key'],
setup: () => ({ providers: [{ ...acmeProvider, secretKey: 'acme-api-key' }] }),
```

Without `secretKey`, a plugin that declares exactly one secret uses it as the key, and a plugin that declares several is refused with `provider-secret-ambiguous`, because the order of the declarations is never read as a choice. A `secretKey` the plugin does not declare is refused with `provider-secret-unknown`. A plugin that declares no secret has a keyless provider, such as a local Ollama or LM Studio server: its models are available whenever the plugin runs, and its definition is called with `apiKey` omitted.

`setup`'s `storage` is confined to the key prefix `plugin:<name>:`, so a plugin cannot read another's records.

## Do work after Bureau starts

`start` runs once, after Bureau has been built, with the host API and the same context `setup` received, `secrets` and `storage` included. It runs even when a secret is missing. A rejection marks the plugin with a `start-failed` problem and leaves its contributions registered.

```ts
import { definePlugin } from '@lostgradient/interborough-plugin';

export default definePlugin({
  name: 'digest',
  version: '1.0.0',
  description: 'Schedules a daily digest.',
  setup() {
    return {
      async start(bureau, { storage }) {
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

`start` runs on every start, so record that you did the work (here, in `storage`) and check before repeating it. A contributed tool that needs the host API reads it from the setup context's `host`; a call made from `setup` itself, before the host has started, rejects.

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
| `start-failed` | `running` | `start` threw. `message`. |
| `panel-failed` | `running` | An app's entry did not build. `app`, `message`. |
| `secret-refused` | `skipped` | The host cannot honor a declared secret. `key`, `message`. |
| `activity-field-missing` | `skipped` | An activity has no `title` or no `inputSchema`, which the workflow editor lists it by. `activity`, `field`. |
| `workflow-field-missing` | `skipped` | A code workflow has no `title` or no `inputSchema`, which the workflow list and the start check need. `workflow`, `field`. |
| `provider-secret-unknown` | `skipped` | A provider's `secretKey` is not one of the plugin's declared `secrets`. `provider`, `key`. |
| `provider-secret-ambiguous` | `skipped` | A provider has no `secretKey` and the plugin declares several secrets. `provider`, `secrets`. |
| `provider-empty` | `running` | A provider gave no `rows` under a name Operative's static catalog has no rows for, so it contributes no model. `provider`. |
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

The suite registers one test per check. The descriptor must be valid, the identities it holds must read without a host and never repeat, and the host must report the plugin `running` with no problems, which includes every file it ships resolving the contributions it names. It also runs a scripted run for each hook point an interceptor declares and fails when the declared hook throws, even when its own `onError` would have continued: the host's scripted model answers once (the `answer` run), calls a read-only tool and then answers (`tool`), or throws (`failure`), and the agent it runs chooses every interceptor the plugin declares. The points no scripted run reaches are unchecked, and the suite never runs a hook declared at one of them: `beforeCompaction`, `beforeBackgroundCompaction` and `afterCompaction` (the scripted conversation is never long enough to compact) and `onRunAbort` (the scripted run is never aborted). `PLUGIN_CONTRACT_UNCHECKED_HOOK_POINTS` lists them. For each catalog row of a provider that declares native `decisions`, it builds the row's model through the option `createDecisionModel({ provider, row, scenario? })` (which scripts or replays the answer, so nothing reaches the network, and is required when a plugin has such a row), fails when the model serves a kind its row does not declare or omits one it does, and asks it every `decisionScenarios` case of the row's kinds, failing when it does not answer as the decision-model contract in `@lostgradient/operative/decision-testing` requires (COR-2159). `checkPluginContract` runs the same checks and returns the failures instead of registering tests.

For the host's side of all this, the routes and the Settings screen, see the Plugins section of [the Interborough README](../../applications/interborough/README.md).
