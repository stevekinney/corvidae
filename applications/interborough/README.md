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
- `test:browser` runs the Playwright suite in `tests/e2e` against a host it starts on port 7399 with the console's fixtures registered. The barrier's control listens on the next port, and the two hosts described under "Schedules, goals, and the audit trail" and "The journey" on the two after it, so the suite holds four consecutive ports. Set `INTERBOROUGH_E2E_PORT` to run the suite beside another checkout's, which holds 7399. `bun run --filter=@lostgradient/interborough test:browser -- tests/e2e/90-journey.spec.ts` runs the journey alone.
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
- **One engine.** The Engine console serves the Bureau's own durable engine (`bureau.durableEngine()`), so a cancel from the console is fenced by the engine that owns the run and the live feed sees the Bureau's runs. Only the end-to-end fixtures replace it, through `createConsoleEngine`, because they register workflows of their own; the suite's second host keeps the default.
- **Seeded agents call no model.** Every seeded agent answers from `createScriptedGenerate`, whatever providers are configured. See `src/host/seed.ts`: `assistant`, `tool-runner` (a read-only tool and a mutating tool held for approval), `request-human-input` (free text, no schema), `echo` (repeats the text of the last message it was sent, so a quoted reply shows exactly what the agent received), `model-switcher` (a selectable agent over `claude-sonnet-5` and `claude-haiku-4-5`, whose reply names the model that answered; the host offers a model only when its provider is configured, so Chat shows the picker on a host that has both and none on a fresh one), and `internal`, which the host does not publish, plus one schedule and one goal. `tool-runner` answers from where the turn has got to, so the run that follows an approval reports what the refund came to, and each turn's calls carry the turn's number. Seeding creates the schedule and the goal once. `HostOptions.extraAgents` adds agents and their published names without changing the seed, which is how the end-to-end suite brings an agent that waits on a barrier. The Bureau's own default generate is scripted too. Real models come in through the catalog below.

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

## The Workflows area

`/workflows` joins two services (`src/lib/workflow-catalog.ts`): the engine's catalog, which lists every workflow type it can run (`weft.workflows.definitions.*`), and the Bureau's workflow files (`bureau.workflows.*`, `src/lib/workflow-files.ts`). The Bureau's file `digest.json` is loaded by the engine as a source named `digest`, so the two are joined on that name. Four routes share one view, `workflows`, and one component, `src/routes/workflow-definitions/index.svelte`:

- `/workflows` lists every definition and every file. A type with a Bureau file is agent-authored and carries that badge, and its owning agent when the file names one; a code-defined type carries no badge. A file the Bureau cannot use is listed with its error, its issues, and its path, and a source that failed to load shows the category of its failure. A source the engine holds that has no file is a deleted file the engine has not yet forgotten, so it is left out and the list reads the same before and after a restart.
- `/workflows/:type` shows the definition (description, input and output schemas, the signals, updates and queries it accepts, and its active revision) and the schedules that start it: the active and the paused, never a cancelled generation (`weft.schedules.list` with `workflowType`). A code-defined type shows the engine's revision panel and offers nothing to change. An agent-authored type also shows its steps, trigger, agent, and file path, and the versions that have run (`bureau.workflows.revisions`, which does not list a version that was saved and never ran, and offers no activation), and offers pause or resume, delete, edit, and send signal. An invalid file shows its problem and path, offers only delete and edit, and has no definition section; one with no `hash` offers nothing.
- `/workflows/:type/runs` is the list from `/runs`, narrowed to the type (`weft.workflows.list` with `type`). Each row links to `/runs/:id`, whose type links back.
- `/workflows/:type/edit` edits an agent-authored file's JSON in Cinder's `JsonEditor`. The text shows the file's `name`, and the update does not send it, because the Bureau's update schema rejects a key it does not know. Text that is not JSON, and a document the Bureau refuses, show the error and save nothing. An invalid file opens with its problem above the editor, so it can be fixed.

A type exists when the Bureau has its file, or when the engine has it as code. When the Bureau has no file and the engine has no definition, or has one it loaded from a source, the type is not found, so a deleted file is not found both before and after a restart. A failure of either service is a failure and never a missing type.

