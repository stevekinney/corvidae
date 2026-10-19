# Interborough

Interborough is Corvidae's main application. One process on one loopback origin serves the browser application, Weft's engine API for the Engine console, and a Bureau, with no sign-in. It is a private application: nothing here is published.

The browser application is the Weft operator console, moved here from `packages/weft/src/ui` (Weft no longer exports `./ui`, `dashboard()`, or a UI of any kind), with a new shell around it. The Weft console's coverage of Weft's operations is recorded in [`documentation/weft-console/coverage-matrix.md`](documentation/weft-console/coverage-matrix.md).

## Running it

Run every command from the repository root.

```bash
bun run --filter=@lostgradient/interborough dev
bun run --filter=@lostgradient/interborough build
bun run --filter=@lostgradient/interborough test
bun run --filter=@lostgradient/interborough test:slow
bun run --filter=@lostgradient/interborough test:browser
bun run --filter=@lostgradient/interborough test:coverage
bun run --filter=@lostgradient/interborough lint
bun run --filter=@lostgradient/interborough typecheck
```

- `dev` builds the browser application into `build/`, starts the host on `http://127.0.0.1:7234`, and rebuilds when the source changes. `INTERBOROUGH_PORT` picks another port, and `0` asks for a free one.
- `build` writes the production build into `build/`: `index.html` and content-hashed JavaScript, CSS, and WebAssembly under `build/assets/`. The host serves that directory. A build replaces `build/` only once it succeeds.
- `test` runs the host's suite under `bunfig.toml`, then the browser application's under `bunfig.ui.toml`, whose preload installs happy-dom, the Svelte compile plugin from `@lostgradient/testing`, and the jest-dom matchers. The browser suite stays serial: under `--parallel`, Bun 1.4.2's workers load the default `bunfig.toml` preload on top of the one `--config` names. The tests in a `*.slow.test.ts` file bundle for seconds, so `test:slow` runs them.
- `test:browser` runs the Playwright suite in `tests/e2e` against a host it starts on port 7399 with the console's fixtures registered. The barrier's control listens on the next port. Set `INTERBOROUGH_E2E_PORT` to run the suite beside another checkout's, which holds 7399.
- `test:coverage` runs the browser suite under coverage and compares each area with the floor in `scripts/coverage-baseline.ts`.

## The host

`src/host/host.ts` starts everything:

- **State** lives in Bungalow's directory, `~/.interborough` or `INTERBOROUGH_HOME`. The Bureau runs on Bun SQLite at Bungalow's database path with `BureauOptions.id` set to Bungalow's `deploymentId`, so a restart keeps its tasks, sessions, schedules, and goals. The host takes Bungalow's single-instance lock, so a second host on the same directory refuses to start.
- **One caller.** There is no sign-in, and the host binds `127.0.0.1` only. Every request acts as `anonymous:local`, which holds every Weft scope and every Bureau scope. `weft.system.principal` reports that subject, and the shell names it in its top bar.
- **Routes** on the public origin:
  - `/api/*`, `/v1/*`, `/jsonrpc`, `/mcp`, and Weft's discovery documents are Weft's engine operations.
  - `/bureau/*` is `createBureauHandler` with the prefix removed, and `agUi: {}` mounts its AG-UI adapter at `/bureau/ag-ui`, which Chat talks to. It does not share Weft's root because both catalogs claim `/jsonrpc` and `/v1/…`.
  - `/assets/*` and every route in `src/app/routes.ts` serve the build.
