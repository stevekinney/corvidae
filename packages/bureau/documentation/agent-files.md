# Agent files

Bureau loads agent definitions from Markdown files in a directory the host names (COR-1524). You create and edit agents by hand, or through `bureau.agents.create`, `update`, and `delete` (served over HTTP as `bureau.agents.definitions.*`, see [Operations](#operations)); either way the agent is a file. This follows how Claude Code, Codex, and OpenClaw keep agents: one file per agent, the body is the instructions, and the frontmatter describes everything else.

Bureau does not know where the directory lives. The host passes an agent source (`BureauOptions.agentSource`), usually `agentFileDirectory(path, { tools })` from `@lostgradient/bureau/sources`, and the Interborough host passes `agents/` under its home. See [Sources](#sources).

## A file

```md
---
name: Researcher
description: Finds and cites sources
model: anthropic/claude-sonnet-4-5
models:
  - anthropic/claude-sonnet-4-5
  - openai/gpt-4.1
tools:
  - lookup-order
skillDescriptors:
  - id: cite
    name: Cite
    description: Cites the sources it used
    tags: [research]
a2a: false
stepLimit: 25
retry:
  attempts: 3
  delayMilliseconds: 500
  jitter: true
compaction:
  enabled: true
  thresholdPercent: 80
references:
  - style.md
  - docs/glossary.txt
guardrails: default
costBudget:
  perRunUsd: 0.5
  perChatUsd: 5
  warnAt: [0.5, 0.9]
toolBudget:
  maxCalls: 20
  maxDurationSeconds: 120
toolApproval:
  lookup-order: never
---

You are a careful researcher. Cite everything.
```

The filename without `.md` is the agent's identifier, so this file is `researcher.md` and the agent is `researcher`. The identifier must match `^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$` and be at most 64 characters, because it doubles as a path segment; a file whose stem breaks either rule is `invalid` with `invalid-identifier`. Workflow files have the same cap. Only files ending exactly in `.md` count: dotfiles, `.MD`, `.markdown`, `.txt`, and directories are ignored. A symbolic link to a file is followed. A file larger than 256 KiB is invalid.

The frontmatter keys are:

- `name`: a display label, optional, defaulting to the identifier. It need not be unique.
- `description`: what the agent does, optional.
- `model`: required, written `<provider>/<model-or-alias>`, split on the first `/`. It must name a non-retired row in the deployment's model catalog (`bureau.models.catalog()`). A bare model name is not accepted, because it would be ambiguous across providers.
- `models`: optional, the models a session of this agent may be switched to through `bureau.contexts.steer`, each written `<provider>/<model-or-alias>` like `model`. A file agent is selectable: `model` is its default, `models` narrows the choice, and without it the deployment's model catalog is allowed. `bureau.agents.models` reports the list filtered to the rows the catalog holds, so an entry the catalog lacks is left out rather than making the file invalid. The list is checked when the file is parsed, never against the catalog: every entry is `<provider>/<name>`, non-empty and unique, the list is not empty, and it includes the default `model`, compared as the literal string the file wrote (an alias of the default does not count). A violation is `invalid-frontmatter`, with `problem.issues[].path` set to `models.<index>` for an entry and to `models` for the list. Changing the list changes the file, so the `definitionRevision` rises. An `update` that omits `models` removes it, as it does `tools`, whether through `BureauAgentCatalog.update` or `bureau.agents.definitions.update`; a client that read the list sends it back to keep it. A run's snapshot keeps the list its run started with.
- `tools`: a list of unique names from the deployment's tool catalog (the `tools` option of the agent source). Defaults to none.
- `skillDescriptors`: descriptive Agent Card skills (`id`, `name`, `description`, `tags`, and optionally `examples`, `inputModes`, `outputModes`), never executable skills. Ids are unique within the agent.
- `examples`: optional, a list of at most three non-blank strings, each at most 200 characters (Operative's `AGENT_EXAMPLE_LIMITS`, the bounds `createAgent` enforces), that show what a person might ask the agent, which a chat client offers as buttons on a new chat. `bureau.agents.list` carries them as `examples`. They never reach a run. Bureau reads them and does not write them: `bureau.agents.definitions.update` and `BureauAgentCatalog.update` keep the key in the file as it is, the way they keep any key they do not know, and a write that changes nothing else writes nothing. A value that is not such a list is `invalid-frontmatter`.
- `a2a`: a strict boolean, default `false`. It opts the agent into A2A, the agent-to-agent protocol: only an agent that opts in is served at `<publicUrl>/a2a/<id>`. To a caller holding `bureau.agents:read`, which the deployment's owner does, chat over AG-UI, `bureau.agents.list`, and `bureau.deployment.get` serve any ready agent whatever this says; a caller without it sees, starts over AG-UI, and schedules or sets goals for only the agents that opt in, and any other answers as an unknown name does (COR-1904). A persisted agent opts in by this key and nothing else: the `a2aAgents` allowlist of `createBureauHandler` governs code-defined agents only. See [The A2A opt-in](#the-a2a-opt-in).
- `stepLimit`: optional, an integer from 1 to 1000, the most steps one run of the agent may take (Operative's `maximumSteps`). Absent, Operative's default of 25 applies. A run that reaches it finishes with `maximum-steps`. A value outside the range, or one that is not an integer, is `invalid-frontmatter` with `problem.issues[].path` set to `stepLimit`.
- `retry`: optional, how a run retries a generate call that failed (Operative's `RetryOptions`). `attempts` (required, an integer from 1 to 10) counts the first call, so `1` retries nothing; `delayMilliseconds` (an integer from 0 to 60000, default `0`) is the wait between attempts; `jitter` (a boolean, default `false`) randomises that wait. Retry applies to transient provider errors only: a provider error with status 429, 500, 502, 503 or 504 is retried, and any other error (a 400 or 401, say) ends the run after its first call. Absent, a failed call is not retried. An out-of-range value, or a key other than these three, is `invalid-frontmatter` with the path `retry.attempts`, `retry.delayMilliseconds`, `retry.jitter`, or `retry`.

- `compaction`: optional, `{ enabled, thresholdPercent }`, whether a run summarizes its older messages as the conversation nears the model's context window (COR-1866). `enabled` is a required boolean. `thresholdPercent` is an integer from 50 to 95, the share of the agent's model's context window (`contextWindowTokens` of its catalog row) at which compaction triggers; absent, 80, Operative's own default. The agent reaches Operative as `contextManagement: { maxTokens, compactionThreshold, onCompact }`. A session switched to a model with a smaller window leans on Operative's overflow recovery, because the threshold is the default model's. A value outside the range, an unknown key, or a missing `enabled` is `invalid-frontmatter` with the path `compaction.thresholdPercent`, `compaction`, or `compaction.enabled`. See [Compaction](#compaction).
- `references`: optional, a list of at most 16 unique paths of documents whose text joins the agent's instructions (COR-1866). A path is relative to the agent file's directory and written with `/`; it may name a file in a subdirectory (`docs/glossary.txt`). It may not be empty, absolute, or have a drive letter, a backslash, a control character, or an empty, `.` or `..` segment, and no segment may start with a `.` (a dotfile); a path longer than 255 characters is refused. A bad path is `invalid-frontmatter` with the path `references.<index>`, a repeated path or a list over 16 `references`. See [Reference documents](#reference-documents).
- `guardrails`: optional, one of `default`, `tripwire` or `off`: how the agent's guardrails act when a detector fires. Both guardrails are Operative's shipped pair, a prompt-injection detector on the input and a PII validator on the reply. `default` runs them in validate mode: a flagged input is blocked, so the model is not called and the agent answers with a refusal, and a flagged reply is redacted, so its emails, phone numbers and keys become placeholders; the run goes on and finishes normally. `tripwire` runs them as tripwires: a hit stops the run with the finish reason `tripwire` and no reply is delivered. `off` runs no guardrails. Any other value is `invalid-frontmatter` with `problem.issues[].path` set to `guardrails`. The key is absent from a file that does not name one, and such an agent keeps running Operative's own default, which is the `tripwire` preset: `default` is a preset of its own, not the name of the absent key. The reply is checked after the model returns it, so a surface that streams the reply as it arrives can show text that a guardrail then redacts or stops.

- `costBudget`: optional, what one run of the agent may spend, in US dollars. `perRunUsd` (required, a positive number up to 1,000,000) is the limit; `perChatUsd` (optional, same range) is what a chat may spend across its runs, described below; `warnAt` (optional, up to ten fractions of it, each strictly between 0 and 1) lists where the run warns. The run's cost is Operative's per-run estimate, each request priced at its model's rate from the model catalog's own price rows (US dollars per million input and output tokens; where Operative's built-in table knows the model, its prompt-cache rates are kept, because a catalog row has none). After each step, a run that has spent `perRunUsd` finishes with the finish reason `budget-exceeded`, and its error says `perRunUsd` and the limit; the check follows the step that spent the money, so a run can end up to one step past the limit. A step that crosses a `warnAt` fraction shows one `budget.threshold` event in the run's activity (`operative.runs.events`, and the audit trail), with the `step`, the `threshold`, the `currentCost`, the `budget` and the `model`; a fraction is announced once per run, though a warning can repeat if the host crashes after it is sent but before the step is saved. `warnAt` may be written in any order and with repeats: the definition holds it ascending and without repeats, and an empty list is the same as none. The limit belongs to each run alone, and a durable run keeps its accumulated cost in its checkpoint, so a run recovered after a restart counts what it spent before it and does not, as a rule, announce a fraction twice. A step on a model a session was switched to is counted at that model's price. A model the catalog has no price in US dollars for is never counted at another model's rate (COR-1921): `bureau.contexts.steer` refuses a switch to it (`InvalidParams` naming `override` and the `costBudget`; the row judged is the one the switch runs, so a switch that names no provider is judged by the first allowed row serving the model, and `bureau.agents.models` marks such a model `unpriced: true`; a fork that would carry such a model answers the carry as `rejected` with `policy-denied`), and a step that still reaches one, such as a session switched before the file gained a budget, ends the run with `budget-exceeded` and an error naming the model, before the model is asked. An agent with no `costBudget` switches freely. A file whose `model` has no price in US dollars in the catalog is `invalid-frontmatter` with the path `costBudget`, on a scan and on a write alike, because a limit that cannot be measured cannot be enforced; a run recovered from a snapshot whose model has since lost its price cannot be rebuilt. A value that is not a positive number, a fraction outside 0 and 1, more than ten fractions, or a key other than `perRunUsd`, `perChatUsd` and `warnAt` is `invalid-frontmatter` with the path `costBudget`, `costBudget.perRunUsd`, `costBudget.perChatUsd`, or `costBudget.warnAt.<index>`. Absent, a run has no spend limit.

  `perChatUsd` (COR-1915) limits a chat, which is a session, across its runs, with each run priced as above. Bureau records what every run of a chat spent in a spend ledger (`bureau-chat-spend:v2:<session>:<incarnation>:<run>`, one record per run, each naming the chat's owner and the session incarnation; before COR-1933 the key was `bureau-chat-spend:v1:<session>:<run>`, and a `v1` record is no longer counted) after the run ends and before the session records how, so a crash between the two leaves a durable run's session still saying `running`, which recovery reattaches and replays into a ledger that already holds the record. A non-durable run has nothing to reattach: its spend is still recorded before its session is, but a crash in that window leaves a session that never learns how the run ended. When a run starts, Bureau reads the total of the chat's records: once it is at or above `perChatUsd`, the run finishes `budget-exceeded` at its first step, before the model is asked anything, and its error names `perChatUsd` and the limit. Only the next run is stopped: a run that is under way when the chat passes the limit finishes, and so does every run that started before the total was recorded, so two runs started together in one chat can take it past `perChatUsd` by what they spend. The ledger counts each run once however often a recovery replays its end, survives a restart, and ignores the records of an earlier chat with the same identifier (another incarnation); deleting a chat removes its records. A total that cannot be read refuses the run rather than start it unmeasured, with a `BureauError` coded `STORAGE_UNAVAILABLE` (the store's error is in its message and in a `chat-spend` diagnostic), and a record that cannot be written is diagnosed and leaves the chat's total short by that run. Two kinds of spend are never recorded, and the chat's total falls short by them: a run cancelled from another process (`cancelDurableRun` on a Bureau that does not hold the run, COR-1580) is ended by the canceller, which has no cost estimate, while the process that holds the run writes nothing for an outcome another engine committed (COR-1614); and a run that never reaches its terminal event, such as a non-durable run in a process that dies. A durable run that is recovered records its spend when it ends. Deleting a chat removes its records, and a record written after the deletion (a run that ended after it) is removed by the run that wrote it. The ledger counts the runs of a chat (`bureau.tasks.start`, including with a `contextId`); a schedule fire or a workflow's agent step is no turn of a chat, keeps `perRunUsd` and neither reads nor writes the ledger. The limit is read from the agent that starts the run, so each agent's file judges the whole chat's spend, and a run recovered after a restart is not asked again.

- `toolBudget`: optional, what one run's tools may use (COR-1915). `maxCalls` (a whole number, 1 to 100,000) is how many tool calls the run may make, and `maxDurationSeconds` (a positive number up to 86,400) how long, counted from the start of the run, its tools may be called; at least one is required. They become Armorer's `ToolboxOptions.budget` (`maxCalls`, `maxDurationMs`) on the toolbox Bureau builds for each run, so the counters belong to the run alone, and every call the run makes through its toolbox counts, Bureau's own tools included. The first call after a limit is reached is refused, the result row is kept, and the run finishes `budget-exceeded` with an error that names the limit (`Budget exceeded: max calls 20`). A value that is not a positive whole number or amount, a budget with neither limit, or a key other than these two is `invalid-frontmatter` with the path `toolBudget`, `toolBudget.maxCalls` or `toolBudget.maxDurationSeconds`. The counters live in the run's toolbox, in memory, so a durable run that is recovered after a restart starts them over: it may make `maxCalls` more calls, and its `maxDurationSeconds` counts from the recovery, not from the original start (COR-1933; the counters are not part of a run's checkpoint). Absent, a run's tools have no limit.

- `toolApproval`: optional, when each tool asks a person before it runs (COR-1913): a map from a tool name to `never`, `on-changes`, `always` or `blocked`. A tool the map leaves out is `on-changes`, so a file with no `toolApproval` asks before every tool that changes something. Each name must be one of `tools`; a name that is not makes the file `unknown-approval-tool`, on a scan and on a write alike. Any other value, or a map that is not a mapping, is `invalid-frontmatter` with the path `toolApproval` or `toolApproval.<tool>`. The values:
  - `never`: the tool runs without asking.
  - `on-changes`: a tool that reads runs, and one that changes something or is dangerous asks. A tool decides which it is by its `metadata`: `readOnly`, `mutates` or `dangerous`.
  - `always`: every call asks.
  - `blocked`: every call is denied. The model is told the tool was refused, and the run goes on.

  A tool that declares none of `readOnly`, `mutates` and `dangerous` cannot be told apart from one that changes something, so Armorer asks about it under `on-changes` and under `never` alike. Declare the metadata on every tool in the catalog, and a `version` on each tool that can ask: Armorer cannot issue an approval for an unversioned tool, so its call fails with an error the model sees and nothing parks. Bureau's own workflow and settings tools carry both. The values only tighten: the decision is the most restrictive of the one the file states and the one the toolbox's own `approvalPolicy` makes (`deny` over `ask` over `allow`, `combineApprovalStatuses`), so a tool set to `never` is still asked about where the toolbox says to ask, and a chat's permission mode (COR-1936, below) narrows them further. Only `allow-all` loosens anything, and only the asks `on-changes` raises. In a run that someone started (a chat, a task, a call to `bureau.tasks.start`), a call that asks stops the run on a pending approval, listed by `bureau.reviews.list()` as a `tool-approval` review with the tool's own words for what the call does (`metadata.summary`), and approving it runs the tool. An approval is signed with `BureauOptions.agentApprovalSecret`, which the host keeps across restarts: with it, a pending approval is restored after a restart and can still be approved. Without it the approval is unsigned, `reviews.resolve` refuses to approve it (`NOT_CONFIGURED`), and it can only be denied. A run nobody started has no one to ask: a workflow's `agent` step runs its agent with no requester, so an approval cannot be raised for it. A step in which a tool call needed one fails, with an error that names the tool, and the workflow instance fails with it; the change is not made, and no review is listed. A run that a restart finds already finished fails its step the same way, because the run's recorded result names the tool. A tool an unattended run uses to change something must therefore be set to `never` in the file's `toolApproval` (a tool set to `blocked` is denied in any run: the model is told so, and the step goes on without it). This holds for a code agent's tool that asks, too. A person who approves a call can allow its tool for the rest of the chat (`remember` on `bureau.reviews.resolve`, COR-1828). The grant lifts only an `on-changes` ask, so it never loosens a tool set to `always`, `blocked` or `never`, and it ends with the chat; see `external-control-plane.md`. `createToolApprovalHooks(toolApproval)` is the same rule as a policy hook for a toolbox you build yourself, which is how a code agent gets it; give it `remembered` to honour a grant, which only the toolboxes of file agents do by themselves. A code agent on the Bureau's own toolbox has no hook to honour one, and so is not granted, though a chat's permission mode still holds for it.

A chat also has a permission mode (COR-1936): `always`, `on-changes` (the default), `allow-all` or `read-only`, set with `bureau.contexts.steer`'s `permissionMode`, stored with the chat's steering (so it survives a restart and is carried onto a branch), and read back by `bureau.contexts.get`. It is read for each tool call, so a steer is in force from the next call after it is admitted. It holds for every tool of the chat's runs, whichever kind of agent holds it (COR-1947), because Bureau applies it to the toolbox each run calls through, so a code agent passes no option for it. A tool with a `toolApproval` setting, which is to say a file agent's listed tool or a tool of a toolbox built with `createToolApprovalHooks`, decides by these rules, the strongest first (`decideToolApproval`):

1. A tool set to `blocked` is denied.
2. In `read-only` mode every tool that is not read-only is denied, one that declares no capability and one with a remembered grant included.
3. A tool set to `always` asks every time, and a grant cannot loosen it.
4. In `always` mode every call asks.
5. A remembered grant skips an `on-changes` ask for that tool in that chat.
6. A tool set to `on-changes`, or to nothing, asks when it changes something, is dangerous, or declares nothing.
7. In `allow-all` mode that ask is skipped for a tool that declares what it does; a tool set to `always` or `blocked` is not touched, and a tool that declares nothing still asks.
8. A tool set to `never` runs without asking, unless a rule above applies or it declares nothing.

Every other tool of the run, a code agent's tool with no such hook and the tools Bureau adds included, is held to the mode alone (`decideChatPermission`): `read-only` denies a tool that does not declare itself read-only, `always` asks, and the other two leave the call to the toolbox, as it was without a mode. Bureau's own tools are classified for this. `scheduleWakeup` schedules work, so it is a change, and `always` denies it as well: it parks the step that called it and an approved call runs after that step, so no approval could run it, and the model is told so. `decide` asks a model and changes nothing but its audit record, so it is a read, and so are the skill tools (`activate_skill`, `deactivate_skill`, `load_skill_resource`), which change only which instructions the run itself holds. `requestHumanInput` stands outside the mode: it changes nothing, and it is how a run in `read-only` or `always` gets an answer. A tool that declares nothing cannot be told from one that changes something, so `read-only` denies it, and a tool with no `version` cannot be asked about, so in `always` its call fails with an error the model sees.

Modes only tighten, except `allow-all`, which skips the asks `on-changes` raises and nothing else. The default mode decides by the tool's own setting alone, so a tool set to `never` is not asked about in a chat on `on-changes`, and a run that belongs to no chat (a workflow step) is decided as that mode is. A child Bureau started, whether a file agent or a code agent, takes the mode of the chat at the root of its delegation chain at each of its tool calls: a child already running when its chat is steered is held from its next call, and so is a grandchild and a child detached from a parent that has ended. A child cannot be put to a person, so in `always` it runs no tool, reads included, and a call that `on-changes` would ask about is refused. A child that belongs to no chat is decided as a run with none is, and a read of the delegation chain that fails counts as `read-only`, like a mode that cannot be read. The mode does not reach two kinds of child. One is a child an agent's own `createSubagentTool` runs: Bureau never sees it and its toolbox is the one the host built. The other is a child whose agent is a hand-written runnable that exposes no run options (`OPERATIVE_RESOLVE_RUN_OPTIONS`), which Bureau can only call and so cannot put a layer on. Give such a child's toolbox its own policy, or start it through Bureau's child dispatch with an agent from `createAgent` or an agent file. A mode that cannot be read counts as `read-only`. The mode cannot loosen an `approvalPolicy` a toolbox applies by itself, and in `always` a call that policy also asks about is put to a person twice, once for each. A reusable grant answers only that policy: it cannot let through a call the mode denies or asks about, and is not spent on one. A toolbox used outside a Bureau reads no chat: pass `permissionMode` to `createToolApprovalHooks` there. A call is decided again when a person approves it, so one that was waiting when a chat went to `read-only` is denied. What `always` asks about can be approved only from a toolbox with an `approvalSecret`, as with any approval.

A guardrail that fires shows in the run's activity (`operative.runs.events`, and the audit trail): `run.guardrail` for `default`, which carries the `step`, the `guardrailName`, the `category`, the `phase` (`input` or `output`), the `confidence` and the `action` (`block` or `redact`), and `run.tripwire` for `tripwire`. Neither carries the flagged text or the guardrail's `detail`, which can quote it.

For `stepLimit`, `retry`, `compaction`, `references`, `guardrails`, `costBudget`, `toolBudget` and `toolApproval`, an `update` that leaves the key out keeps the file's value, as it does for `a2a`, and a file with no such key is not given one; `null` removes the key (an empty `references` list too), so `bureau.agents.definitions.get` answers `null` again. A snapshot written before the keys existed loads with none of them.

A file written for an earlier version of the format may carry keys it no longer knows (the offering flag it used to have, and `skills`, now `skillDescriptors`): Bureau ignores them like any other unknown key, leaves them in the file when it rewrites it, and does not read the old `skills` list as `skillDescriptors`.

Any other top-level key is allowed. Bureau ignores it at run time, leaves it out of the run's snapshot, and keeps it when it rewrites the file. The exported schema is `agentFileFrontmatterSchema`.

The body is the agent's instructions. Bureau passes it to the agent trimmed, and an empty body means no instructions.

YAML is read with `js-yaml` under the core schema, so a date-looking value stays text and no custom tag is evaluated.

## What is invalid

A file that cannot be used is still listed by `bureau.agents.list()`, with `state: 'invalid'` and a `problem` whose `code` says why. It never runs, `bureau.run` and `createRun` refuse it as an unknown agent, and it never affects another agent.

- `invalid-identifier`: the filename is not a valid identifier.
- `invalid-frontmatter`: a schema failure; `problem.issues` lists every one.
- `unknown-model`: not written `<provider>/<model>`, absent from the model catalog, or the host's `models.generate` could not set it up.
- `unknown-tool`: names a tool the tool catalog lacks; the message lists each.
- `unknown-approval-tool`: `toolApproval` names a tool that `tools` does not list; the message and `problem.issues[].path` (`toolApproval.<tool>`) name each. The definition is still readable, so an editor can fix it.
- `missing-reference`: a document `references` names does not exist, cannot be read, or is not valid UTF-8; `problem.issues[].path` is `references.<index>` and the message names the path.
- `reference-too-large`: a document is over 64 KiB, or the documents together are over 256 KiB.
- `shadows-code-agent`: the identifier is a key of `createBureau({ agents })`, or `bureau`, the default agent. Code always wins.
- `missing-frontmatter`, `invalid-yaml`, `not-utf8`, `file-too-large`, and `unreadable`.

## Reference documents

A `references` entry names a file beside the agent files, whose text becomes part of the agent's instructions (COR-1866). The text follows the file's instructions, each document under a heading that names its path, in the order the file lists them:

```md
You are a careful researcher. Cite everything.

# Reference documents

## Reference: style.md

Be brief.

## Reference: docs/glossary.txt

Order: a purchase.
```

A reference is read as UTF-8 text. A document may be at most 64 KiB (`AGENT_REFERENCE_SIZE_LIMIT`) and the documents of one agent at most 256 KiB together (`AGENT_REFERENCES_TOTAL_SIZE_LIMIT`), at most 16 of them. The catalog reads them through the agent source (`AgentSource.readSibling(path, { limit })`), which both `agentFileDirectory` and `agentObjectSource` implement: the directory source reads `<directory>/<path>` and the object source `<prefix><path>` (one listing for the size, one read). A source refuses a path that would leave its own location (`TypeError`) before it reads anything, whatever the caller; a symbolic link inside the directory is followed, as it is for an agent file. A missing, unreadable or non-UTF-8 document makes the agent `invalid` with `missing-reference`; one over a limit, `reference-too-large`. Each names the path. A write (`create`, `update`, a restore) that would leave a document unreadable is refused with that code and writes nothing.

**Every scan reads the documents again**, even for a file whose bytes did not change, because a document changes the agent without changing its file. While any agent has references the catalog also reads them again at the source's own poll interval (`AgentSource.referencePollMilliseconds`: one second for the directory source, `pollIntervalMilliseconds` for the S3 source, so 30 seconds in Interborough's remote mode) and rescans when one moved, because a source reports changes to agent files and not to the documents they name. A source that does not watch (`watch: false`) has no interval, the catalog does not poll, and the next scan reads the documents. A document added, edited or removed is seen within one interval. A poll does not fetch a document that did not change: the source stamps each document (the directory source by size, inode and modification time from one `stat`; the S3 source by the ETag in the one `LIST` it makes per document), and a document whose stamp is the one last read is not read again. A reference whose name ends in `.md` and sits directly in the agents directory is also listed as an agent file (and `invalid`, with no frontmatter); keep documents in a subdirectory or give them another extension.

The documents join the agent's **revision identity**. Editing a document raises the agent's `definitionRevision` and appends a saved version, though the file did not change. Bureau folds each document's SHA-256 into one identity hash (the file's hash, then each path and digest in the file's order); with no references the identity hash is the file's own, so an agent without references keeps every revision, version and snapshot it has. The revision record, a saved version's `hash`, and the key of a run's snapshot use the identity hash. `definitionHash` on a listing and the `expectedHash` of a write stay the SHA-256 of the file's bytes.

The `hash` of a saved version is the identity hash, which for an agent with references is not the hash of the file's bytes; `versions.restore` and `definitions.update` take the file's `expectedHash` as `definitions.get` returns it, and a version's `hash` sent there is a `StaleRevision`.

The text of the documents is kept where the run is, not in the definition: a run's snapshot (`bureau-agent-snapshot:v1:<id>:<identity hash>`) holds `referenceDocuments` (`path`, `digest`, `content`) beside the definition, so a run resumed after a restart is given the documents it began with even if they have been edited since. A saved version holds only the definition (its `references` paths) and `referenceDigests` (`path`, `digest`), never the text; an edit to a document alone gives `changedKeys` `["references"]`. A restore writes the version's `references` list back with the rest of the definition, and the documents are whatever those paths name when the file is read again; the `referenceDigests` of the version say what they were.

## Compaction

An agent with `compaction.enabled` summarizes its older messages with the deployment's **summarizer model**, not its own: the `context.summarizerModel` setting (`bureau.models.summarizer()`), a row of the model catalog. When the conversation passes `thresholdPercent` of the agent's model's context window, Operative calls the agent's `onCompact`, which asks the summarizer to compress the earlier messages (it keeps the four most recent verbatim) and replaces them with the summary.

An enabled `compaction` is only valid while a summarizer is configured. Without one the agent is `invalid` with `invalid-frontmatter` at the path `compaction`, and a write that enables it is refused the same way; `parseAgentFile` is pure and has no host input, so the check is the catalog's, not the parser's. The catalog checks again when the model catalog changes (a replace that removes or turns off the summarizer's row) and when the `context.summarizerModel` setting changes (`AgentFileCatalog.revalidate()`, which the Bureau calls), without the file changing and so without a new revision. A run in progress when the summarizer goes away does not fail: the summarizer is resolved when each compaction runs, so a compaction with none configured is skipped, reported once through the Bureau's diagnostics, and the run goes on with the conversation as it is. A run that resumes from a snapshot is rebuilt the same way, so it is not refused for want of a summarizer. A summarizer that is configured but fails ends the step as any failed compaction does.

## Wiring it in

```ts
import { createBureau } from '@lostgradient/bureau';
import { agentFileDirectory } from '@lostgradient/bureau/sources';
import type { GenerateFunction } from '@lostgradient/operative';
import type { Tool } from 'armorer';

declare const lookupOrderTool: Tool;
declare function generateFor(provider: string, model: string): GenerateFunction;

const bureau = await createBureau({
  agents: {},
  agentSource: agentFileDirectory('/home/me/.interborough/agents', {
    tools: { 'lookup-order': lookupOrderTool },
  }),
  models: { generate: (descriptor) => generateFor(descriptor.provider, descriptor.model) },
});
```

`models.generate` turns the catalog row a file's `model` resolved to into the `generate` it runs with. The host supplies it because the host holds the credentials. `agentSource` without it is refused with `BureauError` (`BAD_REQUEST`), so a model name is never silently ignored. If it throws, that file is `invalid` with `unknown-model`.

## Sources

The directory is one implementation of a `DefinitionSource` (COR-1702). Bureau keeps parsing, frontmatter validation, model and tool validation, snapshots, revisions, and the write-through operations; a source only holds bytes:

```ts
import type { DefinitionEntry, DefinitionSourceChange } from '@lostgradient/bureau';
import { SourceConflictError } from '@lostgradient/bureau';

declare const entry: DefinitionEntry;
declare const change: DefinitionSourceChange;
declare const conflict: SourceConflictError;

// `entry.hash` is the SHA-256 hex of `entry.bytes`, computed by the source.
export const identifier: string = entry.id;
export const added: string[] = change.added;
export const actual: string | null = conflict.actualHash;
```

An agent source also reads the documents an agent file's `references` name: `readSibling(path, { limit, unlessStamp? })` resolves to `{ kind: 'found', bytes, stamp? }`, `{ kind: 'unchanged' }` (only for an `unlessStamp` that is still the document's stamp), `{ kind: 'missing' }` or `{ kind: 'too-large', size }`, and refuses a path that would leave its own location with a `TypeError` before it reads. `createBureau` refuses an `agentSource` that has no `readSibling`. See [Reference documents](#reference-documents).

`load()` returns every definition the source holds. `watch(listener)` reports changes made outside Bureau. `write(id, bytes, { expectedHash })` creates (`expectedHash: null`) or replaces a definition, and `delete(id, { expectedHash })` removes one; each compares the definition's current hash with `expectedHash` as late as the source can and rejects with a `SourceConflictError` carrying `id`, `expectedHash`, and `actualHash` (`null` for a definition that does not exist) when they differ, writing nothing. Bureau calls `load()` after its own `write` and `delete`, so write-through never waits on `watch`, and a `watch` report of the same change is a no-op because a rescan is idempotent. `bureau.agents.refresh()` calls `load()`. A source may attach a `problem` to an entry instead of bytes (a file over the size cap, a file that could not be read); the definition is then listed as `invalid`.

`agentFileDirectory(path, { tools, watch?, watchFactory? })` is the directory source: `fs.watch` is the trigger, a once-a-second rescan backs it up, files over 256 KiB are not read, only `*.md` files count, and a write goes to a temporary dotfile renamed into place. `watch: false` means no `fs.watch` and no poll, and a change is picked up by the next `load()`. `watchFactory` replaces how a directory is watched, for a test. It lives in `@lostgradient/bureau/sources`, apart from the main entry, because it needs Node's file system. There is no `path(id)`: a host that shows where a file lives computes the path itself.

`agentObjectSource(location, options)` is the S3 counterpart, for a deployment whose definitions live in a bucket. `location` is `{ bucket, prefix }`: every `*.md` object directly under the prefix (`agents` and `agents/` mean the same folder) is an agent named by the key minus the extension, and nested keys, dotfiles, and other extensions are ignored. `options` takes `client`, a `Bun.S3Client` the caller builds (Bureau reads no environment and never sees a credential), `tools`, `pollIntervalMilliseconds` (default 1000), `watch` (default `true`; `false` means no poll, and a change is picked up by the next `load()`), `runtime`, and `diagnose`. It is Bun only. An object store has no change feed, so the poll is the whole watch: each tick lists the prefix (following continuations), reads only the objects whose ETag changed, and tells the listeners, with empty lists when nothing changed. `hash` and `expectedHash` are still the SHA-256 of the bytes; the ETag is used only as the condition on a change. A write reads the object, checks its hash, and sends that read's ETag as `If-Match` (`If-None-Match: *` to create) on a presigned request, because `S3Client.write` ignores a conditional header; a delete sends `If-Match` the same way. A store has to honor that header on `DELETE` for the delete to be conditional: the store COR-1759 probed (a Railway bucket) does, but AWS S3 honors `If-Match` on `DELETE` only for directory buckets, so on a store that ignores it the delete is unconditional and only the hash check just before it protects it. A refusal (`412`, or `404` for a key that vanished) reads the object again and rejects with a `SourceConflictError` whose `actualHash` is the hash of what is there now, or `null`. Like the directory source, it lives in `@lostgradient/bureau/sources`.

```ts
import { agentObjectSource } from '@lostgradient/bureau/sources';

declare const client: Bun.S3Client;

export const agentSource = agentObjectSource(
  { bucket: 'my-definitions', prefix: 'agents/' },
  { client, tools: {} },
);
```

A file agent runs exactly as a code-defined one does. `bureau.tasks.start('researcher', input)` accepts any string name (a second overload of `start`, which resolves to an untyped `TaskHandle`) and runs it as a task in a context, resolving the same options, tools, and instructions. It is refused with `NOT_FOUND` for a name that is not a ready agent.

`bureau.agents` keeps `names()`, `entries()`, `query()`, `get()`, and `has()` typed to the code-defined map. The combined view is `list()`: code agents first in definition order, then file agents by identifier, each with `id`, `source`, `state`, `name`, `description`, `a2a`, `owner`, `definitionHash`, `definitionRevision` (see [Revisions](#revisions)), for an invalid file, `problem`, and, for a plugin's agent, `plugin` (see [Plugin layers](#plugin-layers)).

Every file agent belongs to the deployment's owner of record, `anonymous:local` in single-user mode. A file has no owner field, and an `owner` key in the frontmatter is just an unknown key.

## Plugin layers

A plugin ships agent files too (COR-1873). `agentFileDirectory(path, { plugin: 'linear' })` makes a plugin's directory a read-only layer: each `<name>.md` in it is listed as `linear:<name>`, and an owner's file stem still has no colon, so an owner file can never claim a plugin's identifier. `agentSource` takes a list of sources and layers them with `layeredAgentSource` (from `@lostgradient/bureau/sources`): the owner's sources come first, in the order given, and each plugin's layer sits beneath them. Two layers of one plugin, or an empty list, are refused with `BureauError` (`BAD_REQUEST`).

```ts
import { agentFileDirectory } from '@lostgradient/bureau/sources';
import type { AgentSource } from '@lostgradient/bureau';

export const agentSource: readonly AgentSource[] = [
  agentFileDirectory('/srv/agents'),
  agentFileDirectory('/srv/plugins/linear/agents', { plugin: 'linear' }),
];
```

A plugin's agent lists with `plugin` set to the plugin's name (`plugin` on the wire, `null` for every other agent). Its file reloads when it changes, as an owner's does, because the layer watches through its directory. Every write is refused: `create`, `update`, `delete`, and a version `restore` of a `plugin:name` throw `AgentFileError` `agent-file-read-only` (HTTP `Unprocessable`), and the layer itself rejects a write that reaches it with a `SourceReadOnlyError`. A plugin's `references` are read from the plugin's own directory.

`bureau.agents.duplicate('linear:triager', { savedBy? })` copies the agent into the owner's first source as `triager.md`, an agent the owner can edit. Files float: a tool the plugin's file names with a pinned version, `linear:create-issue@1.2.0`, is written unversioned, `linear:create-issue`, so the copy uses whichever version is loaded; `toolApproval` keys are unversioned the same way. The copy is checked like any write, and refused with `agent-file-exists` when the owner already has the name and `agent-file-has-references` for an agent whose `references` name documents beside the plugin's files, which the copy could not read.

## Watching

Bureau watches the directory, so adding, editing, or deleting a file takes effect without a restart. `fs.watch` is only a trigger: any event marks the catalog dirty, and one single-flight loop rescans the whole directory until nothing is dirty. Bursts coalesce, and since a rescan is idempotent it does not matter whether a change arrived as an edit, a rename into place, a delete, or the directory disappearing. There is no debounce interval. `fs.watch` can drop an event (on macOS a directory's creation went unreported in about one of two hundred runs of a test that made the directory and a file in it back to back), so a rescan every second backs it up; it reports nothing when nothing changed, and it bounds how long a change the watcher missed can go unseen. A directory that does not exist is an empty catalog, and its nearest existing ancestor is watched until it appears. A file read half-written may be transiently invalid, but it often is not: a file torn at a point where the frontmatter and a prefix of the body still parse is a valid agent, which Bureau lists, could run, and gives a revision of its own, and the completion of the write triggers the rescan that replaces it with another. Write a hand edit to a temporary file in the same directory (a dotfile is ignored) and rename it into place, as Bureau's own writer does, so no scan reads a half-written file.

`bureau.agents.onChange(listener)` is called after every rescan that added, changed, or removed an agent, with the identifiers, and `bureau.agents.refresh()` rescans now. A host that replaces the model catalog after the Bureau exists calls `refresh()`, because a file's model is revalidated when a scan sees the catalog's revision change.

## Revisions

A file agent's external identity is its name and its `definitionRevision`, so a client that fences on the revision has to see every change to the file. The revision of a ready file agent is 1 on its first sighting and rises by one every time the file's content (its SHA-256) changes. Editing the file by hand, and `update` both change it; a model catalog change that points an alias at another model does not, because the file did not change. Content that returns to an earlier hash still raises it: the revision counts changes, not distinct contents. An invalid file has no revision (`definitionRevision` is absent from its listing and `null` on the wire).

Bureau keeps one record per file agent under `bureau-agent-revision:v1:<id>`, as JSON in this key order: `{"revision":<n>,"hash":"<sha-256 of the file's bytes the revision was raised for>"}` (for an agent with `references`, the identity hash that also folds in the digest of each document; see [Reference documents](#reference-documents)). Each rescan, after the files are evaluated and before `refresh()` resolves or `onChange` fires, reads the record of every ready file (one read per ready file per rescan; it writes nothing when the record already describes the file), so a catalog that missed another process's edits reports the record's revision on its next rescan (a catalog writes a new revision only from a reading it can trust is current: when the record describes other content and the file still has the content this catalog itself last recorded, the scan may have read the file just before a peer's edit, so the write waits one rescan; each distinct record hash buys one such wait). A catalog that has recorded nothing yet, on its first rescan after a start, has no last-recorded hash and writes at once, so the revision it lists always names the content it lists it with: a change made while the Bureau was down is listed at a new revision on the first refresh. The one known property is a narrow race on that first rescan: if a peer records an edit between this catalog's first read of the file and its read of the record, the catalog can count that edit twice. A revision is only ever raised that way, never lowered. A rescan that finds only the revision changed reports the file in `onChange`'s `changed`. The hash in a record is a SHA-256 in lowercase hex; a record with any other hash is malformed. A file whose hash differs from the record's has `revision + 1` and the new hash written, on condition that the record is still the exact text that was read; a store with no record reads as a first sighting and writes revision 1 on condition that the key is absent. The condition makes it safe across processes: two Bureaus on one store that see the same change produce one increment and report the same revision, and a writer that loses the race reads the winner's record and reports its revision. Deleting a file leaves its record, so recreating the identifier continues from the last revision.

The revision is the agent's generation profile revision (`createAgent` takes an optional `revision`, 1 when absent), so every reader that reports `definitionRevision` reports the persisted one: `bureau.agents.list` (HTTP), `bureau.agents.definitions.get` and `list`, the recovery record of a `bureau.run` run, and the metadata of a session run (`lastAgentRevision`). A run keeps the revision it started with: a run resumed after a restart is rebuilt from its snapshot with the revision it recorded, not the revision the file has reached since. A snapshot is keyed by content, so the revision is recorded with the run: in its recovery record (`definitionRevision`) and, for every run of a file agent, in an optional `definitionRevision` on its reference `bureau-agent-run:v1:<runId>`, filled once and never changed by a later hold. A session run restored after a restart reads the revision from its own reference; a reference written before the field existed has none, and falls back to the session's metadata (`lastAgentRevision`), which names the session's latest run's revision only.

A record that cannot be read or written, or that is not a valid record, never makes the agent invalid and is never replaced (replacing it would write revision 1 over a higher one). The agent stays listed at the last revision this Bureau knew, or 1 if it knows none, a diagnostic names the agent (once when the failure begins or the file changes, not on every rescan that finds the store still down), and the next rescan tries again. While the store cannot be read, an agent can therefore report a lower revision than the store holds; it cannot record runs then either.

## Saved versions

The snapshots below keep a definition only while a retained run references it, and only if a run ever started on it. The versions of an agent are a separate history of what was _saved_, independent of runs: `bureau.agents.versions.list(id)` returns them newest first, and `bureau.agents.versions.restore(id, revision, { expectedHash, savedBy })` writes one back.

Whenever the revision of a ready file agent is raised, Bureau writes one version under `bureau-agent-version:v1:<id>:<revision>`, as JSON in this key order: `{"revision", "hash", "savedAt", "savedBy", "owner", "definition", "referenceDigests"?, "changedKeys"}`. The version is set in the same conditional batch as the revision record, so a crash or a lost race leaves both unwritten or both written, and two Bureaus on one store that see one change write one version. A save through the writer (`create`, `update`, or a restore) records the caller's owner string in `savedBy` (the anonymous local owner when the caller states none); an edit made to the file by hand and found by the watcher records `savedBy: null`. `owner` is the agent's owner of record, kept on every record so a release with several users does not have to migrate this family. `definition` is the parsed definition (validated on read like a snapshot); `changedKeys` lists the keys that differ from the previous version's in the definition's own order (`name`, `description`, `model`, `models`, `tools`, `skillDescriptors`, `a2a`, `stepLimit`, `retry`, `compaction`, `references`, `examples`, `instructions`), so a change to the instructions alone is `["instructions"]`, and a change to a reference document alone, its path unchanged, is `["references"]`. A first version, or one whose predecessor is not stored (a revision raised before versions were kept), lists every key the definition has. A record never holds reference documents' contents: `referenceDigests` (`path` and `digest`, in the file's order) is present for an agent with references and absent otherwise.

Bureau keeps 50 versions per agent. The batch that writes the 51st also deletes the lowest revision that no retained run references (compared as numbers), so a version a retained run references is kept even when it is the oldest, and an agent whose old runs are all retained can hold more than 50. Which revisions are referenced is read just before the batch and is not part of its condition; a run cannot start on a revision older than the current one, so the only race is a reference dropped in between, which keeps one version a little longer than needed.

`restore` reads the version, then calls `update` with its definition, so it is a save like any other: the file moves to a new revision and a new version equal in content to the one restored is appended, saved by the caller, and the older versions stay. It fails with `AgentFileConflictError` (HTTP `StaleRevision`) when the file no longer hashes to `expectedHash`, with `AgentFileError` `unknown-model`, `unknown-tool`, `missing-reference` or `reference-too-large`, or `invalid-frontmatter` for compaction with no summarizer (HTTP `Unprocessable`), when the old definition no longer resolves against the deployment, and with `agent-version-not-found` (HTTP `NotFound`) when no such version is stored; each writes nothing. Restoring the definition the file already holds writes nothing. `examples` are not part of what a caller supplies, so a restore leaves the file's as they are. The `references` list is part of the definition and is restored; a document is not, and is whatever its path names when the file is read again.

## Writing

`bureau.agents.read(id)` returns the file's text and `hash`, the SHA-256 of its bytes. `create(id, definition)`, `update(id, definition, { expectedHash })`, and `delete(id, { expectedHash })` write through the same files. Each checks that the result would load (schema, identifier, model, tools, code names, and that the host's `models.generate` can set the model up) and writes nothing otherwise, throwing `AgentFileError` with the codes above.

A write goes to a temporary dotfile in the same directory and is renamed into place, so nothing reads half a file. Writes are serialized in this process. `create` throws `AgentFileConflictError` (`agent-file-exists`) when the file exists. `update` and `delete` throw it (`agent-file-changed`, with `currentHash`) when the bytes no longer hash to `expectedHash`, and `AgentFileError` (`agent-file-not-found`) when the file is gone.

`update` keeps the body byte for byte when the supplied instructions equal it, and a frontmatter whose meaning does not change keeps its original text. When the frontmatter does change, Bureau replaces the lines of the keys it knows (`name`, `description`, `model`, `models`, `tools`, `skillDescriptors`, `a2a`, `stepLimit`, `retry`, `guardrails`, `costBudget`, `toolBudget`, `toolApproval`) and keeps every other line, comments included, byte for byte, so an unknown key keeps its value and its YAML type for other tools: a quoted `created: '2024-01-01'` stays a string and an unquoted date stays a date. Bureau reads the rewritten frontmatter back and requires it to hold exactly the keys and values asked for. If it does not (a quoted key, say, which a line edit does not recognise), the whole frontmatter is re-emitted with `js-yaml`, which keeps values and types but drops comments and layout. An update that changes nothing writes nothing. An update or delete of a symbolic-linked agent file replaces the link with a regular file and leaves its target alone.

There is no cross-process file lock. A different process writing the same file in the instant between a write's last check and its `rename` is not detected, because `rename` replaces whatever is there and, for `create`, cannot refuse an existing target. The window is the time between two system calls.

## The A2A opt-in

An agent opts into A2A when its file says `a2a: true` and the file is `ready`; an `invalid` file is not an agent, so it never opts in. Turn it on or off with `update` (or by hand). One rule holds for `BureauAgentCatalog.update` and the HTTP operation `bureau.agents.definitions.update` alike: an `update` that leaves `a2a` out keeps the file's value, and a file with no `a2a` key is not given one, so a caller that rewrites a definition cannot turn the opt-in off by omitting it. (This differs from `tools` and `models`, which an `update` that omits them removes.) A file with no `a2a` key is `false`; `create` writes `a2a: false` unless it is told otherwise.

A code-defined agent opts in through the `a2aAgents` allowlist of `createBureauHandler` alone, and `update` and `delete` refuse it as not found before reading any file. `bureau.agents.definitions.get` and `list` report `a2a` from whoever opts the agent in: the allowlist for a code-defined agent, the file for a persisted one. `bureau.agents.list` (the HTTP operation) reports the same `a2a` on every ready agent to a caller holding `bureau.agents:read` and lists only the opted-in ones to any other, and `bureau.deployment.get`, which requires that scope, names them all.

The opt-in decides only what the A2A mount serves; it does not decide who can chat with an agent. The AG-UI mount starts a run of any ready agent for a caller holding `bureau.agents:read`, and of an agent that opts in for any other (COR-1904), and a run that is waiting for an answer can be resumed after its agent is deleted. This part records and exposes the opt-in; the A2A mount reads it on every request (COR-1819).

## Operations

`createBureauHandler` serves the same files as `bureau.agents.definitions.*` and `bureau.agents.catalog`, under the scopes `bureau.agents:read` and `bureau.agents:write` (see [the control plane](./external-control-plane.md)). `bureau.agents.catalog` reads `bureau.models.catalog().descriptors` unfiltered, each row reduced to the `general` audience, and `bureau.agents.tools()` (the deployment's tool catalog, by name with each description and a `shortDescription`: the tool's `metadata.shortDescription`, one line for a person, or `null` when it declares none; and, since COR-1818, each tool's `inputSchema`, capability `tier`, `defaultApproval`, `source` and `users`, the identifiers of the agents that use it). `bureau.agents.detail(id)` is what `definitions.get` serves: the listing fields, the file's exact text, and its parsed definition, read from disk now so the hash, the text, the state, and the `definitionRevision` describe the same bytes: a file that changed since the last rescan is settled (rescanned) first, so its new text is never served at the previous revision. Every write the operations make that changed a file is appended to the audit trail as `agent.created`, `agent.updated`, or `agent.deleted`, filed under the `runId` `agent:<identifier>` and attributed to the caller. A Bureau with no persistent storage keeps no durable audit trail and records nothing. `bureau.agents.detail(id)` of a code-defined agent has no file: it returns `codeDefinition` (the agent's `instructions`, `model`, `tools`, executable `skills` and `skillDescriptors`, read from the agent object), which a client shows read-only and can duplicate into a file agent.

## Snapshots

A run uses the definition it started with. When a run of a file agent starts, Bureau stores the parsed definition in its database under `bureau-agent-snapshot:v1:<id>:<hash>`, where the hash is the file's (the identity hash, for an agent with `references`, which also keeps their text), and ties the run to it with `bureau-agent-run:v1:<runId>`. The run records the hash (`agentDefinitionHash` in a `bureau.run` run's recovery record, `lastAgentDefinitionHash` in a session run's metadata), and the snapshot is written before the record that names it.

A switch (`bureau.contexts.steer`) reaches the provider call through the agent's generate, which picks each step's model from that step's own steering: the model the session was switched to, or the default. A model that is no longer usable when a step runs (a hand edit has dropped it from `models`, the catalog has retired it, or `models.generate` now throws for it) fails the step with a `ModelOverrideUnusableError` naming the model. It never falls back to the default, and `bureau.contexts.get` keeps reporting the override.

Editing or deleting the file mid-run does not change the run, because the agent object was built from the snapshot's values. A run resumed after a restart is rebuilt from the snapshot, with the model and tools resolved against the catalogs as they are now, even if the file is gone. A snapshot that was pruned fails the resume with `AgentSnapshotError` (`snapshot-missing`), and a model or tool the deployment no longer has fails it with `snapshot-unresolvable`. Neither falls back to the current file.

`bureau.agents.revisions(id)` lists the snapshots that have run for an identifier, most recently run first.

A snapshot is kept while any run that references it is retained, and pruned after the last one's retention ends:

- A reference is written only once the run is this execution's. A run with a minted identifier ties itself to its snapshot at once. A child or a goal attempt, whose identifier is claimed first, ties itself only after it wins the claim; a start that loses the claim, or fails, leaves the winner's reference alone and drops a snapshot nothing holds.
- A session run's reference goes when its task is deleted (the `run.removed` event, which task retention triggers), or when its session save fails before the run exists.
- Any run's reference also goes once it has been settled for longer than `BureauOptions.retention.tasks` (default 30 days; `'forever'` prunes nothing). The durable maintenance pass does this. It is what releases a `bureau.run` run, which leaves the run store the moment it settles and was never subject to task retention before. Those runs now have a snapshot retention window equal to `retention.tasks`.
- A run settles its reference as it ends: a fresh run through its handle or the store, a recovered `bureau.run` run through the recovery branch. The maintenance pass also reconciles every open reference against the durable engine. A run the engine says has ended is settled at its end time. A reference with no run behind it, once it is ten minutes old, belongs to a start that failed and is released. A run still active, or one this process is driving, is left alone.
- A run that has not settled keeps its snapshot indefinitely, because it may still be resumed.
- A snapshot read back is validated against the definition schema, with the defaults a later field would need. One that is not valid fails the resume with `snapshot-unresolvable`.
- Pruning is not atomic across Bureau instances that share a store: one can list the references while another records a run on the same definition, and the first can then delete the snapshot. Agent files support one Bureau per store, which is how Interborough runs.

## Limits

- The steering agent-identity override still validates against the code-defined map only. A file agent is not a steering target.
- Writes are not safe against another process editing the same file (see Writing).
- Per-user directories and Git history of the directory are out of scope.