Every write names the `hash` of the file the page read. A file that changed on disk since is refused as `StaleRevision`: the page says the workflow changed outside Interborough, with a reload that discards unsaved edits, and changes nothing. After a pause or resume the page takes the file's new hash at once, so the next action is not stale against its own write. Send signal calls `bureau.workflows.signal` with a name, which starts as the trigger's signal name or the first one a step awaits, and an optional JSON payload, and says how many instances it started and delivered to. The file path comes from `/host/paths`, which names `workflowDirectory` beside `agentDirectory`.

The Playwright host serves its console from the fixtures' engine, not the Bureau's (see "One engine" above), so a Bureau file has no engine definition, schedule, or run there. The list, a file's page, its actions, its signal, and its editor run against the real Bureau through three seeded files (`tests/e2e/seeded-workflow-files.ts`); the definition, schedules, revisions, and runs of a type run against a fixture type, `inventory-sync-sweep`.

## Schedules, goals, and the audit trail

There is one scheduler, Weft's, and `/schedules` lists every schedule it holds. A Bureau schedule is a native Weft schedule that fires the built-in `agentRun` workflow, and an agent-authored workflow's schedule is the trigger in its file, so each row says what it starts and links to it (`src/lib/schedule-kinds.ts`, `src/routes/schedules/schedule-target.svelte`). The kind decides which service writes it:

- An **agent run** (`workflowType` `agentRun`) is the Bureau's. `bureau.schedules.pause`, `resume`, `cancel`, and `update` each name the `revision` of the schedule the page read, which Weft compares inside its serialized write, and the row links to `/agents/<agent>` from `agentName` on the Bureau's view. Its edit drawer holds the cadence, the description, and an overlap policy of `skip` or `allow`, the fields `bureau.schedules.update` takes. It is created from the create drawer's "An agent run", which takes an agent, a cadence, a description, the text each fire sends, an optional session, and an overlap policy (`bureau.schedules.create`).
- A **workflow file's schedule** is the one the Bureau lists with its own id (`bureau-workflow-schedule:<file>:<n>`) and with no agent. The Bureau decides by that id and never by the type, so a schedule the engine made for a file's type is the engine's, and the page does the same. It is paused and resumed through `bureau.workflows.pause` and `resume` with the hash of the file the page read, as the Workflows area does, and everything else about it is edited in the workflow, so it has a link to `/workflows/:type/edit` in place of Edit and Cancel. It is never created here.
- Any **other** schedule is the engine's, through `weft.schedules.*`, with the full drawer and no stale check. Its writes do not wait on the Bureau: a type that is not a workflow file's is the engine's whether or not the Bureau answered, and when the Bureau's files did not answer, a type the engine holds as code is not a file's.

The create drawer's workflow type picker offers code-defined types only. It leaves out the agent-authored types, whose schedule is the trigger in their file, and every type the Bureau's run engine registers (`RUN_ENGINE_WORKFLOW_TYPES`, read from `@lostgradient/operative/run-engine-workflow-types`: `agentRun`, `durableHeartbeatTick`, and `goalRun`), which only the Bureau starts, with the owner, agent, and validator checks a schedule made here would skip. A typed name is refused the same way, and a type added to that list is reserved with no edit here.

A write whose revision or hash is no longer current is refused and nothing is written; the page says the schedule changed since it was loaded, reads it again, and leaves the next move to the person. A schedule only the Bureau can place (a schedule of a workflow file's type that it did not list as the file's own) is of no known kind while it has not said, and nothing is written to it. `/schedules/:id` is a schedule's page and `/schedules?create=1` and `/schedules/:id?edit=1` are its drawers.

`/goals` is not in the sidebar. It lists the caller's goals (`bureau.goals.list`) with the status as the Bureau names it, creates one from an agent, a prompt, an identity, a validator named by free text, and a maximum number of attempts (`bureau.goals.create`), and cancels one that has not ended, after a confirmation and with the revision it read. The Bureau needs a bound on all the attempts together besides how many it may make, so the form also asks for the most steps, which starts at 50. A validator the Bureau lacks is `Unprocessable`, said in the drawer. The host seeds a validator that never passes (`never-passes`, version `1`), which waits until it is cancelled, so a goal that names it stays going until a cancel ends it as `canceled`.

