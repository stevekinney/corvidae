# Plugin hooks and mod hooks

A plugin can react to events in two unrelated ways, and both live in `hooks/hooks.json`:

- **Settings hooks** (the `hooks` key): the same format as `hooks` in `settings.json`. Each handler runs outside Claude Code, as a process, an HTTP request, an MCP tool call, a model prompt, or a subagent. A command hook can be any executable in any language, with any package, and full access to the machine.
- **Mod hooks** (the `modules` key): one JavaScript or TypeScript module loaded into Claude Code. Its `($, e, next)` functions run in Claude Code's own process and reach the outside world only through `$`, under static analysis that refuses npm imports and indirect `$` calls.

The trade is reach against integration. A settings hook can do anything a program can, but it only sees an event's JSON and answers with a decision. A mod hook can do only what `$` offers, but it sits in the middle of the event: it rewrites, answers, draws, and keeps state between events. Facts here are documented in [hooks](https://code.claude.com/docs/en/hooks), [the hooks guide](https://code.claude.com/docs/en/hooks-guide), and the [mods pages](https://code.claude.com/docs/en/plugins/mods/overview), fetched 2026-11-12 and 2026-11-13, unless labeled.

## Side by side

|  | Settings hook | Mod hook |
| :-- | :-- | :-- |
| Runs | Outside Claude Code: a new process or request per event, with the person's full permissions, outside the sandbox | Inside Claude Code, on a worker thread shared by installed mods, not sandboxed |
| Language and packages | Anything executable; packages from `package.json` and a lockfile install for copied plugins | An ES module; relative imports and `claude-code` only, no npm packages, no `import()` |
| Reaches the machine | Directly, as any program does | Only through `$.fs`, `$.http`, `$.process`, and the other `$` nouns |
| Sees | The event's JSON on stdin, or as an HTTP body | The frozen event, plus every other `$` capability |
| Can change | A decision or a replacement in its JSON output: `permissionDecision`, `updatedInput`, `updatedToolOutput`, `decision: "block"`, `continue: false`, added context | Anything `next` receives or returns: rewrite the input, answer without `next`, refuse, or edit the result |
| Draws | `systemMessage`, a terminal title or notification sequence, `displayContent` for a shown message | Panes, the band above the prompt, restyled transcript and tool rows, toasts, status text |
| State | Files, `${CLAUDE_PLUGIN_DATA}`, `CLAUDE_ENV_FILE` | Module variables, `$.state`, `$.store` |
| Events | 33 settings events such as `PreToolUse` and `Stop` | Mod events such as `tool.call`, `prompt.submit`, `ui.render`, plus all 33 as `classic.<Event>` |
| Time | `timeout` in wall-clock seconds; defaults 600 for command, HTTP, and MCP tool hooks, 30 for prompt hooks, 60 for agent hooks | 10 seconds of the hook's own execution, not counting `next` or `$` calls; 50 ms for `prompt.edit` |
| When it fails | The action proceeds, unless the hook exits 2 or sets `onFailure: "block"` | The hook is skipped and the action proceeds, unless a `.catch` refuses |
| Tested with | Sample JSON piped into the script, `/hooks`, and `claude --debug` | `claude plugin validate` and `claude plugin test` |
| Turned off by | `disableAllHooks`, `allowManagedHooksOnly`, managed policy | The same two settings, plus `allowManagedModsOnly`, `--safe-mode`, and the built-in guard's rules |

