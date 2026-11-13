# agent-roster

A reactive UI template: a pane that lists this session's subagents and teammates from `$.agent.list()`, a one-line band above the prompt that summarizes them, and a remembered choice to hide the band.

## What it shows

- **A state contract**: `types/index.d.ts` declares each `$.state` value under the plugin's name, including a `Shaped` value whose tag lets new code decline what older code stored and a `StateFamily` keyed by agent id. The manifest names it with `types`.
- **The state helpers**: `atom` for each value, `read` while drawing (which subscribes the drawing), `update` from handlers and other events, `derive` for the band's counts, and `memberOf` for one agent's expanded flag.
- **Side-effect-free rendering**: the `ui.render` hooks only read and return trees. Every write happens in a button's `onPress` or another event's hook.
- **A band that composes**: the band returns `next(e)` when it has nothing to show and otherwise keeps `await next(e)` inside its tree, so other mods' bands still draw. The wrapping `Box` takes no size or position props, which would break that composition.
- **Coalesced refresh**: turn events schedule one refresh a quarter second later, and a refresh requested while one runs runs once afterwards.
- **Persistence and restore**: the band preference is saved to `$.store` before it is shown, then restored on `session.start`. After `/clear`, `/resume`, or `/branch`, which reset `$.state` without raising `session.start`, it is restored by `classic.SessionStart`. Where the built-in guard keeps a user-installed mod's `classic.*` hooks from running, it is restored on the next main-loop `turn.start` after `session.end` reported the reset.
- **A text fallback**: `/agent-roster` opens the pane, or answers with a summary where nothing places a pane, as in `claude -p`.

## Files

| File | Role |
| :-- | :-- |
| `.claude-plugin/plugin.json` | The manifest, with `types` naming the contract |
| `hooks/hooks.json` | Names the one hooks module, `register.tsx` |
| `hooks/register.tsx` | Atoms, refresh, restore, the command, the pane, and the band, in JSX |
| `hooks/roster.ts` | Pure row mapping, counting, and text fitting |
| `types/index.d.ts` | The `PluginState` contract |
| `tests/register.test.tsx` | Kit tests on the terminal, Desktop, and VS Code surfaces |

## Check it

From this directory:

```bash
claude plugin validate .
claude plugin test .
claude -p "/agent-roster" --plugin-dir .
```

In the headless run on 2.1.321, `/agent-roster` answered `agent-roster: No subagents or teammates in this session yet.` with no model turn. The first refresh's `$.agent.list()` was refused because no session was bound yet in that process. The template catches that, logs it to the debug log, and refreshes again on the next turn. For the pane itself, run `claude --plugin-dir .`, ask Claude to start a subagent, and run `/agent-roster`.

Verified on 2026-11-12: validate and test passed on Claude Code 2.1.295, 2.1.309, 2.1.316, and 2.1.321, and the type-check passed against the 2.1.321 declarations. A `Button` holding `Text` children needs 2.1.295 or later. The tests cannot reset `$.state` the way `/clear` does, so they start from defaults instead. Check the restore after `/clear` in an interactive session.