`/audit` searches the Bureau's trail (`bureau.audit.query`) by a `since` time, a free-text `type`, and a resource sent as `runId`, which takes a run id or `schedule:<id>`, `session:<id>`, `agent:<id>`, or `workflow:<id>`. Records come oldest first, as the Bureau returns them, and Load more follows `nextCursor`. The address holds the filters. `/audit` and `/goals` hold no console scope: the Bureau shows each caller what it owns, so owner scoping is the gate and a principal holding no scope sees its own records.

The Playwright suite runs a second host (`E2E_BUREAU_PORT`, `tests/e2e/e2e-server.ts`) whose console is the Bureau's own engine, because the main host's console is the fixtures' engine and cannot see a schedule the Bureau holds. The schedules specs for an agent run and a workflow file's schedule open it, and the specs for an engine schedule open the main host.

## The journey

`tests/e2e/90-journey.spec.ts` is one Playwright journey through the application as the single local principal, with no sign-in. It is serial, with one `test()` per stage, and it runs last because of its number. Each stage builds on the ones before it:

- It chats with the `barrier` agent, sends a follow-up while the run is held, and sees the same run answer it.
- It starts from `/` and lands in the session it just made, starts a second session with the same agent from the agent's page, and returns to the first from `/chat`.
- It reloads while `request-human-input` waits on its question and answers it from `/reviews`.
- It defines an agent in the editor with the `workflows-create` tool, publishes it, and chats with it until it writes `journey-digest`, a workflow with a 5 second schedule.
- It opens the workflow from `/workflows`, waits until its schedule's fire is listed as a run, and opens that run at `/runs/:id`. A runs page that opens before the first fire says there are none, and asks again every five seconds (`recheckMs` on its view probe) until there is one, so the stage waits for the first row on the page itself.
- It follows the schedule's "Edit workflow" action from `/schedules`, changes the trigger to `1h` in the editor at `/workflows/journey-digest/edit`, and sees the one-hour cadence on `/schedules`, which also stops the 5 second fires for the rest of the run.
- It attaches an image to `echo-image`, sees `Echoed 1 image.` and the returned image decode.
- It chats with `echo-recall`, which stores the label it is sent as a memory. It sees that text on `/agents/echo-recall/memory`, corrects it, and sees a new chat answered with the correction and not the original.
- It starts a `barrier` task it never releases, reaches `/tasks/:id` from the chat's task link, cancels it, and sees `TASK_COPY.cancel['cleaned-up']`.
- It opens `/workers` from the sidebar's Engine group.

It opens a third host (`E2E_JOURNEY_PORT`, `tests/e2e/e2e-server.ts`) of its own, whose console is the Bureau's engine, as the second host's is, because the Workflows area can only show a fire of a workflow the Bureau's engine runs. The journey's host has a home of its own, with one provider so the editor can save an agent, and a barrier of its own, under `/journey` on the barrier's control port, so no run another specification leaves held changes what the journey counts. Every model is scripted and no provider key is read: the agents come in through the host's `extraAgents` (`barrier`, `echo-image`, `echo-recall`), and `createJourneyProviderResolver` (`tests/e2e/journey-agent.ts`) scripts the one agent the journey defines in the editor, so a first message that carries the journey's marker gets one call to `workflows-create` and then a fixed text, and any other first message gets the provider stub the other specifications use. The journey removes the agent and the workflow it writes, and forgets what `echo-recall` remembers, before it starts.

## Tasks

`/tasks` lists the caller's tasks (`bureau.tasks.list`), newest first, fifty to a page with Load more, and `/tasks/:id` shows one. `/tasks` is not in the navigation: a task is reached from the chat session it belongs to (the session lists its tasks, `bureau.tasks.list` with the session's `contextId`), from a run's page (which links to `/tasks/:id` only when `bureau.tasks.get` answers for the run's identifier), and from a review. The list filters by agent, status, and session through `?agent=`, `?status=`, and `?session=`. Its code is in `src/routes/tasks/` and its wire shapes in `src/lib/bureau-tasks.ts`.

