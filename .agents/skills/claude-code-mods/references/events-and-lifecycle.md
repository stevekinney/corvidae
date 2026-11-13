# Events and lifecycle

A hook sits between an event and what Claude Code does about it. The hooks on one event form a middleware chain: each hook's `next(e)` calls the next hook, and the last `next` reaches Claude Code's own behavior. This file covers what a hook can do with an event, the order hooks run in, what happens when one fails, and which events fire at each lifecycle transition.

## What a hook does with an event

| To | Write | Effect |
| :-- | :-- | :-- |
| Observe before | do the work, then `return next(e)` | Nothing changes |
| Observe after | `const result = await next(e)`, do the work, `return result` | Nothing changes; the hook sees the outcome |
| Rewrite the input | `return next({ ...e, field })` | Later hooks and Claude Code see the copy. `e` is deeply frozen, so assigning to it throws. |
| Rewrite the result | `const result = await next(e)`, then return a changed copy | Earlier hooks and Claude Code receive the copy |
| Answer | return a result without calling `next` | Later hooks and Claude Code's behavior do not run |
| Refuse | return the event's refusal, such as `{ deny: reason }` | Where the event's result shape allows one |

Each event has its own result shape. These are the common ones ([mods reference](https://code.claude.com/docs/en/plugins/mods/reference)):

| Event | A hook can return |
| :-- | :-- |
| `tool.call` | `next(e)`, `{ result }` (for a built-in tool, the shape of that tool's own result), or `{ deny }` |
| `tool.check` | `next(e)` or `{ decision: 'allow' \| 'ask' \| 'deny', reason? }` |
| `prompt.submit` | `next({ ...e, text })`, `next({ ...e, context: [...] })`, or `{ drop: reason }` |
| `command.run` | `{ text }`, `{}` to print nothing, or `next(e)` |
| `turn.complete` | `next(e)`, or `{ text }` for a line under the answer |
| `session.compact` | `{ skip: reason }` |
| `agent.spawn` | `next({ ...e, model })` or `{ deny }` |
| `plugin.register` | `{ refuse: reason }` |
| `ui.render` | a tree, `next(e)`, or `next({ ...e, props })` |
| any `$` method's event, such as `fs.write` | `next(e)`, `{ value }`, or `{ deny }` |

## Matchers and wildcards

The second argument to `on` is a matcher. Each of its fields is compared with the event's, and the hook runs only when every field matches. A field can be a value, an array of allowed values, or a regular expression: `{ tool: 'Bash' }`, `{ tool: ['Edit', 'Write'] }`, `{ tool: /^mcp__github__/ }`. A matcher also narrows `e`'s type, so `e.command` exists under `{ tool: 'Bash' }`.

- **Wildcards**: `'*'` matches every event except telemetry events, and `'classic.*'` matches every settings-hook event. A name with a leading `!` excludes an event.
- **Telemetry**: telemetry events are hooked by name. A user's mod must name its stream as `on('telemetry.log', { to: 'collector' }, hook)`; without `to`, validation fails because the hook would stand on the `anthropic` stream reserved for built-ins (observed on all four builds).
- **One registration per event and matcher**: two unmatched `on('session.start', ...)` calls fail the module. Put everything a mod does at session start in one hook.

## The order hooks run in

The first mod in the chain is outermost: it sees the event first and the result last, and it decides whether later mods run. Claude Code orders mods by where they come from ([events page](https://code.claude.com/docs/en/plugins/mods/events)):

1. The built-in guard `sec-default@builtin` where it loads, the mods an organization lists in `prependPlugins`, then any other mod that counts as the organization's
2. Mods the person installed or loaded with `--plugin-dir`
3. Mods the organization lists in `appendPlugins`
4. The other built-in mods

Among a person's mods, a mod runs before the mods it lists under `dependencies`. Within one module, hooks run in the order `register` called `on`, so register an audit observer first if it should see the guards' refusals. `next.origin` gives `{ plugin, tier }` of whoever raised the event, and `next.to(e, tier)`, which skips to a later tier, is available only to `prependPlugins` and `appendPlugins` mods.

Settings hooks sit at fixed points in a tool call. `PreToolUse` hooks from managed settings run before the first mod's `tool.call` hook, and when one blocks the call no mod's `tool.call` hook runs. The other `PreToolUse` hooks run inside Claude Code's own behavior, after the last mod calls `next`, so a mod that answers without `next` keeps them from running. `tool.check` fires after the `PreToolUse` hooks and before any permission prompt.

## Requested, permitted, run, finished, recorded

A tool call passes through distinct stages, and a hook that treats an earlier one as proof of a later one reports things that never happened (Recommendation, from the documented stages):

| Stage | Where a mod sees it | What it proves |
| :-- | :-- | :-- |
| Requested | A `tool.call` hook, before `next(e)` | The model asked; nothing has run |
| Permitted | `tool.check`, whose `next(e)` resolves to the decision the rules, mode, and hooks reached | A decision; nothing has run, and the hook can still change it |
| Ran and finished | What `next(e)` resolves to in `tool.call` | `deny` means it did not run, or its result was withheld; `isError` means it ran and failed; otherwise it ran and returned `result`. Core sets `text`, the result as the model reads it. |
| Recorded | `session.append`, door `tool-result` | The row the conversation keeps, as the chain left it |

A `{ deny }` returned after `await next(e)` withholds the result from Claude, which then reads `<tool> ran, and a plugin withheld its result: <reason>`, and undoes nothing the tool did. Calling `next(e)` a second time runs the tool again, which is a retry, not a replay. Never call it again because reporting the first result failed (Recommendation).

A mod can call tools itself with `$.tool.call`. The declaration says that call opens no permission dialog and asks no classifier. It is refused for a deny rule, or for an ask that a hook or the organization requires, and otherwise runs with nobody asked.

## When a hook fails

A hook fails when it throws, runs out of time, or returns a result of the wrong shape, including a `ui.render` tree that does not validate. Without a `.catch` handler:

- **Failed before calling `next`**: the hook is skipped and the next handler runs in its place. For a guard, that means what it was guarding goes ahead.
- **Failed after `next` resolved**: that result stands, and nothing runs twice.

A `.catch` handler on the registration answers in the failed hook's place:

```typescript
on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit'] }, async ($, e, next) => {
  const path = e.tool === 'NotebookEdit' ? e.notebook_path : e.file_path;
  // Judge before next: a refusal here means the tool never ran.
  if (!(await $.fs.exists(path))) return next(e);
  const stat = await $.fs.stat(path, { resolve: true });
  if (stat.realPath?.endsWith('/.env'))
    return { deny: `${$.plugin.name}: ${path} leads to a .env file.` };
  return next(e);
}).catch(($, e, next) =>
  next.called
    ? next(e)
    : { deny: `${$.plugin.name}: the check failed (${next.error.kind}), so this did not run.` },
);
```

`next.called` says whether the hook had called `next`. If it had, `next(e)` in the handler replays what that call settled to without running anything again. `next.error.kind` is `throw` or `timeout`. The handler has a one-second budget, and a handler that itself fails leaves the hook skipped. At `tool.check` and `plugin.register`, a refusal returned after `next` still holds, so the handler returns `{ decision: 'deny' }` or `{ refuse }` without testing `next.called`.

`claude plugin validate` names every hook at a site whose answer can refuse something, as `gating hook with .catch:` or `gating hook without .catch:`. Those lines are facts, not warnings. Choose the failure policy for each hook deliberately:

| Hook | Policy | How |
| :-- | :-- | :-- |
| Telemetry, audit, counters, refresh triggers | Fail open: the person's operation goes on | No `.catch`; wrap reporting in `try` so the result is returned as it came |
| A policy gate or safety check | Fail closed: refuse when the check cannot finish | Judge before `next`, and add a `.catch` that refuses when `next.called` is false |
| A confirmation hold | Refuse unless the person explicitly confirmed | Start from the refusal, and treat a dismissed or unavailable question as no |
| A drawing | Fall back to Claude Code's own drawing | Nothing to add: a skipped `ui.render` hook leaves the next drawing in place |

The [guarded-tool-call template](../assets/templates/guarded-tool-call/README.md) implements the first three rows and tests each failure path.

## Time limits and abandonment

| Limit | Value |
| :-- | :-- |
| A hook's own execution for one event | 10 seconds, or 50 milliseconds for `prompt.edit` |
| A `.catch` handler | 1 second |
| All `session.end` hooks together | One wall-clock bound, 1.5 seconds by default (the `SessionEnd` budget) |

Time spent waiting inside `next` or inside a `$` call does not count against a hook's own budget, except `$.clock.sleep`. A promise of the mod's own does count. So a hook that holds a tool call while the person decides waits inside `$.ui.ask`, never on a promise a button resolves. `next.budget` gives `{ ms, remainingMs }`. `next.signal` is an `AbortSignal` that aborts when the dispatch is abandoned: the person interrupted, another hook settled first, or the budget ran out. Pass it to anything long-running that accepts one, such as `$.clock.sleep(ms, { signal: next.signal })`. `$.http.fetch` takes no signal, so an abandoned request still completes; discard its result instead.

## Interruption and refusals

After the person stops a turn (Esc, **Stop**), Claude Code refuses the calls that would start new work until the person's next input. The reason is `the session was stopped and nobody has sent input since`, and a prompt or command still in the queue is dropped with `was removed from the queue before it ran` ([mods API page](https://code.claude.com/docs/en/plugins/mods/api)). Most of this handling arrived in 2.1.304.

| Refused call | Result |
| :-- | :-- |
| `$.prompt.submit` | Resolves `{ drop: reason }` |
| `$.command.run` | Rejects with the reason |
| `$.agent.spawn` | Resolves `{ deny: reason }` |
| `$.session.send` to a finished subagent or a teammate | Resolves `{ isDelivered: false, reason }` |
| `$.tool.call` of background Bash, `Monitor`, or `CronCreate` | Resolves `{ deny }` |

Stop means stop. Keep a refused call's arguments, and make it once more from a `turn.complete` hook after the person's next input. Clear the pending value before retrying, so a second `turn.complete` does not submit it twice, and never loop or schedule automatic retries around a Stop (Recommendation). In `claude -p` runs and Agent SDK sessions, `--max-turns`, `--max-budget-usd`, and a host that ended its input refuse calls the same way. A mod that submits a prompt at the end of every turn keeps a `claude -p` run from ever exiting unless one of those limits is set.

`turn.complete` reports how a turn ended: `reason` is `answer`, `aborted`, `refusal`, or `error`, and `isAborted` is set for an interrupted turn. A subagent's turn fires it with `agentId` set.

## Lifecycle transitions

| Transition | Events a mod sees | `$.state` | Module variables, timers, spawned children |
| :-- | :-- | :-- | :-- |
| First load | `register`, then `session.start`, awaited before the first prompt | Defaults | Fresh |
| Hot reload of the module | `register` and `session.start` again, in a fresh environment | Kept | Reset; timers dropped; children ended |
| Hooks worker replaced after a crash | `session.start` again in a fresh copy | Kept | Reset. From 2.1.292, a `$.prompt.submit`, `$.command.run`, or `$.agent.spawn` the start hook already made with the same input resolves to the first result instead of running twice |
| `/clear` | `session.end` with `reason: 'clear'`, then `classic.SessionStart` with `source: 'clear'`; no `session.start` | Reset to defaults | Kept; the session id changes |
| `/resume` | `session.end` with `reason: 'resume'`, `classic.SessionStart` with `source: 'resume'` | Reset | Kept |
| `/branch` | `session.end` with `reason: 'resume'`, `classic.SessionStart` with `source: 'fork'` | Reset | Kept |
| Compaction | `session.compact`, which a hook can skip, and `classic.SessionStart` | Kept | Kept; outside fullscreen rendering, placed rows end |
| Another app attaches or detaches | `session.attach`, `session.detach` | Kept | Kept |
| The session ends | `session.end` with `prompt_input_exit`, `logout`, or `other`, within the shared 1.5-second bound | Gone | Gone |

Three rules follow from the table (Recommendation):

- **Initialize idempotently**: `session.start` runs on every load and reload, so registration, timers, and remote registrations must be safe to repeat. Make a remote registration an upsert keyed by stable identifiers.
- **Clean up on a best-effort basis**: a crash, a forced kill, or a lost worker skips `session.end`, and even when it runs every hook shares 1.5 seconds. Anything that must be released, such as a lease, needs an expiry on the side that holds it.
- **Re-hydrate after resets**: copy persisted values back into `$.state` after `/clear`, `/resume`, and `/branch`, as the [state reference](state-configuration-and-environment.md) describes, including where `classic.*` hooks do not run.

## The settings-hook bridge

Every settings-hook event is also a mod event named `classic.<Event>`, such as `classic.Stop` or `classic.SessionStart`. Its `e` is the JSON a settings hook receives on stdin, `transcript_path` included. The 2.1.321 declarations cover these 33 events:

`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `PermissionDenied`, `Notification`, `UserPromptSubmit`, `UserPromptExpansion`, `SessionStart`, `SessionEnd`, `Stop`, `StopFailure`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`, `PreModelSwitch`, `PostModelSwitch`, `PermissionRequest`, `Setup`, `TeammateIdle`, `TaskCreated`, `TaskCompleted`, `Elicitation`, `ElicitationResult`, `ConfigChange`, `InstructionsLoaded`, `WorktreeCreate`, `WorktreeRemove`, `CwdChanged`, `FileChanged`, `DirectoryAdded`, `MessageDisplay`

Where the built-in guard loads, a user-installed mod's `classic.*` hooks never run, nor do its hooks on `prompt.compose`, `prompt.section`, `prompt.context`, `prompt.attachment`, `skill.prompt`, `attribution.text`, `session.compact`, `settings.read`, and three `session.append` doors ([admin page](https://code.claude.com/docs/en/plugins/mods/admin)). The guard loads on a machine with managed settings or `managed-mcp.json`, or under a Team or Enterprise `/login`. On the machine this skill was checked on, the debug log said `cc-plugin-sec-default@builtin not seated: no managed settings and not a Team or Enterprise organization`. Design for both cases: never let a `classic.*` hook be the only path to something the mod needs.
