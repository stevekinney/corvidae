# Interborough

Interborough is Corvidae's main application. One process on one loopback origin serves the browser application, Weft's engine API for the Engine console, and a Bureau, with no sign-in. It is a private application: nothing here is published.

The browser application is the Weft operator console, moved here from `packages/weft/src/ui` (Weft no longer exports `./ui`, `dashboard()`, or a UI of any kind), with a new shell around it. The Weft console's coverage of Weft's operations is recorded in [`documentation/weft-console/coverage-matrix.md`](documentation/weft-console/coverage-matrix.md).

## Running it

Run every command from the repository root.

```bash
bun run --filter=@lostgradient/interborough dev
bun run --filter=@lostgradient/interborough build
bun run --filter=@lostgradient/interborough start
bun run --filter=@lostgradient/interborough test
bun run --filter=@lostgradient/interborough test:slow
bun run --filter=@lostgradient/interborough test:browser
bun run --filter=@lostgradient/interborough test:coverage
bun run --filter=@lostgradient/interborough lint
bun run --filter=@lostgradient/interborough typecheck
```

- `dev` runs the supervisor (below) around `bun --watch src/host/dev.ts`. It builds the browser application into `build/`, starts the host on `http://127.0.0.1:7234`, and rebuilds when the source changes. It runs under `bun --watch`, which restarts the host when its own modules change, and builds the browser application in a child process because the bundler fails inside the watched process. `INTERBOROUGH_PORT` picks another port, and `0` asks for a free one. Open pages reload themselves after each successful rebuild (and when the host restarts): the development host injects a small client into `index.html` that listens on `/__dev/reload`. A production host serves neither, and `build/` never contains the client.
- `build` writes the production build into `build/`: `index.html` and content-hashed JavaScript, CSS, and WebAssembly under `build/assets/`. The host serves that directory. A build replaces `build/` only once it succeeds.
- `start` runs the supervisor around `bun --no-install src/host/serve.ts`, which serves the existing `build/` with `development: false`. It builds nothing and watches nothing. Without `build/index.html` it exits 1 and tells you to run `bun run build` first. `INTERBOROUGH_BUILD_DIRECTORY` names another build directory for `start` and `dev`.
- **Restarting the host.** `POST /host/restart` (through the same Host and Origin guard as every route) answers `202`, shuts the Bureau down with its runs left parked, stops the host, and exits with code 75. The supervisor (`src/host/supervisor.ts`, `bun src/host/supervisor.ts <serve|dev>`) starts the host again on exactly that code and ends with the child's own code on any other; SIGINT and SIGTERM go to the child. A run waiting on a signal is still waiting after the restart. A source edit under `dev` restarts the host inside `bun --watch` without the supervisor. A supervisor killed with SIGKILL cannot forward the signal, so it leaves its host running.
- `test` runs the host's suite under `bunfig.toml`, then the browser application's under `bunfig.ui.toml`, whose preload installs happy-dom, the Svelte compile plugin from `@lostgradient/testing`, and the jest-dom matchers. The browser suite stays serial: under `--parallel`, Bun 1.4.2's workers load the default `bunfig.toml` preload on top of the one `--config` names. The tests in a `*.slow.test.ts` file bundle for seconds, so `test:slow` runs them.
- `test:browser` runs the Playwright suite in `tests/e2e` against a host it starts on port 7399 with the console's fixtures registered. The barrier's control listens on the next port, and the two hosts described under "Schedules, goals, and the audit trail" and "The journey" on the two after it, so the suite holds four consecutive ports. Set `INTERBOROUGH_E2E_PORT` to run the suite beside another checkout's, which holds 7399. `bun run --filter=@lostgradient/interborough test:browser -- tests/e2e/90-journey.spec.ts` runs the journey alone.
- `test:coverage` runs the browser suite under coverage and compares each area with the floor in `scripts/coverage-baseline.ts`.

## The host

`src/host/host.ts` starts everything:

- **State** lives in Bungalow's directory, `~/.interborough` or `INTERBOROUGH_HOME`, or in Postgres and S3 (see "Running on Postgres and S3"). Locally the Bureau runs on Bun SQLite at Bungalow's database path with `BureauOptions.id` set to Bungalow's `deploymentId`, so a restart keeps its tasks, sessions, schedules, and goals. The host takes Bungalow's single-instance lock, so a second host on the same directory refuses to start.
- **One caller.** There is no sign-in, and the host binds `127.0.0.1` only. Every request without a credential acts as `anonymous:local`, which holds every Weft scope and every Bureau scope. `weft.system.principal` reports that subject, and the shell names it in its top bar. The one credential the host knows is the operator's A2A key, which only A2A uses (see [A2A](#a2a)).
- **Routes** on the public origin:
  - `/api/*`, `/v1/*`, `/jsonrpc`, `/mcp`, and Weft's discovery documents are Weft's engine operations.
  - `/bureau/*` is `createBureauHandler` with the prefix removed, and `agUi: {}` mounts its AG-UI adapter at `/bureau/ag-ui`, which Chat talks to. It does not share Weft's root because both catalogs claim `/jsonrpc` and `/v1/…`.
  - `/assets/*` and every route in `src/app/routes.ts` serve the build.
- **Why there are two listeners.** Weft's server reports its own shared `unauthenticated-local` caller for a request with no credential. To make both halves of the application name `anonymous:local`, Weft's server listens on a private loopback port that answers only a per-process key, and the public listener relays to it (`src/host/engine-proxy.ts`), attaching the key and dropping any credential the caller sent.
- **One engine.** The Engine console serves the Bureau's own durable engine (`bureau.durableEngine()`), so a cancel from the console is fenced by the engine that owns the run and the live feed sees the Bureau's runs. Only the end-to-end fixtures replace it, through `createConsoleEngine`, because they register workflows of their own; the suite's second host keeps the default.
- **Seeded agents call no model.** Every seeded agent answers from `createScriptedGenerate`, whatever providers are configured. See `src/host/seed.ts`: `assistant`, `tool-runner` (a read-only tool and a mutating tool held for approval), `request-human-input` (free text, no schema), `echo` (repeats the text of the last message it was sent, so a quoted reply shows exactly what the agent received), `model-switcher` (a selectable agent over `claude-sonnet-5` and `claude-haiku-4-5`, whose reply names the model that answered; the host offers a model only when its provider is configured, so Chat shows the picker on a host that has both and none on a fresh one), and `internal` (a plain agent that answers with a scripted bookkeeping reply), plus one schedule and one goal. `tool-runner` answers from where the turn has got to, so the run that follows an approval reports what the refund came to, and each turn's calls carry the turn's number. Seeding creates the schedule and the goal once. `HostOptions.extraAgents` adds agents without changing the seed, which is how the end-to-end suite brings an agent that waits on a barrier. Real models come in through the catalog below.

The only module that reads the environment is `src/host/environment-configuration.ts`.

## Running on Postgres and S3

By default the state is a directory on one machine. Set two variables and it is a PostgreSQL database and an S3-compatible bucket instead, so several hosts can run on the same state at once. A rolling deploy is the case this is for: the old release and the new one are both up for a while, they share one deployment, and a run the old release parked is finished by the new one. Remote mode is chosen only by the variables below, which the host reads from its environment (through Bungalow, `@lostgradient/bungalow`). An empty variable counts as unset, and `INTERBOROUGH_HOME` is not read in remote mode. Setting exactly one of the two selecting variables is an error that names the other.