- **Why there are two listeners.** Weft's server reports its own shared `unauthenticated-local` caller for a request with no credential. To make both halves of the application name `anonymous:local`, Weft's server listens on a private loopback port that answers only a per-process key, and the public listener relays to it (`src/host/engine-proxy.ts`), attaching the key and dropping any credential the caller sent.
- **One engine.** The Engine console serves the Bureau's own durable engine (`bureau.durableEngine()`), so a cancel from the console is fenced by the engine that owns the run and the live feed sees the Bureau's runs. Only the end-to-end fixtures replace it, through `createConsoleEngine`, because they register workflows of their own.
- **Seeded agents call no model.** Every seeded agent answers from `createScriptedGenerate`, whatever providers are configured. See `src/host/seed.ts`: `assistant`, `tool-runner` (a read-only tool and a mutating tool held for approval), `request-human-input` (free text, no schema), and `internal`, which the host does not publish, plus one schedule and one goal. `tool-runner` answers from where the turn has got to, so the run that follows an approval reports what the refund came to, and each turn's calls carry the turn's number. Seeding creates the schedule and the goal once. `HostOptions.extraAgents` adds agents and their published names without changing the seed, which is how the end-to-end suite brings an agent that waits on a barrier. The Bureau's own default generate is scripted too. Real models come in through the catalog below.

The only module that reads the environment is `src/host/environment-configuration.ts`.

## Model providers

The Bureau's model catalog holds the models of the providers you configure, and only those. With nothing configured the host starts, the catalog is empty, and the seeded agents run as always. The host reads no environment variable for a key.

Configure providers in `configuration.json` in the state directory, `~/.interborough/configuration.json` or `$INTERBOROUGH_HOME/configuration.json`. A missing file means no providers.

```json
{
  "providers": {
    "anthropic": {},
    "openai": { "models": ["gpt-4.1", "o3"] }
  }
}
```

- The provider keys are exactly `anthropic`, `openai`, and `gemini`. Any other key under `providers` fails startup with an error that names the file and the field, for example `providers.voyage`. Embedding-only providers (`voyage`, `ollama`) are not generative backends. Keys outside `providers` are ignored, and a field other than `models` inside a provider fails startup.
- `models` is an optional allowlist. Each entry names a model or one of its aliases, such as `claude-sonnet-5` or `sonnet`. Leave it out to offer every current model of the provider. An empty list, or an entry that matches no current model of that provider, fails startup and names the field, for example `providers.openai.models[1]`. Retired models are never offered.
- Each provider's API key is a Bungalow secret: `anthropic-api-key`, `openai-api-key`, and `gemini-api-key`, one file each in `secrets/` (mode `0600`). Surrounding whitespace is trimmed. A configured provider with no key is left out of the catalog, and the host logs one warning that names the provider and the secret it expects, never a value.

```bash
mkdir -p ~/.interborough/secrets
printf '%s' "$YOUR_KEY" > ~/.interborough/secrets/anthropic-api-key
chmod 600 ~/.interborough/secrets/anthropic-api-key
```

The host installs the catalog rows through `replaceCatalog` before it creates the Bureau, and the Bureau's refresh source returns the same rows, so `bureau.modelCatalog.refresh()` cannot bring an unconfigured provider back. `host.generateFor({ provider, model })` is the generate for an agent assigned a catalog model: it resolves through Bureau's `resolveProviderGenerate` with the provider's key, and refuses a model the catalog does not hold. A change to the configuration or a secret takes effect when the host restarts.

## Agent files

Agents can be Markdown files in `agents/` under the state directory, `~/.interborough/agents/` or `$INTERBOROUGH_HOME/agents/`. The host creates the directory and passes it to the Bureau as `agentDirectory`, so a file `researcher.md` is the agent `researcher` and a change to the directory takes effect without a restart.

```md
---
name: Researcher
description: Finds and cites sources
model: anthropic/sonnet
tools: [lookup-order]
---

You are a careful researcher.
```

- `model` is `<provider>/<model-or-alias>` and must be a row of the model catalog above, so it needs a configured provider with a key. The agent runs with that key through `host.generateFor`. A model that is not in the catalog leaves the file `invalid`.
- `tools` names tools from the host's tool catalog, which holds the read-only `lookup-order` tool. Anything else leaves the file `invalid`.
- A file that cannot be used stays in `bureau.agents.list()` with `state: 'invalid'` and a typed `problem`, and never runs. A file cannot take the name of a seeded agent.
- Every file agent belongs to the local owner, `anonymous:local`.

