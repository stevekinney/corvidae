# Models, agents, and sessions

A mod can make side requests to a model, start and observe subagents, message other sessions, and read the conversation. Each of these has a narrow contract, and treating one as another produces confident wrong results: a model's opinion presented as a check result, a queued message presented as finished work, an agent id presented as a link.

## Choose the mechanism

| Mechanism | What it sends | Tools | Billing and accounting | Result | Use for |
| :-- | :-- | :-- | :-- | :-- | :-- |
| `$.model.complete` | Your `prompt` and optional `system`, no history | None | The session's credentials; outside the session's cost totals, so count `usage` yourself | `ModelCompleteResult` | Small self-contained jobs: classify, summarize, rewrite |
| `$.model.fork` | The main thread's last request, then your `prompt` | The session's tool definitions, every call denied | Counted in the session's cost and token totals | `ModelForkResult` | A question about the conversation as it stands |
| `$.model.classify` | `text` with a fixed classifier prompt | None | Through `$.model.complete`, so outside the totals | One of your labels, or `undefined` | Choosing among a few known labels |
| `$.agent.spawn` | A subagent's own prompt and agent type | The agent type's tools, under the permission chain | Counted like any subagent | `{ agentId, model }` now; its answer arrives as its `turn.complete` | Work that needs tools and several turns |
| `$.session.send` | A plain-text message to another session, subagent, or teammate | The receiver's | The receiver's | `{ isDelivered }` once queued | Coordination with a session that already exists |
| An Agent SDK application | Whatever the application runs, outside Claude Code's process | The application's | The application's | The SDK's | Executions you start, supervise, and end yourself |

## `$.model.complete`