| Variable | What it is |
| --- | --- |
| `INTERBOROUGH_DATABASE_URL` | The Postgres connection URL. Selects remote mode, with `INTERBOROUGH_BUCKET`. It carries the password, so keep it out of logs and commands. |
| `INTERBOROUGH_BUCKET` | The bucket that holds the configuration, the agent and workflow definitions, and the deployment ID. Selects remote mode. |
| `INTERBOROUGH_BUCKET_PREFIX` | Optional. A folder in the bucket, such as `production`, so several installations share one bucket. A leading `/` is dropped and a trailing `/` is added. A prefix with an empty, `.`, or `..` segment is refused. |
| `S3_ENDPOINT` | The S3 endpoint URL. Required. |
| `S3_REGION` | The region. Required. |
| `S3_ACCESS_KEY_ID` | The access key ID. Required. |
| `S3_SECRET_ACCESS_KEY` | The secret access key. Required. |
| `S3_SESSION_TOKEN` | Optional. A session token for temporary credentials. Bungalow refuses to open when the host's process itself carries an `AWS_SESSION_TOKEN` or `S3_SESSION_TOKEN` (an aws-vault or SSO shell, say) and the environment given to the host sets no `S3_SESSION_TOKEN`, because Bun would sign every request with the ambient token. |
| `INTERBOROUGH_SECRET_APPROVAL_SECRET` | Required in remote mode. The secret that signs the approvals the seeded `tool-runner` raises. Give every host the same value: an approval one host signed must verify on another. A host without it does not start (the error names this variable, and nothing is listening yet). Locally the host creates it on first use. |
| `INTERBOROUGH_SECRET_ANSWER_ENCRYPTION_KEY` | Required in remote mode. The key secret answers are sealed with: base64url of 32 random bytes (for example `bun -e "console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'))"`). Give every host the same value, or an answer one host sealed cannot be read on another. A host without it does not start. Locally the host creates it on first use. |
| `INTERBOROUGH_SECRET_ANTHROPIC_API_KEY`, `INTERBOROUGH_SECRET_OPENAI_API_KEY`, `INTERBOROUGH_SECRET_GEMINI_API_KEY` | A model provider's API key, in place of the file in `secrets/`. |
| `INTERBOROUGH_SECRET_TYPESAFE_API_KEY` | The optional TypeSafe key for Bureau's typed decisions (see "Decisions"). |
| `INTERBOROUGH_SECRET_A2A_API_KEY` | The optional A2A key every A2A caller presents (see "A2A"). Give every host the same value. Without it A2A stays on loopback with no key. |

Interborough reads none of the `S3_*` variables itself. Bungalow builds the `Bun.S3Client` from them and the host hands it to the definition sources. `bun run dev` passes all of these variables through Turborepo, so `bun run dev` can start remote mode.

**The bucket layout.** With the prefix `P` (empty, or ending in `/`), the bucket holds:

| Object or folder | What it is |
| --- | --- |
| `P` + `deployment-id` | The deployment's identifier, written once with `If-None-Match: *`. Hosts that start together agree on the one value the store kept. Do not edit it. |
| `P` + `configuration.json` | The model providers (see "Model providers"). A missing object means no providers. Put it there yourself; a remote host cannot write it. |
| `P` + `agents/<id>.md` | One agent per object, in the Markdown file format of "Agent files". The agent editor writes here. |
| `P` + `workflows/<id>.json` | One workflow per object, in the format of "Workflow files". The Workflows pages write here. |

The Settings page and the editors show these as `s3://<bucket>/<prefix>...`, and show a provider's key as its variable name. They never show the database URL or an S3 credential, and neither does `/host/paths`. It reports the `mode` and the `database` (a SQLite file's path, or a Postgres server's host, port, and database name), the same `database` the host hands its embedder.

**Durability is locked.** In remote mode the host locks the `durableOwnership.ownership`, `maintenance`, `durable`, `engine.workflowClaimTtl`, and `engine.workflowClaimRenewInterval` settings, which the Settings page shows under Durability as locked and disabled. Bureau reports each as locked for the reason `shared-storage`; a key the host's caller locks reports `deployment`. Each is held to Bureau's code default (automatic maintenance, a durable engine, and a claim TTL above the renew interval), because a stored `maintenance: 'manual'` would start no scheduler on the next release, and a run parked by the old release would never finish on it. Several hosts share a run only because each holds a lease on the runs it works on. Turning that off (`none`) from one host's Settings page would make every host run every task, so the setting stays at Bureau's lease default and a stored change is refused. A local host keeps the control editable. To make a run one host detached run on another host, the other host needs no restart and no call: it claims the run on its next claim-renewal tick, at most 5 seconds (`workflowClaimRenewIntervalMs`) after the first host closes and releases its claims. It is the renewal interval, not the claim TTL, so nothing waits for a crashed host's claim to expire in this path.

**What polling costs.** The agent and workflow sources have no change feed to subscribe to, so each polls its prefix. A tick lists the prefix twice (the poll's scan, then Bureau's `load()`), so Bureau's default of one second would send about 172,800 `LIST` requests a day per source per host (two sources per host: agents and workflows). The host sets the interval to 30 seconds (`REMOTE_POLL_INTERVAL_MILLISECONDS` in `src/host/locations.ts`), about 5,760 requests a day per source per host. A change made from the application applies at once; a change made in the bucket by hand shows up within 30 seconds. Count the hosts you overlap when you read a bill: a rolling deploy doubles it for a while.

**Conditional writes and deletes.** The sources write and delete with `If-Match` on the ETag they just read, so two hosts or a host and a person do not overwrite each other. The in-process S3 server the tests run against (`@lostgradient/testing/s3-server`, modeled on a Railway bucket) honors `If-Match` on `DELETE`, and `host-remote.test.ts` probes it. AWS S3 honors it on `DELETE` only for directory buckets, so on a general-purpose bucket a delete is unconditional after the source's own hash check. Probe the store you use before relying on it.

**The overlap test.** `src/host/remote-overlap.slow.test.ts` starts two hosts at once on one fresh Postgres database and one bucket. Both define an agent that calls a counting tool and then `requestHumanInput`. It asserts that both hosts start, that one seeded schedule exists, that both report one `deploymentId`, that a task started on the first parks with the counter at 1, that after the first closes the review is resolved through the second and the task completes, and that the counter is still 1. Run it with `bun run --filter=@lostgradient/interborough test:slow`. It needs `initdb` and `pg_ctl` on `PATH` or `WEFT_TEST_POSTGRES_URL`, and skips without either.

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
- A question field the agent marks secret (`x-secret`) is encrypted before Bureau keeps it, under the Bungalow secret `answer-encryption-key`, which the host creates on its first local start. To rotate it, move its value to `answer-encryption-key-<keyId>`, where `<keyId>` is the 24-character id every sealed answer's `keyId` names, and write a new key to `answer-encryption-key`; answers sealed under the old key stay readable while that file exists, and are `secret-unavailable` once it is deleted. See [Bureau's secret answers](../../packages/bureau/documentation/secret-answers.md).
- Each provider's API key is a Bungalow secret: `anthropic-api-key`, `openai-api-key`, and `gemini-api-key`, one file each in `secrets/` (mode `0600`). Surrounding whitespace is trimmed. A configured provider with no key is left out of the catalog, and the host logs one warning that names the provider and the secret it expects, never a value.

```bash
mkdir -p ~/.interborough/secrets
printf '%s' "$YOUR_KEY" > ~/.interborough/secrets/anthropic-api-key
chmod 600 ~/.interborough/secrets/anthropic-api-key
```

The host passes the catalog rows as `models.catalog` when it creates the Bureau, so no boot step plans against a provider that is not configured, and `bureau.models.replace(rows)` is the only way the rows change. `host.generateFor({ provider, model })` is the generate for an agent assigned a catalog model: it resolves through Bureau's `resolveProviderGenerate` with the host's provider definitions (`PROVIDER_DEFINITIONS`: Anthropic, OpenAI, and Gemini) and the provider's key, and refuses a model the catalog does not hold or one that is turned off.

### Changing providers without a restart

A local host writes the configuration and a provider's key itself, and applies them at once. Editing the files by hand and asking the host to read them again works the same way.