The host does not publish file agents through the Bureau handler yet; that comes with the network operations. See the Bureau's `documentation/agent-files.md` for the format.

### The agent editor

`/agents/new` creates an agent and `/agents/:id/edit` edits, publishes, withdraws, and deletes one, through the Bureau's `bureau.agents.definitions.*` and `bureau.agents.catalog` operations (`src/lib/agent-definitions.ts`). The page lives in `src/routes/agent-editor` and renders in its own view, `agent-editor`, whose states are loading, error, forbidden, and not found.

- **The fields** are name, identifier, description, model, tools, and the instructions body. The model and tool lists are exactly what `bureau.agents.catalog` returns, so with no provider configured the model list is empty and Save is disabled. `skills` has no field: a save sends the loaded `skills` back unchanged.
- **The identifier** is the file name without `.md`. On `/agents/new` it fills in from the name as a slug and can be edited until the first save, and after that it is read-only. A taken identifier, whether another file or an agent defined in code, shows on the field and writes nothing.
- **Publishing** has its own control. It calls `publish` or `withdraw` with the `hash` of the file the form was filled from, and `published` never travels with a save.
- **Conflicts.** Every write names that `hash`. A file that changed on disk since is refused as `StaleRevision`, and the page says the agent changed outside Interborough, with a reload that discards unsaved edits. A file that was deleted on disk is the not-found state, and so is an identifier that names no agent or an agent defined in code. A file the Bureau cannot use opens the editor in an error state with its problem and its path.
- **The file path** comes from the host's `/host/paths`, which names the agent directory. The revision history under the form lists the versions that have run, each by its short hash and last-run time, most recently run first. A save alone does not add a row.
- **Entry points.** The agent list has a New agent action, and an agent's page has an Edit action when the agent is a file; an agent defined in code has no Edit, because the editor would not find it. The list also shows each invalid agent file, with its error, its path, and a link to its editor, because `bureau.agents.list` leaves invalid files out and the list reads `bureau.agents.definitions.list` for them. A deleted agent leaves the list.
- **The identifier `new`** is refused, because `/agents/new` is the page that creates an agent and an agent called `new` could never be opened.
- **After a write** a save lands on `/agents/:id`, and a delete lands on `/agents`.

The Playwright suite gives its host a provider configuration and a fixture key in the temporary home, and a fake provider client, so its catalog holds `anthropic/claude-sonnet-5` and `anthropic/claude-haiku-4-5`, and saving, conflicts, history, and deletion run against the real Bureau (`tests/e2e/e2e-server.ts`, `src/host/fake-provider.test-support.ts`).

## Workflow files

Workflows are JSON files in `workflows/` under the same directory, `~/.interborough/workflows/` or `$INTERBOROUGH_HOME/workflows/`. The host creates the directory and passes it to the Bureau as `workflowDirectory`, so a file `nightly-digest.json` is the workflow `nightly-digest`: it runs on the schedule its `trigger` names, its `agent` steps run any agent above, and a change to the directory takes effect without a restart. Every workflow belongs to the one local owner. See the Bureau's `documentation/workflow-files.md` for the format.

## The shell

The sidebar is Cinder's `SideNavigationGroup` twice: a Primary group (Chat, Agents, Workflows, Runs, Schedules, Inbox) and an Engine group (Workers, Storage, System, Audit). Chat is the home screen, sessions live at `/chat/:sessionId`, and runs live at `/runs` and `/runs/:id`. `/workflows` is the catalog of workflow definitions, which a later issue builds, so it renders a placeholder, as does `/audit`.

