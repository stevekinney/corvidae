# Patterns

Reusable shapes for common mod features. None is required of every mod. Pick the smallest one that does the job, and prefer a deterministic API over a model call whenever the fact already exists somewhere. Each pattern names its events, where its state lives, and its failure policy. The templates implement four of them end to end. Everything on this page is Recommendation unless it cites a source.

## Lessons from first-party mods

| Mod | Lesson | Caveat |
| :-- | :-- | :-- |
| `diff` (built in) | A `Host` adapter built in `session.start` keeps every `$` call explicit while the logic lives in plain modules. Refreshes are queued and scheduled, never stacked. The pane opens unasked only on a wide terminal, and otherwise waits for `/diff`. | Large; read its `register.ts` for the structure, not as a copy source |
| `token-weather` (sample) | Read figures the session already has (`$.session.usage()`) after each main-loop `turn.complete`, skipping subagent turns. Keep a short bounded history, catch a failed reading and keep the last one, and adapt the band to its width. | Reads `e.hasSurvey` and `e.bodyColumns`, which 2.1.321 places under `e.props` |
| `blast-radius` (sample) | Measure before asking: show what a risky command would change, then hold the call for an explicit Proceed. It honors `next.signal` and falls back from a pane to the band when the pane is not placed. It also claims the one hold slot with no `await` between the check and the claim. | Its gate has no `.catch`, so a failing hook lets the command run. It holds by polling `$.process.run(['sleep', ...])`, where `$.ui.ask` waits inside one call. |
| `replay-theater` (sample) | Collect during the turn, publish at `turn.complete`, and open the pane only from the person's command or button. It caps diff sizes and keeps pane state consistent through `ui.close`. | Written for 2.1.280 |
| `sec-default` (built in) | A policy mod: it decides at `plugin.register`, seats itself outermost, and fails closed when it cannot read its own policy | Its rules depend on managed settings |