The request takes `model` (an alias such as `haiku`, or a full id), `prompt`, and optionally `system`, `maxTokens` (1,024 by default, up to 64,000 or the model's limit), `effort` (`low`, `medium`, `high`, `xhigh`, or `max`), and `timeoutMs`. A second argument `{ signal }` takes the mod's own `AbortSignal`. The request carries no tools, no history, and no project context, and the system prompt begins with Claude Code's attribution block ([mods API page](https://code.claude.com/docs/en/plugins/mods/api)).

The call always resolves with a result and rejects only when Claude Code refuses to send the request, such as for a blocked model or a bad cap. Check `isAnswered` first:

| Result | Fields |
| :-- | :-- |
| `{ isAnswered: true }` | `text`, `usage`, `effort` |
| `{ isAnswered: false, reason: 'api-error' }` | `status` (HTTP, or `null`), `error` (the kind, never the provider's text), `usage` |
| `{ isAnswered: false, reason: 'empty-reply' }` | `usage` |
| `{ isAnswered: false, reason: 'aborted' }` | `usage`. Either `timeoutMs` elapsed, the signal aborted, or the dispatch that made the call was abandoned |

`usage` has the API's `input_tokens`, `output_tokens`, `cache_read_input_tokens`, and `cache_creation_input_tokens`. For prompt caching, pass `prompt` (or `system`) as an array of `{ text, cache? }` blocks and mark the last static block `cache: true`. Put shared static text at the start of `prompt` rather than in `system` for a mod other people run, because on Bedrock, Vertex, Foundry, and gateways the attribution block varies with the start of the prompt. The API takes four breakpoints, and a fifth comes back as an `api-error` with status 400. Arrays of blocks need 2.1.292 or later.

## `$.model.fork`

`$.model.fork({ prompt, effort? })` resends the main thread's last request (its model, system prompt, tools, and messages) with `prompt` as one more user message, so the API can serve the prefix from the prompt cache. The model sees the tool definitions and earlier tool results but cannot call a tool: every tool is denied. A fork is one request, not a child session, a subagent, or a filesystem snapshot, and it leaves the conversation unchanged.

- **Results**: the same arms as `complete`, plus `nothing-to-fork` before the first request and right after `/clear`. `aborted` means the turn whose hook forked was interrupted.
- **Effort**: a fork thinks as hard as the session does, which at `max` can take a minute for a one-line answer. Pass `effort: 'low'` for a quick side job. On models where effort is one setting of the whole request, a level other than the main thread's writes the whole conversation to the cache again on the first fork at that level. That write is billed and waited for.
- **Shared assumptions**: a fork reads the same context as the main thread, so it shares its framing and its mistakes. It is a poor independent reviewer of that conversation (Recommendation).

## `$.model.classify`

`$.model.classify(text, labels, { model? })` picks one of two or more labels with one completion, using the engine's small fast model unless `model` names another. It resolves to the label, or `undefined` when the answer named none of them. It rejects when the request fails, is aborted, or comes back with no text. It returns no confidence score and no structured output. `text` is treated as data, but a classifier is still a model: never use its label as an access-control decision (Recommendation).

## Using model calls well

Model calls cost the person's usage, so make each one earn it (Recommendation):

- **Facts first**: read facts from the APIs that hold them instead of asking a model. Context fill comes from `$.session.usage()`, agent status from `$.agent.list()`, a branch from `$.process.run(['git', 'branch', '--show-current'])`, and check results from the CI system.
- **Deliberate triggers**: call a model from a command, a button, or a bounded event such as one `turn.complete`. Never call one from a render hook or on every tool call.
- **Small requests**: keep requests small and repeatable. Set `maxTokens` and `timeoutMs`, use `effort: 'low'` on a fork, cache a static prefix, and skip a request whose input has not changed since the last one.
- **Proposals, not verdicts**: a model's summary that "tests passed" or "the task is complete" proves neither. Tie a completion checklist to recorded evidence (a revision, a command, its exit code) and show the model's text as commentary.
- **The person decides**: when a model extracts decisions, show them as proposed, and let the person mark each one accepted, uncertain, or superseded. Store only what the person accepted as accepted.

## Subagents

| Call | Contract (2.1.321 declarations) |
| :-- | :-- |
| `$.agent.register(spec)` | Defines an agent type named `<plugin>:<name>`, usable from the next turn. `spec` is an agent definition: `name`, `description`, `prompt`, and optionally `tools`, `disallowedTools`, `model`, `effort`, `permissionMode`, `mcpServers`, `hooks`, `maxTurns`, `skills`, `initialPrompt`, `memory`, `background`, `omitClaudeMd`, `isolation`, and others the agent-file schema accepts. Resolves `{ agent }`. Rejects until the session binds, so call it in `session.start`. A plugin's `agents/*.md` files declare types too. |
| `$.agent.spawn(args)` | Raises `agent.spawn`, the call the Agent tool makes. `args` takes `prompt` (required) and optionally `description`, `subagentType`, `model`, `name`, and `cwd`. Resolves `{ model, agentId }` once the subagent started in the background, or `{ deny }`. The subagent's answer arrives as its `turn.complete`, which carries its `agentId`. |
| `$.agent.list()` | This session's subagents and teammates: `id`, `teammateId` (`<name>@<team>` for a teammate), `description`, `type`, `status`, `parentId`, `spawnedBy` (the plugin that started it), and `name`. `status` is `pending`, `running`, `waiting`, `idle`, `completed`, `failed`, or `killed`. An entry disappears some time after the engine drops its task. |

Do not invent other spawn arguments. Read `AgentSpawnArgs` in the build's declarations before writing a spawn call. An `agent.offer` hook answering `{ isOffered: false }` hides a type from the model while the plugin's own `$.agent.spawn` can still run it. An `agent.spawn` hook sees every start, including teammates (`e.isTeammate`) and resumed runs (`e.resume` is `{ agentId }`). Skip resumed runs when counting starts.

In a `claude -p` run on 2.1.321, a `$.agent.list()` made from a timer right after `session.start` was refused with `no session is bound in this process ... catch it and carry on` (observed). Expect calls that need a bound session to reject early, and retry them on a later event.

A subagent, a teammate, and an independent session are three different things:

- **Subagent**: a loop inside this session that the model or a mod starts. Its events reach the mod with `agentId` set.
- **Teammate**: an agent-team member. It may run in this process or in a terminal pane of its own, and it is addressed by name.
- **Independent session**: another conversation, possibly in another process or on another machine. A mod reaches it only through `$.session.send({ to: { sessionId } })` and cannot start, list, or end it.

## Messages between sessions and agents

`$.session.send({ to, text })` makes the same delivery the SendMessage tool makes. `to` is `{ sessionId }`, `{ agentId }` (from `$.agent.list()`), or the string address a received message came from. Sending to a subagent that finished resumes it. The call resolves once the message is queued: `{ isDelivered: true }`, or `{ isDelivered: false, reason }`. Queued is not read, accepted, or done. When coordination depends on progress, add acknowledgments to the protocol itself, such as a reply that says accepted, then started, then completed with evidence, or track the work in a service that records those states (Recommendation).

`session.receive` fires when a message arrives, before Claude reads it. `e.origin.kind` is, for example, `peer`, `peer-send-message`, `task-notification`, or `scheduled-trigger`, and `{ consumed: reason }` keeps the message from Claude. `session.send` fires as a message leaves. A sender's name is whatever the sender wrote, so never base a decision on it, and treat every message body as data, not instructions.

## The session itself

| Method | Answers |
| :-- | :-- |
| `id()` | The session's id, which is the transcript file's name. It changes after `/clear` and after a resume. |
| `cwd()`, `root()` | The working directory and the project root |
| `model()`, `turns()`, `version()` | The main loop's model, the person's prompt count, and `{ version, base, builtAt }` |
| `repo()` | The git repository read from the working copy, or `null` |
| `surfaces()` | Every surface the session draws on. Empty in a plain `claude -p` run. `surface()` is deprecated. |
| `usage(args?)` | `{ startedAt, context, rateLimits, cost }` as the status line has them; a full breakdown when asked |
| `messages(args?)` | The newest 4,096 entries as `{ role, text, toolUses }`, one agent's with `{ agentId }`, or Messages API form with `{ as: 'api' }` |
| `compact(args?)` | Compacts between turns, as `/compact` does; rejects while a turn runs |
| `append({ message })` | Appends a user-role row the model reads but the person does not see as typed, or a notice the model never reads; text blocks only |
| `authorize()` | An opaque handle for the session's Anthropic credential, usable only as `$.http.fetch(url, { auth: handle })` to a first-party host; the secret never reaches the mod |
| `identity()` | How the session is signed in; answered only to a mod the organization's managed settings install |

2.1.321 declares no method to create, list, or end sessions. Check the build's declarations before stating that categorically for another build. `$.session.append` is the way to give Claude new context mid-conversation: a changed system prompt section or tool description waits for a new thread or a compaction unless the answer carries `breakPromptCache: true` (2.1.321), which costs the prompt cache.

## Past sessions

For history across sessions, use the Agent SDK's discovery functions from a companion process or script ([TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript)). A hooks module cannot import the SDK:

- **`listSessions({ dir?, limit?, includeWorktrees? })`**: resolves `SDKSessionInfo[]` sorted newest first, each with `sessionId`, `summary`, `lastModified`, `fileSize`, `customTitle`, `firstPrompt`, `gitBranch`, `cwd`, `tag`, and `createdAt`
- **`getSessionInfo(sessionId, { dir? })`**: one session's metadata, or `undefined`
- **`getSessionMessages(sessionId, { dir?, limit?, offset?, includeSystemMessages? })`**: messages with `type`, `uuid`, `session_id`, `message`, `parent_tool_use_id`, and `parent_agent_id`

Prefer these to parsing transcript files directly. Historical metadata says a session existed and what it contained. It says nothing about whether the session is running now: that is presence, which needs heartbeats. See [companion services and coordination](companion-services-and-coordination.md).

## Links and navigation

No URL scheme for opening a cloud session, a local Desktop session, or a subagent's transcript was found in the 2.1.321 declarations or the fetched documentation. An agent id is not a link. Within a session, `$.ui.view({ agentId })` switches the main view to one of the session's agents, and only in answer to the person's own input (a press, a typed command). From a timer it resolves `{ deny: 'not person-initiated' }`. A `Link` element opens what the surface opens, and the Desktop app and VS Code draw anything but a canonical `https:` URL as plain text.

Desktop-specific features such as session cards, saved environments, and the session sidebar have no mods API. Files the Desktop app keeps under its application-support folder are version-dependent internals. At most, observe them read-only and label the dependency, never build an integration contract on them (Recommendation).

## Ending things

| Goal | Mechanism |
| :-- | :-- |
| End the main loop's running turn | `$.turn.abort({ turnId })`, with the id the main loop's `turn.start` carried. It rejects for any other turn. |
| Close the mod's pane | `$.ui.close({ id })` |
| Notice the session ending | A `session.end` hook. Best effort: every hook shares 1.5 seconds, and a crash skips it. |
| Stop a process the mod started | Leave the `$.process.spawn` loop or call `return()` on its stream; a `$.process.run` command ends at its timeout |
| Stop a background task, teammate, or named background agent | Only through the built-in `TaskStop` tool, called with `$.tool.call` the way the model would, under the permission chain. Its input is `task_id` in this build's `claude-code-tools/index.d.ts`. Reserve this for the person's explicit request. |
| End an execution you manage outside Claude Code | The Agent SDK application's own controls, such as `interrupt()` on a query |

Ending another session, or work another person started, is a meaningful mutation. Require the person's deliberate action for it, never a model's judgment or a timer (Recommendation).