Every view renders in a frame (`src/app/view-frame.svelte`) that is loading, empty, failing (Cinder's `ErrorState`, with a retry), forbidden, not found (for a view that opens one item by its address), or showing its content, and says which in `data-state` beside a `data-view` naming the view. Its words are in `src/app/copy.ts`, and its one request is in `src/app/view-probes.ts`.

## Chat and agents

- `/` opens the session updated most recently (`src/routes/chat/chat-home.ts`), or `/chat` when there is none. The route's `redirect` replaces its own history entry.
- `/chat` lists the caller's sessions with `ChatConversationList`, newest first, with Load more paging and a New chat action. `src/routes/chat/session-summary.ts` maps a Bureau context to a row.
- `/chat/new?agent=:id` starts a session. The agent is a searchable `Combobox` above the composer, starting from `?agent=` or the default agent (`src/lib/default-agent.ts`, `assistant`); changing it replaces `?agent=`. The client names the thread, the first message starts the run, and when it has started the address becomes `/chat/:sessionId` by replacing the history entry, with the page kept mounted (`router.navigate`'s `keep`). `/chat/new` is registered before `/chat/:sessionId`. A first run that is refused stays on `/chat/new` with the row failed and a retry.
- `/agents` lists the agents the Bureau tells the caller of (`bureau.agents.list`: `kind`, publish state), with New chat for a published one. `/agents/:id` shows one agent's details (a file agent's model, tools and skills from `bureau.agents.definitions.get`), a New chat action when it is published, and the chats had with it.
- A session or agent the caller cannot see, or an unknown or unpublished agent for a new chat, is `not-found`.

### The conversation

`/chat/:sessionId` (`src/routes/chat/`) is `@lostgradient/chat` over the Bureau's AG-UI mount. A session is a Bureau context, and its conversation id is the AG-UI thread id. `chat-session.svelte.ts` holds one session's state and its `createChatSessionController`; `run-wiring.ts` is the transport. A turn is a start (`POST /bureau/ag-ui/agents/<agent>/run`, read through `@ag-ui/client`), a resume that carries the user's decision on a tool approval together with the turn that opened the run (never a follow-up row), or an attach (`GET /bureau/ag-ui/threads/<thread>/run`) to a run the page did not start, which restores the transcript from the stream's snapshot. A message typed while the run is going is a follow-up: the controller sends it through `bureau.contexts.input` under the id of its own row. Pending tool approvals are one warning alert above the transcript with Deny and Approve. A session the caller cannot see is `not-found`.

A finished session's transcript is read back from the mount (`GET /bureau/ag-ui/threads/<thread>/messages`, owner-scoped like the attach route), so reopening a session, by reload or by returning to it from the list, shows every turn in order.

## Runtime configuration

`readRuntimeConfig` reads the `weft-ui-config` JSON element from the host document. A missing or empty element defaults to same-origin requests and automatic transport. Invalid JSON or an invalid configuration shape throws.

```html
<script type="application/json" id="weft-ui-config">
  { "baseUrl": "", "eventTransport": "auto" }
</script>
```

| Field | Meaning |
| --- | --- |
| `baseUrl` | Required string. An empty string uses the page origin, a root-relative path selects an API prefix, and an absolute URL selects another origin. |
| `eventTransport` | Optional `auto`, `websocket`, or `sse`; defaults to `auto`. |
| `token` | Optional bearer token held in the client's memory. |
| `headers` | Optional string-valued request headers. An explicit authorization header takes precedence over `token`. |
| `assetBase` | Validated configuration data for host asset handling. The client does not use it to rewrite asset URLs. |

Dynamic-source diagnostics belong to the engine process answering the request. Durable catalog installation and process-local load history have different lifetimes, so a console pinned to a stable engine endpoint reads one process's loading state.

The interface enables controls according to the principal's scopes. The Weft server remains responsible for authorizing each operation; a disabled control is not an authorization boundary.

## Layout

- `src/host`: the host, its relay, its seeds, and `dev.ts`.
- `src/app`: the shell, the router's route table, the view frame, and the sidebar.
- `src/lib`, `src/routes`, `src/views`, `src/styles`: the console's client, query helpers, live sources, router, area routes, and styles.
- `fixtures`: the deterministic demo workflows the console's tests and Playwright suite run against. They are append-only.
- `tests`: the DOM preload, the deployment-mode tests, and the Playwright suite in `tests/e2e`.
- `scripts`: the build and the coverage ratchet.