| Request | What it does |
| --- | --- |
| `GET /host/providers` | Each provider, whether `configuration.json` lists it and whether it has a key (never the key), its allowlist, and the catalog edits. Carries `lockReason` when writes are refused. |
| `PUT /host/providers/<name>` `{ "apiKey", "models"? }` | Connects the provider, or replaces its key: the key goes to `secrets/<name>-api-key` (mode `0600`) and the provider into `configuration.json`. Without `models` an existing allowlist stays; `"models": null` clears it. |
| `PUT /host/catalog` `{ "edits": [...] }` | Replaces the catalog edits (below). An empty list removes them. |
| `POST /host/providers/reload` | Reads the configuration and the keys again, for a person who edited them by hand. |

Every change is checked against the keys the host holds before any byte is written, so a request cannot leave a configuration the next start refuses. The files are then read back, the rows become the Bureau's catalog (`bureau.models.replace`), and the agent files are rebuilt before the request answers. A run that began earlier finishes with the key it started with. The first run that begins after the answer uses the new key. The same operations are `host.providers.connect`, `.editCatalog`, `.reload`, and `.snapshot`.

The configuration is written atomically (Bungalow's `writeConfiguration`: a temporary file, synced, renamed over `configuration.json`, mode `0600`), so a crash mid-write leaves the previous file whole. An error names the field, such as `apiKey` or `providers.openai.models[0]`, and never a value. No response, warning, log line, or diagnostic holds a key.

**Catalog edits.** A `catalog` list in `configuration.json` turns a model off, corrects its price or limits, or adds a row the built-in list lacks:

```json
{
  "providers": { "openai": {} },
  "catalog": [
    { "provider": "openai", "model": "gpt-4.1", "off": true },
    {
      "provider": "openai",
      "model": "o3",
      "pricing": { "inputPerMillionTokens": 2, "outputPerMillionTokens": 8, "currency": "USD" },
      "contextWindowTokens": 200000,
      "maxOutputTokens": 100000
    },
    { "provider": "openai", "model": "gpt-next", "basedOn": "gpt-4.1" }
  ]
}
```

An edit that names a built-in model (by `model` or alias) changes that row. A price edit keeps the row's `longContext` rates unless its `pricing` names them: `"longContext": { "inputTokensAbove", "inputPerMillionTokens", "outputPerMillionTokens" }` replaces them and `"longContext": null` removes them. An off model stays listed as `unavailable`, which keeps it from agents and plans, and `host.generateFor` refuses it. An edit that names no built-in model adds a row: `basedOn` names a current model of the same provider whose capabilities it copies, and it may set its own price and limits. An edit with no match and no `basedOn`, a second edit for one model (under the same name or another, such as `claude-haiku-4-5` and `haiku`), or an output limit above the context window fails with the field, for example `catalog[0].model`.

An allowlist (`providers.<name>.models`) may name an added row by its model, and applies to added rows as to built-in ones: an added row the allowlist does not name is left out.

**Other writers of `configuration.json`.** A write reads the file, changes the part it owns, and writes the whole file back, so writers must not overlap. `host.configurationQueue.run(work)` is the one queue they share (`src/host/configuration-queue.ts`): run the whole read-change-write inside `work`. The provider manager uses it, and any other part of the host that writes the file must too.

**A failed key change.** The key is written before the configuration. When the configuration cannot be written, the previous key is put back and the host keeps using it. If the key itself cannot be written, nothing changed and the answer is a plain `500` with `{ "error": "failed" }`. If the previous key cannot be put back either, the answer is `500` with `{ "error": "partial", "inUse": ... }`, where `inUse` is what the host loaded afterwards: `true` for a configured provider (the new key is in use), `false` for a new provider whose configuration was not written (the key is stored but not used).

**Remote mode refuses.** A remote home keeps its configuration in the bucket and its keys in the environment, which the host cannot write. `PUT` requests answer `403` with `{ "error": "locked", "reason": "deployment" }`, `/host/paths` reports `locked: { configuration: "deployment", providerKeys: "deployment" }` (the reason codes `settings.get` gives a locked key), and `host.providers.connect` and `.editCatalog` throw `ProviderWriteLockedError`. Reload still works, since it only reads.

### Executable skills

An executable Agent Skill is a directory with a `SKILL.md`; the descriptive skills an agent file declares (`skillDescriptors`) are another thing. The host finds skills in the directories `configuration.json` names under `skills`, and trusts only the ones it lists:

```json
{
  "skills": {
    "sources": [
      { "id": "home", "kind": "user", "path": "/Users/me/.agents/skills" },
      { "id": "workspace", "kind": "project", "path": "/Users/me/work/app/.agents/skills" }
    ],
    "trusted": ["home"]
  }
}
```

A source is a directory whose subdirectories are skills: `id` is letters, digits, `.`, `_` and `-`, `kind` is `user` or `project`, and `path` is absolute. Configuring a directory does not trust it, for either kind: a source is trusted only when `trusted` lists its `id`, and `trusted` may name only configured sources. The key is optional, so a file written before it existed loads with no skills, and every other key is left alone. A mistake stops the host and names the field, such as `skills.sources[0].path`.

`bureau.skills.list` shows each skill with its source, trust and allowed tools. A skill from an untrusted source is listed and cannot be activated: the skill client answers `source-untrusted`.

| Route | What it does |
| --- | --- |
| `PUT /host/skills/sources/<id>/trust` `{ "trusted": true }` | Trusts a configured source, or stops trusting it (`false`): writes `skills.trusted` to `configuration.json` through `host.configurationQueue`, applies it at once, and records `skill.source.trusted` or `skill.source.untrusted` in the audit trail, filed under `skill-source:<id>` with the owner. A source that already has the trust asked for changes and records nothing. `404` for a source the file does not list, `400` for a body or a file that cannot be used. |
| `POST /host/skills/refresh` | Reads the configuration and the directories again, for a person who edited a file or added a skill by hand. |

Remote mode refuses a trust change: `PUT` answers `403` with `{ "error": "locked", "reason": "deployment" }` and `host.skills.setTrust` throws `SkillWriteLockedError`, since the bucket's configuration belongs to the deployment. Listing and refreshing still work. If the change is applied but the audit trail cannot take the record, the answer is `500` with `{ "error": "partial" }` and the change stands.

### Saved tool sources

An agent file may list tools from an MCP server or an OpenAPI service the host has saved. Sources are the `toolSources` key of `configuration.json`; each entry holds Armorer's description under `source` (plain JSON from `armorer/tool-sources`, which names a credential and never holds one) and, beside it, any settings of the host's own under `tools`, keyed by the tool's own name. `tools` has one field, `acceptsSecrets` (see below), and a field it does not know is refused, not ignored:

```json
{
  "toolSources": [
    {
      "source": {
        "id": "tracker",
        "kind": "mcp",
        "transport": {
          "type": "http",
          "url": "https://mcp.example.com/mcp",
          "authentication": { "type": "bearer", "credential": "token" }
        }
      }
    }
  ]
}
```

**`acceptsSecrets` per tool.** A tool receives the plaintext of a secret answer (COR-1816) only when its metadata says `acceptsSecrets: true`; any other tool that is handed a `{ secretRef }` fails with `secret-not-accepted` before it runs. A source's tools declare nothing, so the owner opts a tool in under `tools`, keyed by the tool's **own name as the server lists it**, not the `<id>__<tool>` name an agent file uses (the raw name is stable across the naming rules below):

```json
{ "source": { "id": "tracker", "…": "…" }, "tools": { "create_issue": { "acceptsSecrets": true } } }
```

It is off unless `true`: an absent entry, `{}` and `false` are the same. When the source loads, the host sets `metadata.acceptsSecrets: true` on each flagged tool and leaves every other tool exactly as Armorer made it, so only a flagged tool reaches the Bureau's secret-answer resolver. A name the server does not list (or lists but the host does not offer, such as a skipped duplicate or an operation `allowOperations` leaves out) is not an error: the source stays loaded, the setting reaches no tool, and `GET` lists it under `unmatchedSettings` with a reason (the host also logs one line). `acceptsSecrets` must be a boolean; anything else stops the host naming `toolSources[<n>].tools.<tool>.acceptsSecrets`.

`id` is 1 to 20 lowercase letters, digits and hyphens, starting with a letter (a tool name that began with a digit would be refused by Gemini), because it names the Bungalow secret `tool-source-<id>` that holds the source's credentials. A mistake stops the host and names the field, such as `toolSources[0].source.id`. The key is optional, and every other key is left alone.

**The name an agent file uses.** A source's tool is `<id>__<tool>`: the source's `id`, two underscores, and the tool's own name. An `id` never holds `_`, so the first `__` ends it: two sources, or a source and a built-in tool such as `lookup-order` or Bureau's `workflows-*`, can never share a name. The whole name stays within 64 characters, the shortest limit a model provider sets. An agent file stores the name, and a tool approval hangs on it, so the name is a contract that depends on the tool's own name alone, never on what else the server lists or in which order:

- A name made only of letters, digits, `_` and `-`, short enough, and not ending in `-` and eight hex digits is used as it is: `tracker__create_issue`, and an OpenAPI source's `list-pets` is `pets__list-pets`.
- Any other name is `<id>__<readable>-<digest>`: each character outside that set becomes `_`, the readable part is cut so the whole fits in 64 characters, and `<digest>` is the first eight hex digits of the SHA-256 of the tool's raw name. `foo_bar` is `files__foo_bar` and `foo.bar` is `files__foo_bar-` plus its digest, so the two stay apart, and dropping or reordering either never moves the other's name. A name that already ends in `-` and eight hex digits takes a digest of its own, so a plain name and a digested one never meet.
- If two tools of a source would still get one name (a server that lists a name twice, or a digest collision), neither is offered: both are skipped and listed under `skipped` with the reason, and the rest load. Neither the first nor the last wins, since that would let the server's listing order decide which tool a stored name means. A tool with no name is skipped the same way.

Renaming a source's `id` renames its tools. MCP has no allow-list in Armorer, so a source offers every tool its server lists; an OpenAPI source narrows with `allowOperations` and `namePrefix` in its description.

**Loaded at boot, listed after a restart.** The host loads every source before it builds the Bureau, with each tool's capability tier from Armorer (an MCP tool's annotations; an OpenAPI operation's HTTP method), so `bureau.agents.catalog` lists `tracker__…` beside the built-in tools and an agent file may name them. Each tool also carries a version, a digest of what a person approves of it: the source's `id`, where its calls go (an MCP server's URL or command line, an OpenAPI service's resolved base URL), the tool's name and input schema, and its capability (an MCP tool's annotations; an OpenAPI operation's method and path). It leaves out descriptions, a server's own name and version, and credentials, so an unchanged tool has the same version at every start. An approval, and a chat's remembered tool, are bound to that version: a tool whose schema, capability or destination changed asks again. A source added or changed later reads `pending-restart` until the host starts again. One source that cannot load, because it is unreachable, names a credential nobody stored, holds credentials that cannot be read, or does not answer within 30 seconds (at which point a local command's process is stopped, and so is one that is still connecting when the host closes), is reported on its own entry (`failed`, with a message that names no URL or value) and never stops the host or another source. An OAuth source with no tokens is not contacted: it reads `needs-authorization`.