- **A task's page** shows its status and status message from `bureau.tasks.get`. It shows no message history, because the management plane's task view carries no message text. Its answer comes from `bureau.tasks.events`, which is a subscription and so reaches the browser as Server-Sent Events at `/bureau/v1/subscriptions/bureau.tasks.events`: the answer is the artifact of its `task.snapshot` and `task.status` elements. The page reads the task again whenever the stream reports a change.
- **Following** (`task-follower.svelte.ts`) keeps the last position the Bureau gave. A stream that drops or fails to open is opened again with that position in `Last-Event-ID`, after the shared reconnect backoff and at once when the browser reports it is back online. A stream the Bureau ends cleanly is not a drop, and the follower tells the cases apart: after a terminal status it is the end; a session run's stream, which the Bureau ends at the subscription route's time limit, is resumed from its cursor after one second; and a task started with `bureau.run()` streams one snapshot and ends while it is still going, so each snapshot is applied to the task the page shows, the page reads it every five seconds until it is over, and one more stream then collects its answer. A position and the answer are kept in `sessionStorage` under the task, so a reloaded page resumes from there instead of starting over: a stream resumed from a position sends no snapshot, so the answer a finished task gave must be kept with it. A snapshot's position (`-1`) names nothing to resume from and is never kept.
- **A wait** is read from the review it names (`bureau.reviews.get`). A question shows its prompt and one text field, whose answer goes through `bureau.tasks.respond` under a new message identifier; a tool approval shows its reason and message, and is decided in Reviews.
- **Cancelling** calls `bureau.tasks.cancel`. Each of the eight receipts has its own words (`TASK_COPY.cancel`). A cancel is often an asking, so while the task's `cleanup` is `cancel-requested` or `cleanup-pending` the page reads the task every second, and says where the cleanup stands until it reads `cleaned-up`, `cleanup-failed`, `cleanup-unresolved`, or another state that is final.
- **Session links** (the Session column, and Open the chat on a task's page) appear only when `bureau.contexts.get` finds the session: a catalog task's `contextId` is its run handle, which no chat has. A task the Bureau removes (`task.removed`) is shown as not found.
- **The view** is `tasks` with no console scope, as for every view the Bureau serves. A refused list is forbidden, and a task the Bureau does not have (or the caller may not see, which it answers the same way) is not found.

## Reviews

`/reviews` is everything waiting on the caller. It replaced `/inbox`, with no alias. Its list merges two sources into one list and one count, the longest-waiting first:

- the Bureau's pending reviews (`bureau.reviews.list`): the tool approvals and the questions of the agents' runs; and
- the engine's pending human reviews (`client.listReviews`), read only when the principal holds `reviews:read`. The Decided and Timed out states are the engine's.

There is no Archive, because no operation lists the Bureau's resolved reviews. A Bureau row links once, to the chat when the review names a session, otherwise to its task when `bureau.tasks.get` answers for the run, otherwise to the run. A Bureau tool approval is approved, denied, or rejected through `bureau.reviews.resolve` with the reason a rejection cannot be sent without; a Bureau question is answered with one text field through `bureau.tasks.respond`. The engine's reviews keep their own decision form.

A decision whose outcome the Bureau could not write into the conversation (`APPROVAL_OUTCOME_NOT_WRITTEN`) took effect, and the page says so, in a dismissible alert above the list because the Bureau has already dropped the review from its pending list, instead of saying it was not recorded. The engine's count is of the reviews still pending: one past its deadline is under Timed out, in the badge and on the page alike, and the Reviews card on `/engine` is titled as the engine's.

The list, and the count in the navigation, ask again every five seconds and at once after each decision this application makes (`src/lib/review-queries.ts`), including a decision on an approval inline in a chat. A chat that is already open does not update live; one opened afterwards reads the conversation the decision wrote into. The view is `reviews` with no console scope: the console drops the Bureau's scopes, and a refused list is the frame's forbidden state.

## The shell

The sidebar is Cinder's `SideNavigationGroup` twice: a Primary group (Chat, Agents, Workflows, Runs, Schedules, Reviews) and an Engine group (Workers, Storage, System, Audit). Chat is the home screen, sessions live at `/chat/:sessionId`, and runs live at `/runs` and `/runs/:id`. `/workflows` is the catalog of workflow definitions (see "The Workflows area" above), and `/audit` is the audit trail (see "Schedules, goals, and the audit trail").

Every view renders in a frame (`src/app/view-frame.svelte`) that is loading, empty, failing (Cinder's `ErrorState`, with a retry), forbidden, not found (for a view that opens one item by its address), or showing its content, and says which in `data-state` beside a `data-view` naming the view. Its words are in `src/app/copy.ts`, and its one request is in `src/app/view-probes.ts`. A probe whose empty answer is about to change by itself sets `recheckMs`, and the frame asks again that often while the view is empty and stops when it has something to show; the runs of a workflow type do, so a page opened before the first run shows it without a reload.

## Chat and agents

- `/` opens the session updated most recently (`src/routes/chat/chat-home.ts`), or `/chat` when there is none. The route's `redirect` replaces its own history entry.
- `/chat` lists the caller's sessions with `ChatConversationList`, newest first, with Load more paging and a New chat action. `src/routes/chat/session-summary.ts` maps a Bureau context to a row.
- `/chat/new?agent=:id` starts a session. The agent is a searchable `Combobox` above the composer, starting from `?agent=` or the default agent (`src/lib/default-agent.ts`, `assistant`); changing it replaces `?agent=`. The client names the thread, the first message starts the run, and when it has started the address becomes `/chat/:sessionId` by replacing the history entry, with the page kept mounted (`router.navigate`'s `keep`). `/chat/new` is registered before `/chat/:sessionId`. A first run that is refused stays on `/chat/new` with the row failed and a retry.
- `/agents` lists the agents the Bureau tells the caller of (`bureau.agents.list`: `kind`, publish state), with New chat for a published one. `/agents/:id` shows one agent's details (a file agent's model, tools and skills from `bureau.agents.definitions.get`), a New chat action when it is published, and the chats had with it.
- A session or agent the caller cannot see, or an unknown or unpublished agent for a new chat, is `not-found`.

### Memory

An agent remembers across every chat the caller has with it. The host composes governed memory for the Bureau (`src/host/memory.ts`): records and the governance ledger in Bungalow's database, the default policy, and `createHashingEmbedder()`, a deterministic embedder that makes no network call, so memory works with no model provider configured. Each chat run stores its final answer under the Bureau's identifier, its owner of record (`anonymous:local` here), and the agent's identifier; a later chat with the same agent recalls it, and a chat with another agent does not. Memory stored before this keyed it by session and is not migrated.

`/agents/:id/memory` (`src/routes/agents/agent-memory.svelte`, linked from an agent's page) lists what the agent remembers, newest first, with a search that ranks every memory by relevance (ranking has no score floor, so an agent with no memory is the only way a search finds nothing). Its loading, empty, failing, locked, and not-found states are the Agents view's (`VIEW_COPY.agents`, by pattern). A memory's details show its source, trust, class, creation time, and chat from the record, and the run that wrote it and the memories it corrects or was corrected by from the governance ledger. Forgetting is a source deletion that words each state the deletion can answer with (completed, held by a legal hold, pending, failed, unknown); the host declares `not-retained` only for the targets it keeps nothing in, and leaves `durable-snapshots` pending because a copy of recalled text persists in the conversation. Correcting writes the person's words as an operator memory that replaces the old one, and words the Bureau's two refusals. The page needs the Bureau's `bureau.memory:read` scope, and changing memory needs `bureau.memory:write`; the host's one local caller holds both.

### The conversation

`/chat/:sessionId` (`src/routes/chat/`) is `@lostgradient/chat` over the Bureau's AG-UI mount. A session is a Bureau context, and its conversation id is the AG-UI thread id. `chat-session.svelte.ts` holds one session's state and its `createChatSessionController`; `run-wiring.ts` is the transport. A turn is a start (`POST /bureau/ag-ui/agents/<agent>/run`, read through `@ag-ui/client`), a resume that carries the user's decision on a tool approval together with the turn that opened the run (never a follow-up row), or an attach (`GET /bureau/ag-ui/threads/<thread>/run`) to a run the page did not start, which restores the transcript from the stream's snapshot. A message typed while the run is going is a follow-up: the controller sends it through `bureau.contexts.input` under the id of its own row. Pending tool approvals are one warning alert above the transcript with Deny and Approve. A session the caller cannot see is `not-found`.

A finished session's transcript is read back from the mount (`GET /bureau/ag-ui/threads/<thread>/messages`, owner-scoped like the attach route), so reopening a session, by reload or by returning to it from the list, shows every turn in order.

Quoting is `@lostgradient/chat`'s, turned on here with `capabilities.quote`. Selecting text inside one agent reply opens a Quote popover, every agent reply has a Quote message action for the keyboard, and each quote gathers as a chip above the composer. Sending puts the quotes at the top of the message as Markdown block quotes (each line prefixed with `> `, one blank line between quotes), then the typed text, through the same send path as any message, so the agent receives them and a reloaded transcript shows them. A quote is the selected text, not a link back to the reply it came from, so quoting works within one session. `tests/e2e/34-chat-quotes.spec.ts` quotes from two replies to `echo` at 375 and 1280 pixels, with axe passing.

The model picker sits in the composer (`Chat`'s `composerActions`, `src/routes/chat/model-picker.svelte`). It lists `bureau.agents.models` for the session's agent, shows the session's own model (`bureau.contexts.get`'s `model`) or else the agent's default, and is hidden unless the agent allows more than one model. Choosing a model calls `bureau.contexts.steer` with the `configVersion` it read as `expectedRevision`, and the model is used from the session's next step. An admitted switch (or an exact replay) keeps the choice; a refusal for a stale revision reads the session again and shows the model it has now; any other refusal, or a fault, restores the previous selection, each with its own copy in `CHAT_COPY.modelPicker`. A model is a catalog row, so a seeded agent offers a model only when a configured provider holds it: `model-switcher` names `claude-sonnet-5` and `claude-haiku-4-5`, and a host with no provider offers it no choice. `tests/e2e/35-chat-model-switch.spec.ts` switches `model-switcher` between two messages, reloads to see the choice kept, and sees no picker for an agent that allows one model (`single-model`) or none (`echo`), at 375 and 1280 pixels with axe passing.

The final agent message of each completed turn offers Branch from here (`Chat`'s `messageActions`; `branch-points.ts` picks the messages: an agent message followed by a user message, or the last message while no run is going). It calls `bureau.contexts.fork` and opens `/chat/:newSessionId`, which holds the history through that reply and runs on the parent's model. The Bureau decides whether a message is a branch point, and a refusal says why in `CHAT_COPY.branch.refused` and leaves the person on the parent. A branch's header says "Branched from" with a link to the parent (`parentContextId`), or the same words without a link once the parent has been deleted. `tests/e2e/36-chat-branch.spec.ts` branches from the first of two replies and follows the link back, and sees a refused branch leave the page where it was, at both widths with axe passing.

Files are attached in the composer and returned as assets. What a person may attach comes from the selected agent's model: `bureau.agents.list` carries each agent's `media` (`modalities`, `mimeFamilies`, per-part `mediaLimits`, and `null` for an agent that names no model), `src/lib/chat-attachments.ts` maps the families to the file picker's types (`image/*`, `audio/*`, `video/*`, `application/pdf` for documents, `text/*`), and a type with no stated limit falls back to the Bureau's 100 MiB asset ceiling. The picker is off for an agent with no model, while a run streams, and while the run waits on the person's answer, because a follow-up and an answer carry text only. A file uploads as it is attached (`src/lib/bureau-assets.ts`: `bureau.assets.uploads.create`, `append` in 512 KiB chunks, `complete`), shows `uploading`, `ready` or `error` in its preview's `data-state`, and keeps Send disabled until every upload settles. A file over its type's limit or of a type the model does not take is shown as an `error` attachment and never uploaded, and each fault has its own words in `CHAT_COPY.attachments`. The message goes out with each uploaded file as a `file` part from the provider `bureau` whose `value` is the asset id. An agent's returned assets arrive as `bureau.asset-part` events, which `run-wiring.ts` stamps on the assistant row as `bureau:assetParts` (the key a reloaded thread's snapshot carries), and `chat-assets.svelte` shows them, and the person's own attachments, under their rows by kind: an image with Cinder `Image`, audio with `AudioPlayer` (a native `<audio>` driven by `MediaControls`), video with `VideoPlayer`, and anything else as a `Link` download, all from `/bureau/assets/<assetId>/content`.

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