The samples come from [claude-code-playground](https://github.com/anthropics/claude-code-playground/tree/main/claude-code/mods) and the built-ins from [claude-code `mods/`](https://github.com/anthropics/claude-code/tree/main/mods). Both repositories call themselves early access and unsupported. Treat them as demonstrations, not security guarantees.

## Reactive status strip

A line in the band or the status bar that tracks something cheap, such as context fill, agent counts, or a branch.

- **Events**: `session.start` for a first reading; `turn.complete` filtered to `e.agentId === undefined` for the main loop; `ui.render` on `AbovePrompt`
- **State**: the reading in `$.state`, so a write redraws the band
- **Failure policy**: fail open; a failed reading keeps the last value
- **Pitfalls**: keep `await next(e)` inside the tree, so other mods' bands still draw. Return `next(e)` while `e.props.hasSurvey`. Keep it to one line.

## Agent or task pane

A pane listing work in progress with per-row details, as the [reactive-pane template](../assets/templates/reactive-pane/README.md) does with `$.agent.list()`.

- **Events**: `turn.start` and `turn.complete` (and `agent.spawn` if you need the start instant) schedule a coalesced refresh; `command.run` opens the pane
- **State**: a `Shaped` snapshot plus a `StateFamily` for expanded rows
- **Failure policy**: fail open; a refused list waits for the next event
- **Pitfalls**: open unasked panes only on wide terminals, and answer with text where `isPlaced` is false

## Custom commands and tools

A command is for the person and a tool is for Claude. Register both in `session.start`, inside `try`, because a taken name throws.

```typescript
on('session.start', async ($, e, next) => {
  try {
    await $.tool.register({
      name: 'ticket',
      description: 'Look up a ticket by its id and return its title and status',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    });
  } catch (error) {
    $.ui.log(`the ticket tool was not registered: ${String(error)}`, { to: 'debug' });
  }
  return next(e);
});

on('tool.call', { tool: 'mcp__my-mod__ticket' }, async ($, e) => {
  // A registered tool's arguments arrive untyped (`unknown`): check them before use.
  if (typeof e.id !== 'string' || e.id.length === 0)
    return { result: 'The ticket tool needs an id.' };
  const response = await $.http.fetch(
    `https://tickets.example.com/api/${encodeURIComponent(e.id)}`,
  );
  return { result: response.ok ? response.text : `Lookup failed with status ${response.status}` };
});
```

This snippet is adapted from the [mods API page](https://code.claude.com/docs/en/plugins/mods/api). A registered tool sits behind tool search unless the spec says `isDeferred: false`. A call no hook answers fails, so match the full `mcp__<plugin>__<name>`. Return a `result` on failure too, so Claude learns the lookup failed. A command that only opens a pane returns `{}`, and `immediate: true` lets it run while Claude works.

## Session registration and live presence

Each session announces itself to a companion service and keeps announcing while it lives, as the [companion template](../assets/templates/companion-service/README.md) does.

- **Events**: `session.start` starts a heartbeat loop. The loop reads `$.session.id()` on each beat, because the id changes after `/clear`.
- **State**: presence lives in the service, with an expiry; the mod keeps only its own instance id
- **Failure policy**: best effort; a missed heartbeat simply expires
- **Pitfalls**: an upsert keyed by the session and instance ids, with a sequence number so a late heartbeat cannot overwrite a newer one. Never treat history (`listSessions`) as presence.

## Attention queue

One place for what needs the person: approvals waiting, failed checks, expired claims, pending handoffs.

- **Sources**: deterministic producers post items to the service with stable ids, such as CI results, lease expiries, and handoff records. A model does not decide what is in the queue.
- **State**: the queue in the service; a cached view in `$.state`
- **Action**: acknowledging is the person's press, posted to the service, then refreshed
- **Pitfalls**: a resubmitted item must not reopen an acknowledged one. Show connection problems on the status line, not as an empty queue.

## Evidence-based completion checklist

A checklist that turns green only on recorded evidence, never on a model's say-so.

- **Evidence**: each item names a revision (`git rev-parse HEAD`), a command, its exit code, and when it ran. Record the outcome from `tool.call` after `next(e)` resolved, using `isError` and core's `text`, or from `$.process.run`'s `exitCode`.
- **Staleness**: an item whose revision differs from the current one is stale, not passed
- **State**: the evidence in `$.store` keyed by revision, or in the service when several sessions share it
- **Pitfalls**: a `Bash` call that was requested, or denied, is not a run. A model summary of results is commentary beside the evidence, not the evidence.

## Change and review timeline

A timeline of what changed during a turn or a session.

- **Two sources, shown apart**: observed tool activity (`tool.call` results for `Edit`, `Write`, and `NotebookEdit`, and Bash commands) is what Claude did through tools. Reconciled filesystem state (`git status --porcelain` and `git diff` through `$.process.run` at `turn.complete`) is what is actually on disk.
- **Why both**: other processes, formatters, and shell commands change files that no edit tool touched, and a denied or failed edit changed nothing
- **Pitfalls**: refresh on turn boundaries and coalesce, as the built-in `diff` mod does. Cap diff sizes before drawing them.

## Structured tool-result views and message actions

Draw a tool call's row or result in a more useful form, with an action beside it.

- **Events**: `ui.render` on `ToolUse` or `ToolResult`, keeping `await next(e)` in the tree, or changing one prop through `next({ ...e, props })`. Return `next(e)` while `e.props.isExpanded`.
- **Identity**: `e.requestId` is the tool call's `tool_use_id`, and a message's id for message sites. Capture it in the button's handler.
- **Per-row state**: `memberOf(family, e)` gives each row its own value
- **Pitfalls**: drawing changes the display only. A rewrite of what the transcript stores happens at `session.append`, before the row is stored. On the mobile app, a `ToolUse` addition draws as a quiet line unless the holding `Box` has a border or background.

## Decision ledger

A record of decisions the person reviewed, each marked proposed, accepted, uncertain, or superseded.

- **Proposals**: candidates can come from a `$.model.fork` the person asked for, or from explicit commands
- **Acceptance**: only the person's press moves a decision to accepted, and a newer decision supersedes rather than deletes an older one
- **State**: accepted decisions in durable storage, with who accepted each and when; a local view in `$.state`
- **Pitfalls**: never store a model's proposal as accepted. Show the source excerpt beside each proposal.

## Model-assisted summaries and handoffs

A summary or handoff note written by a model, on request.

- **Trigger**: a command or a button, never every turn
- **Cost controls**: `$.model.fork({ prompt, effort: 'low' })` for questions about this conversation, which reads the prompt cache; or `$.model.complete` with `maxTokens`, `timeoutMs`, and a cached static prefix. Skip a request whose input has not changed.
- **Delivery**: deliver a handoff with `$.session.send` to a session that exists, then wait for an acknowledgment the protocol defines. Queued is not received.
- **Pitfalls**: a fork shares the conversation's assumptions, so label the result as the model's view. Handle every `isAnswered: false` reason.

## Policy and approval interface

A readable gate in front of a risky action, as the [guarded-tool-call template](../assets/templates/guarded-tool-call/README.md) does.

- **The gate**: `tool.call` judges before `next`. Its `.catch` refuses when `next.called` is false and replays when it is true.
- **The question**: `$.ui.ask` with explicit labels. Start from the refusal, so a dismissed question, a `claude -p` run, or a timeout refuses.
- **The refusal text**: write it for Claude to act on, as in "the user did not confirm this; ask before retrying", so Claude does not loop
- **Pitfalls**: a pattern match is a reminder, not a boundary. For real enforcement, an organization installs a policy mod in `prependPlugins` and backs it with file permissions or branch protection.