**Credentials are encrypted.** Bearer tokens, API keys, a local command's environment secrets, and an MCP source's OAuth state (tokens, client registration, the PKCE verifier and `state` of a sign-in in progress, discovery state) are encrypted with the AES-GCM helper of `@lostgradient/cryptography`, under the same installation key secret answers are sealed with (`answer-encryption-key`, so a rotation keeps earlier values readable), and kept in `secrets/tool-source-<id>` as JSON: the credential names in the clear, every value ciphertext, each ciphertext bound to its source and name. Rotating the key (see "Secret answers" above) keeps them readable while the retired key exists; once it is deleted the source reads `failed` with "cannot be read" until it is connected again. Nothing else holds them: not `configuration.json`, an error, a log line, the audit trail, or a response.

**Credentials go only where they were given.** A stored credential is carried over to a later `PUT` only when the source goes to the same place: the same kind and, for an MCP server, the same URL (or, for a local command, the same command, arguments and working directory), or, for an OpenAPI service, the same `baseUrl` and specification URL (or inline document's servers). Change any of those and every stored credential and any OAuth sign-in is dropped; the request must supply new credentials, or is refused with `400` naming `credentials.<name>`. Changing something else, such as `allowOperations` or an OAuth scope, keeps them. A new source never starts from a secret an earlier source with the same id left behind, and removing a source clears its secret. Until the host restarts, the tools a replaced or removed source loaded stay connected to the old address and are given no credential or sign-in at all, so a call fails rather than carry the new address's token to the old server; a rotated credential for the same address is picked up at once. The per-tool `acceptsSecrets` flags follow the same rule: they are kept only while the source still goes to the same place, and a change to any of those drops every flag. Connecting a source again also repairs a secret that cannot be read (a retired key that is gone), even for an OAuth source that names no credential.

| Route | What it does |
| --- | --- |
| `GET /host/tool-sources` | Each configured source with its `state` (`loaded`, `failed`, `needs-authorization`, `pending-restart`), `tools` (`name`, `tool`, `tier`, `acceptsSecrets`), `skipped`, `unmatchedSettings` (`tool`, `message`), `settingsPending: true` when the saved tool settings differ from the ones the running host applied, stored credential `credentials` names, and, for OAuth, `authorized`. Carries `lockReason` when changes are refused. |
| `PUT /host/tool-sources/<id>` `{ "source": { … }, "credentials": { "<name>": "<value>" } }` | Connects a source or replaces it: stores the credentials the description names (one already held may be left out), then lists the source in `configuration.json` through `host.configurationQueue`. `source.id` must be `<id>`. Answers `{ id, changed, restartRequired: true }`. |
| `PUT /host/tool-sources/<id>/tools` `{ "tools": { "<tool>": { "acceptsSecrets": true } } }` | Sets the host's own settings for the named tools of a configured source (`<tool>` is the server's own name for it). Each named tool's settings are replaced and the others kept; `false` or `{}` removes the entry, since off is the default. `PUT /host/tool-sources/<id>` keeps a source's `tools` only while the source still goes to the same place (the same recipient that keeps its credentials); pointing it at another server drops them all, so a flag granted for one server never reaches another, and the audit record names the tools revoked. Answers `{ id, changed, restartRequired: true }`; `404` for a source that is not configured, `400` naming the field (`tools.<tool>.acceptsSecrets`) for a value it cannot use. Recorded in the audit trail as `tool.source.tools-configured`, whose detail lists the tool names `granted` and `revoked` (names only). Loaded at the next start. |
| `GET /host/tool-sources/<id>/affected-agents` | Lists the agent files that name a tool the host loaded from the source, or any tool whose name starts with `<id>__` (so a source that failed, awaits a sign-in, or was added since the host started is covered), in `tools` or only in `toolApproval`, as `{ id, tools: […], affectedAgents: [{ id, name, tools, toolApproval }] }`, without changing anything. Works on a remote host. `404` for a source the configuration does not list. |
| `DELETE /host/tool-sources/<id>` | Removes the source and clears its credentials. Answers `{ id, changed, restartRequired: true, affectedAgents }`, the same list as the preview. |
| `POST /host/tool-sources/<id>/authorize` | Starts an MCP OAuth sign-in: answers `{ "authorized": false, "authorizationUrl": "…" }` to open in a browser, or `{ "authorized": true }` when the stored tokens already work. |
| `GET /host/oauth/callback/<id>` | Where the authorization server sends the browser back (`http://127.0.0.1:<port>/host/oauth/callback/<id>`, built from the host's origin). It accepts only the `state` the sign-in recorded, only while one is waiting, only within 10 minutes of the authorization URL being handed out, and only for the description the sign-in began for; a callback for a source that was removed or changed since is refused with `400`. It exchanges the code, stores the tokens, and answers a small page that repeats nothing from the request, taking its turn with every other change to the configuration and to that source's secret, so a removal that arrives during the exchange waits for it. The exchange is cancelled after the 30-second load timeout. The tools are listed after a restart. |

URLs in a description (an MCP `url`, an OpenAPI `specification.url`, `baseUrl`) must be http or https without a username or password: the route refuses anything else with `400` and the field, such as `source.transport.url`, and never repeats the URL. A failed configuration write is repaired: the credentials the file still describes are put back, a write that threw after it replaced the file is read back and taken as done, and if the put-back fails too the answer is `500` with `{ "error": "partial" }`. A change that is applied but cannot be recorded in the audit trail answers `500` with `{ "error": "partial" }` and stands.

**Removing a source breaks the agents that use it, and edits none of them.** Read `GET /host/tool-sources/<id>/affected-agents` first. An agent counts as affected when its file names a tool the host loaded from the source, or any tool whose name starts with `<id>__`, so a source that failed, awaits a sign-in, or was added since the host started is covered too. A removal never rewrites an agent file: the files stay byte for byte as they were, and the audit entry (`tool.source.removed`) names the affected agents (`affectedAgents`, comma-joined identifiers, and `affectedAgentCount`). The agents change at the next start, like every other change to a source: the tool catalog the Bureau runs with is fixed when the host starts, so until then the removed tools stay in it but every one refuses to run (whatever the kind of source: a key an OpenAPI source read at load, a local command's environment and an open MCP session can no longer be used, and the connection is closed and a local command stopped), so an agent that calls one gets an error, and the agents stay `ready`. After the restart each affected file reads `invalid` with `unknown-tool`, naming the tool, until the owner detaches it from `tools`; a file that named a tool only in `toolApproval` was already `invalid` (`unknown-approval-tool`) and stays so until that entry is removed. The source's secret is cleared with it, which also clears the OAuth state of a sign-in that was still waiting; a callback that arrives afterwards finds no sign-in and answers `400`.

**A local command is the owner's.** A source whose transport is `stdio` spawns a process on this machine, so only the owner principal may add it; anyone else gets `403` with `{ "error": "owner-only" }` (`ToolSourceOwnerOnlyError`), and nothing is written. Every connect, removal, sign-in and tool-settings change is recorded in the audit trail under `tool-source:<id>` (`tool.source.connected`, `tool.source.removed`, `tool.source.authorized`, `tool.source.tools-configured`), and a local command's record carries its `commandLine`: the executable and its arguments, never its environment or credentials.

**Remote mode refuses.** The bucket's configuration and the environment's secrets belong to the deployment, so every change answers `403` with `{ "error": "locked", "reason": "deployment" }` and `host.toolSources.connect`, `.configureTools`, `.remove`, `.authorize` throw `ToolSourceWriteLockedError`. Reading (including the affected-agents preview), and loading what the deployment configured, still work.

### Decisions

Bureau answers typed questions (`bureau.decisions.decide`, and the `decide` tool a task can call) with a language model from this catalog. An optional `typesafe-api-key` secret (a file in `secrets/`, mode `0600`, whitespace trimmed) registers TypeSafe's Jev as the decision model `typesafe`, the default of the `decisions.model` setting, for the kinds it serves: `boolean`, `choice`, and `scale`. Switching `decisions.model` to `catalog` on the Settings page sends every question to the fallback; the next decision uses the new choice. A `structured` question, and every question when the secret is absent, goes to the catalog's fallback row (`anthropic/claude-haiku-5-5`, else the cheapest priced row with structured output), which needs a configured provider. With neither, `decide` fails with `NOT_CONFIGURED`.

## Agent files

Agents can be Markdown files in `agents/` under the state directory, `~/.interborough/agents/` or `$INTERBOROUGH_HOME/agents/`. The host creates the directory and passes it to the Bureau as an `agentSource` (`agentFileDirectory` from `@lostgradient/bureau/sources`), so a file `researcher.md` is the agent `researcher` and a change to the directory takes effect without a restart.

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

The host serves every ready agent to chat. An agent's `a2a` opt-in decides whether it is also served over A2A, as [A2A](#a2a) describes. See the Bureau's `documentation/agent-files.md` for the format.

### The agent editor

`/agents/new` creates an agent and `/agents/:id/edit` edits and deletes one, through the Bureau's `bureau.agents.definitions.*` and `bureau.agents.catalog` operations (`src/lib/agent-definitions.ts`). The page lives in `src/routes/agent-editor` and renders in its own view, `agent-editor`, whose states are loading, error, forbidden, and not found.

- **The fields** are name, identifier, description, model, tools, and the instructions body. The model and tool lists are exactly what `bureau.agents.catalog` returns, so with no provider configured the model list is empty and the page shows no form. It shows where to add a provider instead (the configuration file, an example `providers` entry, and the file that holds each provider's API key) with a reload that asks the Bureau again. `skillDescriptors` has no field: a save sends the loaded `skillDescriptors` back unchanged. The A2A switch is the one control beside the form's footer.
- **The identifier** is the file name without `.md`. On `/agents/new` it fills in from the name as a slug and can be edited until the first save, and after that it is read-only. A taken identifier, whether another file or an agent defined in code, shows on the field and writes nothing.
- **The A2A switch** sets the agent's `a2a` opt-in. It travels with a save like any other field, so turning it changes nothing until the person saves.
- **Conflicts.** Every write names that `hash`. A file that changed on disk since is refused as `StaleRevision`, and the page says the agent changed outside Interborough, with a reload that discards unsaved edits. A file that was deleted on disk is the not-found state, and so is an identifier that names no agent or an agent defined in code. A file the Bureau cannot use opens the editor in an error state with its problem and its path.
- **The file path** comes from the host's `/host/paths`, which names the agent directory and the workflow directory, the `configurationFile` where model providers are configured, and the `providers` the configuration accepts, each with the `secretFile` that holds its API key. The revision history under the form lists the versions that have run, each by its short hash and last-run time, most recently run first. A save alone does not add a row.
- **Entry points.** The agent list has a New agent action, and an agent's page has an Edit action when the agent is a file; an agent defined in code has no Edit, because the editor would not find it. The list also shows each invalid agent file, with its error, its path, and a link to its editor, because `bureau.agents.list` leaves invalid files out and the list reads `bureau.agents.definitions.list` for them. A deleted agent leaves the list.
- **The identifier `new`** is refused, because `/agents/new` is the page that creates an agent and an agent called `new` could never be opened.
- **After a write** a save lands on `/agents/:id`, and a delete lands on `/agents`.

The Playwright suite gives its host a provider configuration and a fixture key in the temporary home, and a fake provider client, so its catalog holds `anthropic/claude-sonnet-5` and `anthropic/claude-haiku-4-5`, and saving, conflicts, history, and deletion run against the real Bureau (`tests/e2e/e2e-server.ts`, `src/host/fake-provider.test-support.ts`).

## A2A

The host mounts Bureau's A2A 1.0.1 handler under `/bureau/a2a/<agent>` (COR-1819), so another agent or tool can read an agent's card and send it work. Only an agent that opted in is served:

- A file agent opts in with `a2a: true` in its own file (the agent editor's A2A switch). Turning it off takes the card down and refuses new tasks, and the agent keeps serving the tasks it already has until the last of them is past its retention.
- A code agent opts in by name through `HostOptions.a2aAgents`. The default is none, so the seeded agents are not served; naming an agent the host does not define stops the host at start.
- The card is at `http://127.0.0.1:<port>/bureau/a2a/<agent>/.well-known/agent-card.json` and names the interface URL `http://127.0.0.1:<port>/bureau/a2a/<agent>`. Both are derived from the origin the listener ended up on, so a host started on port 0 names the port it got.
- **Without an A2A key** A2A has no authentication, as the rest of the host has none: it is reachable only on the loopback listener, behind the same request guard as the rest of the host, and every call acts as the owner (`anonymous:local`). A caller therefore sees what the owner sees, including `bureau.agents.list`, `bureau.agents.models`, and `bureau.deployment.get`.
- **With an A2A key** (COR-1904) every A2A JSON-RPC call must present it as `X-API-Key: <key>` or `Authorization: Bearer <key>`, on loopback too, and a call without it or with another key is a 401. The key is the Bungalow secret `a2a-api-key`: `~/.interborough/secrets/a2a-api-key` locally, `INTERBOROUGH_SECRET_A2A_API_KEY` in remote mode. The operator chooses it; the host never makes one up, never logs it, and compares it in constant time, and a secret that is blank once trimmed stops the host. The key acts as `api-key:a2a`, which holds the asset scopes a file part needs and no operator scope, so it can name only the agents that opt in, and on loopback, where it also reaches the management plane, `bureau.agents.list` and `bureau.agents.models` show it only those agents and `bureau.deployment.get` refuses it. Every holder of the key owns its tasks as that one principal, so they see each other's tasks. The cards stay public, as the A2A specification has them, and advertise the API-key schemes. The host's own pages send no credential and keep acting as `anonymous:local`.
- **Reaching A2A from elsewhere.** The host still binds loopback only; a reverse proxy on the same machine forwards to it. `INTERBOROUGH_A2A_PUBLIC_ORIGIN` names the origin the proxy serves, such as `https://agents.example.com` (an `https` origin with no path, or the host does not start), and the proxy must pass that `Host` through. A proxy that rewrites `Host` to the upstream's own address (nginx's `proxy_pass` does unless `proxy_set_header Host $host` says otherwise) exposes the whole host, every page and the engine included, to its callers as the owner, because the guard cannot tell its requests from a local one. A request naming that `Host` (with or without `:443` written out, and no other port) is let through the request guard for `/bureau/a2a/*` and `/bureau/assets/*` only, with no `Origin` or that origin's own; every other path refuses it with 403, as the guard refuses any other foreign `Host`. The cards then name the public origin. A public origin needs the A2A key, or the host does not start. Generated media and file parts name the asset route `<public origin>/bureau/assets/<id>/content`, which a remote caller reads with the key: the Bureau serves an asset only to its owner, so the key reads the media of its own tasks and another owner's asset is a 404. An asset request from the public origin without a credential is a 401 at the guard, because the Bureau would serve it as the owner.
- **Push notifications** are off by default. The `a2a.push.enabled` setting turns them on and `a2a.push.sweepIntervalMs` sets how often configurations of vanished tasks are swept (default one hour, at most 2147483647). Both apply at restart: the host reads them once when it builds the handler. With the setting on, a card declares `pushNotifications`, configurations and deliveries are kept in the host's database, and a delivery loop runs until the host closes (`src/host/a2a-push.ts`). Delivery uses Weft's default egress policy, which allows HTTPS to public addresses only, so a configuration naming a loopback or private address is refused at delivery. The Settings page shows both under A2A.

## Workflow files

Workflows are JSON files in `workflows/` under the same directory, `~/.interborough/workflows/` or `$INTERBOROUGH_HOME/workflows/`. The host creates the directory and passes it to the Bureau as a `workflowSource` (`workflowFileDirectory`), so a file `nightly-digest.json` is the workflow `nightly-digest`: it runs on the schedule its `trigger` names, its `agent` steps run any agent above, and a change to the directory takes effect without a restart. Every workflow belongs to the one local owner. See the Bureau's `documentation/workflow-files.md` for the format.

The host keeps what a workflow writes with `ctx.log` beside its run (COR-1811): the newest 500 lines per run (`logs.maximumLinesPerRun`), each line (message and attributes together) held to 2 KiB, for 7 days after a finished run last wrote one (`retention.logs`, swept by the maintenance pass; a run that is still active, such as one parked on a signal or a review, keeps its lines), with the count of lines the cap evicted. Both keys are on the Settings page. Read them through the engine API, `GET /v1/workflows/<id>/logs` (`weft.workflows.logs.list`), optionally narrowed with `?step=<n>` to the lines logged before that durable step. The sink is buffered and flushed on shutdown, so a crash can lose the last turn's lines. The Run page does not show them yet.

The bell reads the Bureau's notifications (COR-1941): a failed run and a run over its budget come from `bureau.notifications.list`, written by the Bureau for top-level runs only, so a run that fans out into children notifies once. Reading one in the bell marks it read in the Bureau (`bureau.notifications.markread`), so another browser agrees. The bell still derives what is waiting on you from the pending reviews, not from the Bureau's `review.waiting` notifications, because a decision made anywhere has to remove the row at once; the two describe the same wait, and the bell shows it once. The host keeps notifications for 30 days (`retention.notifications`, on the Settings page). It keeps settled webhook hook delivery records for 30 days too (`retention.hookDeliveries`, COR-1943); a pending delivery is never removed.

## The Workflows area

`/workflows` joins two services (`src/lib/workflow-catalog.ts`): the engine's catalog, which lists every workflow type it can run (`weft.workflows.definitions.*`), and the Bureau's workflow files (`bureau.workflows.*`, `src/lib/workflow-files.ts`). The Bureau's file `digest.json` is loaded by the engine as a source named `digest`, so the two are joined on that name. Five routes share one view, `workflows`, and one component, `src/routes/workflow-definitions/index.svelte`:

- `/workflows` lists the workflows a person can read, one flat row each. A row says what the workflow is for (the file's `description`, else the engine's), its kind (`Agent-authored` for every Bureau file, `Code` for a type code registered), the agent that owns a file (monospace), what starts it in words (`Every hour`, `On the signal deploy`, a code type's schedules), how many instances began in the last 24 hours and how many are running, when the last began, and a `Paused` chip. A file's trigger and counts come from `bureau.workflows.list` (`trigger`, and `runs` when the call passes `includeRuns: true`, counted from the engine's own totals; the schedules page's overlay does not ask, because each count reads the engine); a code type's from `weft.workflows.list` with `limit: 1` (its `total`) and its schedules, read apart from the list so a count the engine would not give is left out, never shown as zero. The types the Bureau registers itself to run agents, goals, and its heartbeat (`RUN_ENGINE_WORKFLOW_TYPES`) are not workflows a person starts, so they sit under a collapsed "Engine workflows (n)" disclosure. With none besides them the page says there are no workflows yet and where one is written (the host's `workflowDirectory`), and New workflow in the header opens `/workflows/new`. A file the Bureau cannot use is listed with its error, its issues, and its path, and a source that failed to load shows the category of its failure. A source the engine holds that has no file is a deleted file the engine has not yet forgotten, so it is left out and the list reads the same before and after a restart.
- `/workflows/new` is the JSON editor seeded with a template (a name, a description, a schedule trigger, one agent step), saved through `bureau.workflows.create`. The `name` in the text is the identifier and is not sent; one that is not an identifier, is taken, or is `new` (the address of this page, so a workflow called `new` could never be opened) is refused with the reason and nothing is written. A save lands on the new workflow's page.
- `/workflows/:type` leads with what a person acts on: what the workflow is for, what starts it and whether it is active, its steps (for a file), its last five runs (`bureau.workflows.runs.list` for a file, the engine's `weft.workflows.list` for a code type) with a link to all of them, and the schedules that start it: the active and the paused, never a cancelled generation (`weft.schedules.list` with `workflowType`). A file offers pause or resume, edit, delete, and send signal. A Details disclosure holds the file's path, its trigger as written, and what the engine's contract declares (signals, updates, queries, input and output schemas); a fact the workflow does not have is not a row, and a code type that declares nothing has no Details. A collapsed Engine disclosure holds the engine's revision panel and its install form (a code type), or the versions that have run (`bureau.workflows.revisions`, which does not list a version that was saved and never ran, and offers no activation; a file); a type the Bureau registers itself has none. An invalid file shows its problem and path, offers only delete and edit, and has no definition, runs, or status; one with no `hash` offers nothing.
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

`/audit` searches the Bureau's trail (`bureau.audit.query`) by a `since` time, a free-text `type`, and a resource sent as `runId`, which takes a run id or `schedule:<id>`, `session:<id>`, `agent:<id>`, or `workflow:<id>`. The host keeps the trail 90 days (`retention.audit`, replaced by a value stored on the Settings page), and the maintenance sweep prunes older records. Records come oldest first, as the Bureau returns them, and Load more follows `nextCursor`. The address holds the filters. `/audit` and `/goals` hold no console scope: the Bureau shows each caller what it owns, so owner scoping is the gate and a principal holding no scope sees its own records.

The Playwright suite runs a second host (`E2E_BUREAU_PORT`, `tests/e2e/e2e-server.ts`) whose console is the Bureau's own engine, because the main host's console is the fixtures' engine and cannot see a schedule the Bureau holds. The schedules specs for an agent run and a workflow file's schedule open it, and the specs for an engine schedule open the main host.

## Settings

`/settings` is the Bureau's runtime settings (`bureau.settings.get`, `schema`, and `update`), drawn from the schema the Bureau publishes, so a key it adds appears with no change here. Which control a key gets is read from the shape of its schema node (`src/routes/settings/settings-controls.ts`): a Cinder switch for a boolean, a select for an enum, an input for a string, a number input for a number; a select between the literals and a number input for each number of a union such as the retention windows; a switch and a JSON editor for `tools.humanInput`; and a JSON editor for any other object (`modelPolicy`, `engine.retention`, `engine.history`, `engine.payloadSize`). A shape nothing reads falls to the JSON editor, so no key is unsupported. Keys are grouped by their first segment, with `durable`, `maintenance`, `durableOwnership.ownership`, and `workflowVersion` under Durability. Each key says whether it applies live or needs a restart, and whether a stored value waits for one; a key the deployment locked (`HostOptions.settings.locked`, a map of key to reason; a local host locks none, and a remote one locks `durableOwnership.ownership`, `maintenance`, `durable`, and the workflow claim TTL and renew interval) is shown and disabled.

Save sends the keys that changed in one `bureau.settings.update` with the `expectedRevision` the page read; the Bureau applies all of them or none. A `StaleRevision` fault, or a read that finds the revision moved while there are unsaved edits, shows a prompt to reload, and a reload discards the edits. The page subscribes to `bureau.settings.events` over Server-Sent Events and reads the settings again on each event, and again when the window regains focus, which is how it catches up when the stream is down. Below the form the host's own paths (`/host/paths`) are shown read-only: they are the host's and not settings. Nothing about the page is persisted by the page; the Bureau keeps the record.

The Playwright suite locks `workflowVersion` on the main host to show a locked key against the real Bureau, and turns `tools.humanInput` off and on to show that a chat with `request-human-input` then asks nothing, and asks again (`tests/e2e/38-settings.spec.ts`).

## The journey

`tests/e2e/90-journey.spec.ts` is one Playwright journey through the application as the single local principal, with no sign-in. It is serial, with one `test()` per stage, and it runs last because of its number. Each stage builds on the ones before it:

- It chats with the `barrier` agent, sends a follow-up while the run is held, and sees the same run answer it.
- It starts from `/` and lands in the session it just made, starts a second session with the same agent from the agent's page, and returns to the first from `/chat`.
- It reloads while `request-human-input` waits on its question and answers it from `/reviews`.
- It defines an agent in the editor with the `workflows-create` tool, sets that tool to `never` in the agent's `toolApproval` through `bureau.agents.definitions.update` (a tool that changes something asks before each call by default, and nothing in the journey answers the inbox for it), and chats with it until it writes `journey-digest`, a workflow with a 5 second schedule.
- It opens the workflow from `/workflows`, waits until its schedule's fire is listed as a run, and opens that run at `/runs/:id`. A runs page that opens before the first fire says there are none, and asks again every five seconds (`recheckMs` on its view probe) until there is one, so the stage waits for the first row on the page itself.
- It follows the schedule's "Edit workflow" action from `/schedules`, changes the trigger to `1h` in the editor at `/workflows/journey-digest/edit`, and sees the one-hour cadence on `/schedules`, which also stops the 5 second fires for the rest of the run.
- It attaches an image to `echo-image`, sees `Echoed 1 image.` and the returned image decode.
- It chats with `echo-recall`, which stores the label it is sent as a memory. It sees that text on `/agents/echo-recall/memory`, corrects it, and sees a new chat answered with the correction and not the original.
- It starts a `barrier` task it never releases, reaches `/tasks/:id` from the chat's task link, cancels it, and sees `TASK_COPY.cancel['cleaned-up']`.
- It opens `/workers` from the sidebar's Engine group.

It opens a third host (`E2E_JOURNEY_PORT`, `tests/e2e/e2e-server.ts`) of its own, whose console is the Bureau's engine, as the second host's is, because the Workflows area can only show a fire of a workflow the Bureau's engine runs. The journey's host has a home of its own, with one provider so the editor can save an agent, and a barrier of its own, under `/journey` on the barrier's control port, so no run another specification leaves held changes what the journey counts. Every model is scripted and no provider key is read: the agents come in through the host's `extraAgents` (`barrier`, `echo-image`, `echo-recall`), and `createJourneyProviderResolver` (`tests/e2e/journey-agent.ts`) scripts the one agent the journey defines in the editor, so a first message that carries the journey's marker gets one call to `workflows-create` and then a fixed text, and any other first message gets the provider stub the other specifications use. The journey removes the agent and the workflow it writes, and forgets what `echo-recall` remembers, before it starts.

## Runs

`/runs` is one list of what the agents have done, in the words of a task: **Needs you**, **Working**, **Done**, **Failed**, **Canceled** (`TASK_COPY.states`, shown through `src/lib/task-status.ts`, which the chat's sentence about its runs, the list, and a run's page all use). Each row says which agent ran, what started it (a chat the Bureau still has, or a goal; a link either way), a line about how it stands (the question it waits on, its last words, or why it failed), when it started, and how long it took. It joins two sources (`src/routes/workflows/runs/run-rows.ts`): the Bureau's tasks (`bureau.tasks.list`, with each chat's title from `bureau.contexts.list`) and a goal's attempts (`bureau.goals.list`), because the Bureau does not make a goal's attempt a task. The Bureau records no link from a run to the schedule that started it, so a run a schedule started is listed without its origin. The title and the filters (status, agent, started by, when) are one bar, and the filters are the address's (`?status=`, `?agent=`, `?startedBy=`, `?since=`). The engine's own table of workflows is not here: it belongs to the Engine area, and `/workflows/:type/runs` still uses it.

`/runs/:id` leads with the agent and its status, then what started the run, with **Open chat** and **Cancel run** (after a confirmation) as buttons of one size. The Summary tab holds the answer rendered as Markdown (`bureau.tasks.events` carries it; the task view has none), the run's tool calls in the chat's style (`src/routes/chat/tool-calls.svelte`, read from the chat thread by `run-tool-calls.ts`), and, when the run needs a person, the decision itself under the waiting call: the same flat approval row the chat shows, or one text field for a question (`run-wait.svelte`). The Engine tab is the workflow page the engine has always had (payloads, tags, revision, its own Timeline, signals, updates, checkpoints, children, restart), at `?view=engine`. A run that is not a task (a goal's attempt started before attempts were tasks, COR-1868) is shown from its goal. `/tasks` goes to `/runs?startedBy=chat`, and `/tasks/:id` to `/runs/:id`.

- **Following** (`task-follower.svelte.ts`) keeps the last position the Bureau gave. A stream that drops or fails to open is opened again with that position in `Last-Event-ID`, after the shared reconnect backoff and at once when the browser reports it is back online. A stream the Bureau ends cleanly is not a drop, and the follower tells the cases apart: after a terminal status it is the end; a session run's stream, which the Bureau ends at the subscription route's time limit, is resumed from its cursor after one second; and a task started with `bureau.run()` streams one snapshot and ends while it is still going, so each snapshot is applied to the task the page shows, the page reads it every five seconds until it is over, and one more stream then collects its answer. A position and the answer are kept in `sessionStorage` under the task, so a reloaded page resumes from there. A snapshot's position (`-1`) names nothing to resume from and is never kept.
- **Cancelling** calls `bureau.tasks.cancel`. Each of the eight receipts has its own words (`TASK_COPY.cancel`). While the task's `cleanup` is `cancel-requested` or `cleanup-pending` the page reads the task every second, and says where the cleanup stands until it is final.

## Reviews

`/reviews` is everything waiting on the caller, as one to-do list, the longest-waiting first, with a badge beside the heading for how many. Each item is the question itself and its decision, inline (`bureau-review-item.svelte`):

- a **tool approval** is one flat row: the question, an optional note to the agent, Deny and Approve. The question is the tool's own sentence when it declares one (`metadata.summary` in Armorer, a template such as `Refund order {orderId} for {cents:usd-cents}`, which the policy writes into the approval's `message`), else the tool and its arguments (`src/lib/tool-text.ts`). Deny with a note is a rejection that carries the note for the agent; Deny without one is a plain denial. Details opens the arguments and what the policy evaluated (command, patch, files).
- a **question** is one text field and Send answer, answered through `bureau.tasks.respond`, with one line saying the agent continues with the answer.

Under each is one line: the agent, the chat it came from, how long ago, and a link to the chat (or to the run when there is no chat). The engine's pending human reviews (`client.listReviews`, read only when the principal holds `reviews:read`) follow in a section of their own, "Engine reviews", each with the engine's own decision form. There are no Decided or Timed out states and no Live toggle: the Bureau lists no review once it is resolved.

A decision whose outcome the Bureau could not write into the conversation (`APPROVAL_OUTCOME_NOT_WRITTEN`) took effect, and the page says so, in a dismissible alert above the list. The list, and the count in the navigation, ask again every five seconds and at once after each decision this application makes (`src/lib/review-queries.ts`). A chat that is already open reads the Bureau's pending reviews every three seconds while it waits on a person, and reads its thread again when a review it shows is no longer pending (`chat-session.svelte.ts`'s `refresh`), so a decision made here shows there with no reload. The view is `reviews` with no console scope: the console drops the Bureau's scopes, and a refused list is the frame's forbidden state.

## The shell

The sidebar is Cinder's `SideNavigationGroup` twice: a Primary group (Chat, Agents, Workflows, Settings, Runs, Schedules, Reviews) and an Engine group (Workers, Storage, System, Audit). Chat is the home screen, sessions live at `/chat/:sessionId`, and runs live at `/runs` and `/runs/:id` (see "Runs"). `/workflows` is the catalog of workflow definitions (see "The Workflows area" above), and `/audit` is the audit trail (see "Schedules, goals, and the audit trail").

Every view renders in a frame (`src/app/view-frame.svelte`) that is loading, empty, failing (Cinder's `ErrorState`, with a retry), forbidden, not found (for a view that opens one item by its address), or showing its content, and says which in `data-state` beside a `data-view` naming the view. Its words are in `src/app/copy.ts`, and its one request is in `src/app/view-probes.ts`. A probe whose empty answer is about to change by itself sets `recheckMs`, and the frame asks again that often while the view is empty and stops when it has something to show; the runs of a workflow type do, so a page opened before the first run shows it without a reload.

## Chat and agents

- `/` opens the session updated most recently (`src/routes/chat/chat-home.ts`), or `/chat` when there is none. The route's `redirect` replaces its own history entry.
- `/chat` lists the caller's sessions with `ChatConversationList`, newest first, with Load more paging and a New chat action. `src/routes/chat/session-summary.ts` maps a Bureau context to a row.
- `/chat/new?agent=:id` starts a session. The agent is a searchable `Combobox` above the composer, starting from `?agent=` or the default agent (`src/lib/default-agent.ts`, `assistant`); changing it replaces `?agent=`. The client names the thread, the first message starts the run, and when it has started the address becomes `/chat/:sessionId` by replacing the history entry, with the page kept mounted (`router.navigate`'s `keep`). `/chat/new` is registered before `/chat/:sessionId`. A first run that is refused stays on `/chat/new` with the row failed and a retry.
- `/agents` lists the agents the Bureau tells the caller of (`bureau.agents.list`: `kind`, `a2a`), with New chat for every agent. `/agents/:id` shows one agent's details (a file agent's model, tools and skills from `bureau.agents.definitions.get`), a New chat action, and the chats had with it.
- A session or agent the caller cannot see, or an unknown agent for a new chat, is `not-found`.

### Memory

An agent remembers across every chat the caller has with it. The host composes governed memory for the Bureau (`src/host/memory.ts`): records and the governance ledger in Bungalow's database, the default policy, and `createHashingEmbedder()`, a deterministic embedder that makes no network call, so memory works with no model provider configured. Each chat run stores its final answer under the Bureau's identifier, its owner of record (`anonymous:local` here), and the agent's identifier; a later chat with the same agent recalls it, and a chat with another agent does not. Memory stored before this keyed it by session and is not migrated.

`/agents/:id/memory` (`src/routes/agents/agent-memory.svelte`, linked from an agent's page) lists what the agent remembers, newest first, with a search that ranks every memory by relevance (ranking has no score floor, so an agent with no memory is the only way a search finds nothing). Its loading, empty, failing, locked, and not-found states are the Agents view's (`VIEW_COPY.agents`, by pattern). A memory's details show its source, trust, class, creation time, and chat from the record, and the run that wrote it and the memories it corrects or was corrected by from the governance ledger. Forgetting is a source deletion that words each state the deletion can answer with (completed, held by a legal hold, pending, failed, unknown); the host declares `not-retained` only for the targets it keeps nothing in, and leaves `durable-snapshots` pending because a copy of recalled text persists in the conversation. Correcting writes the person's words as an operator memory that replaces the old one, and words the Bureau's two refusals. The page needs the Bureau's `bureau.memory:read` scope, and changing memory needs `bureau.memory:write`; the host's one local caller holds both.

### The conversation

`/chat/:sessionId` (`src/routes/chat/`) is `@lostgradient/chat` over the Bureau's AG-UI mount. A session is a Bureau context, and its conversation id is the AG-UI thread id. `chat-session.svelte.ts` holds one session's state and its `createChatSessionController`; `run-wiring.ts` is the transport. A turn is a start (`POST /bureau/ag-ui/agents/<agent>/run`, read through `@ag-ui/client`), a resume that carries the user's decision on a tool approval together with the turn that opened the run (never a follow-up row), or an attach (`GET /bureau/ag-ui/threads/<thread>/run`) to a run the page did not start, which restores the transcript from the stream's snapshot. A message typed while the run is going is a follow-up: the controller sends it through `bureau.contexts.input` under the id of its own row. A turn's tool calls are one row each, folded to a line ("Used 2 tools · 1 needs you") when there are several; a call that needs a decision is never inside the fold, and its approval is one flat row directly under it with Deny and Approve (`tool-calls.svelte`, `tool-activity.ts`). The header says which agent, and one sentence under it says how the chat's runs stand and links to the run. A session the caller cannot see is `not-found`.

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