Prefer a settings hook when you already have a script, when the work needs a language or package a mod cannot import, or when a rule must hold even where user mods are restricted. Prefer a mod when the hook must rewrite or answer an event, draw something, keep state across events, or run in process on every keystroke (Recommendation, following [compare mods](https://code.claude.com/docs/en/plugins/mods/overview)).

## Settings hooks

### Handlers

Every handler has `type`, and optionally `if` (one permission rule such as `"Bash(git *)"`, read only on the tool and permission events), `timeout`, `statusMessage`, and `once` (honored only in skill frontmatter).

| Type | Fields | Notes |
| :-- | :-- | :-- |
| `command` | `command` (always required), `args`, `shell` (`bash` or `powershell`), `async`, `asyncRewake`, `onFailure` | With `args` present, `command` is the executable, spawned directly with no shell (exec form); without `args`, `command` is a shell string. A hook with `args` and no `command` fails validation (observed on 2.1.316 and 2.1.321). `onFailure` needs 2.1.295 or later. |
| `http` | `url`, `headers`, `allowedEnvVars`, `onFailure` | A header expands `$VAR` only for names in `allowedEnvVars` |
| `mcp_tool` | `server`, `tool`, `input` | A plugin's own server is `plugin:<plugin>:<server>`. Skipped on launch-time `SessionStart` and on `Setup`. |
| `prompt` | `prompt` (with `$ARGUMENTS`), `model`, `continueOnBlock` | The model answers `{ ok, reason }` |
| `agent` | `prompt`, `model` | Experimental: a subagent with Read, Grep, and Glob, up to 50 turns |

A guard on Bash commands in a plugin's `hooks/hooks.json`, in exec form so the substituted path needs no quoting, and failing closed:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node",
            "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/check-command.js"],
            "onFailure": "block",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

`SessionStart` and `Setup` accept only `command` and `mcp_tool`. Most other non-tool events accept `command`, `http`, and `mcp_tool`. The tool, prompt, and stop events accept all five, except `PermissionRequest`, which takes no `agent` hook.

### Events and matchers

The 33 events are `SessionStart`, `Setup`, `UserPromptSubmit`, `UserPromptExpansion`, `PreToolUse`, `PermissionRequest`, `PermissionDenied`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `Notification`, `MessageDisplay`, `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted`, `Stop`, `StopFailure`, `TeammateIdle`, `InstructionsLoaded`, `ConfigChange`, `CwdChanged`, `DirectoryAdded`, `FileChanged`, `WorktreeCreate`, `WorktreeRemove`, `PreCompact`, `PostCompact`, `PreModelSwitch`, `PostModelSwitch`, `Elicitation`, `ElicitationResult`, and `SessionEnd`.

A matcher of `"*"`, `""`, or none matches everything. One made only of letters, digits, `_`, `-`, spaces, `,`, and `|` is an exact name or a list. Anything else is an unanchored JavaScript regular expression, so `Edit.*` also matches `NotebookEdit`; write `^Edit$`. A plugin's MCP tools are `mcp__plugin_<plugin>_<server>__<tool>`, and a matcher naming only the server never fires. Events with no matcher field, such as `UserPromptSubmit` and `Stop`, ignore one silently.

### Input and output

A command hook reads the event as JSON on stdin; an HTTP hook gets it as the POST body. Common fields include `session_id`, `transcript_path`, `cwd`, `permission_mode`, and `hook_event_name`; tool events add `tool_name`, `tool_input`, and `tool_use_id`. A command hook has no terminal (no `/dev/tty`).

| Exit code | Meaning |
| :-- | :-- |
| 0 | Success. Stdout is applied as JSON if it is exactly one object; otherwise it is plain text, which becomes context on `UserPromptSubmit`, `UserPromptExpansion`, `SessionStart`, and `PostModelSwitch`. |
| 2 | A blocking error on events that can block, such as `PreToolUse`, `UserPromptSubmit`, `Stop`, and `PreCompact`. Stderr is the reason, and JSON cannot override it. |
| Anything else, including 1 | A non-blocking error: the action proceeds |

The JSON answer carries `continue` (`false` stops Claude and wins), `stopReason`, and `systemMessage` at the top level, and event-specific fields under `hookSpecificOutput` with `hookEventName`. `additionalContext` placed at the top level is ignored silently. For `PreToolUse` the decision is `permissionDecision` (`allow`, `deny`, `ask`, or `defer`, precedence `deny` over `defer` over `ask` over `allow`), plus `permissionDecisionReason` and `updatedInput`, which replaces the whole input. A `deny` holds in every permission mode, `bypassPermissions` included, and an `allow` never overrides a deny rule. A plugin hook's `ask` prompt is labeled `[plugin:<name>]`. Text fields are capped at 10,000 characters.

### Timing and failure

- **Parallel**: matching hooks run in parallel and all finish, so one hook's `deny` does not stop another's side effects. When several return `updatedInput`, the results are not merged and the winner is not guaranteed.
- **Failure**: a timeout, a crash, or invalid output lets the action proceed, unless `onFailure: "block"` turns it into that event's exit-2 behavior. A guard should set `onFailure: "block"` (Recommendation).
- **Background**: `async: true` (command hooks only) runs in the background, cannot block, and delivers its context on the next turn. `asyncRewake` wakes Claude when it exits 2. In `claude -p` runs, async hooks are killed at teardown.
- **Session end**: `SessionEnd` hooks share 1.5 seconds unless a hook sets a longer `timeout`, at most 60.

### Environment

`${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, and `${CLAUDE_PROJECT_DIR}` are substituted in `command` and `args` and exported to the process, with `CLAUDE_PLUGIN_OPTION_<KEY>` for each `userConfig` value. `${user_config.KEY}` substitutes only in exec form; in shell form it is an error. `CLAUDE_ENV_FILE` exists only for `SessionStart`, `Setup`, `CwdChanged`, and `FileChanged`, and `export` lines appended to it reach later Bash commands. Hooks inherit the parent environment without `OTEL_*` variables.

### Trust and policy

- **Trust**: an interactive session holds back every settings-file hook until the workspace trust dialog is accepted. `claude -p` and SDK sessions treat the folder as trusted, so a repository's hooks run there.
- **Off switches**: `disableAllHooks: true` turns off all hooks the settings precedence lets it reach, but non-managed settings cannot disable managed hooks. There is no per-hook switch.
- **Managed only**: `allowManagedHooksOnly` blocks user, project, local, and plugin hooks, except those of plugins force-enabled in managed `enabledPlugins`. `allowedHttpHookUrls` and `httpHookAllowedEnvVars` restrict HTTP hooks from every source.
- **Security practice**: validate input, quote every variable, refuse `..` in paths, use absolute paths, and stay out of `.env` and `.git/`.

## Mod hooks

[Runtime and API](runtime-and-api.md) and [events and lifecycle](events-and-lifecycle.md) are the full reference. In brief: `hooks/hooks.json` names one module in `modules`; the module exports `register(on, options)`; each `on(event, matcher?, hook)` adds a `($, e, next)` function; the validator reads the source before it runs. A mod that blocks the worker is unloaded (`it crashed the hooks worker`), and three unattributed crashes switch off every non-built-in mod until `/reload-plugins`.

## When both kinds handle one event

- **One file, both keys**: one `hooks/hooks.json` can hold `modules` and `hooks` together, and settings hooks keep running alongside mods.
- **The bridge**: every settings event is also the mod event `classic.<Event>`, with the settings hook's input as `e`. A mod that returns `next(e)` lets the settings hooks for that event run; the docs' `classic.Stop` example does so.
- **Order on tool calls**: managed `PreToolUse` hooks run before the first mod's `tool.call` hook, and their block stops every mod. Other `PreToolUse` hooks, from settings files and plugins' `hooks.json`, run after the last mod calls `next`, so a mod that answers without `next` keeps them from running. After a mod rewrites a call, managed hooks run again on the rewrite. The docs state no order for other events (Unverified).
- **The built-in guard**: where `sec-default@builtin` loads (with managed settings, `managed-mcp.json`, or a Team or Enterprise login), a user mod's `classic.*` hooks never run, and it cannot approve a call that a deny rule, an ask rule, or a `PreToolUse` block stops. A rule that must hold for everyone therefore belongs in a managed `PreToolUse` settings hook with `onFailure: "block"`, not in a user mod (Recommendation).
- **Off switches reach both**: `disableAllHooks` in user settings stops installed mods as well as settings hooks; `allowManagedHooksOnly` blocks non-organization hooks and mods; `allowManagedModsOnly` stops non-organization mods but leaves settings hooks running. None of them stop built-in mods.
- **Network rules differ**: `$.http.fetch` is refused when organization policy disallows WebFetch, but not by a WebFetch deny rule, and `$.process.run` is outside all of these. A command hook's network use is outside them too.

The mods pages describe settings hooks as only command, HTTP, prompt, and agent hooks; the hooks page also lists `mcp_tool`, and that page is the one to follow.
