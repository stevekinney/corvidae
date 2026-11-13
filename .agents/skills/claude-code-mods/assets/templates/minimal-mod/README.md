# tool-tally

The smallest useful mod: it registers `/tool-tally`, observes every tool call, and reports how many were requested, refused, failed, and succeeded since the module loaded.

It shows three habits worth keeping in every mod:

- **Requested is not completed**: the hook counts the request before `next(e)` and the outcome after it, from `deny` and `isError` on the result.
- **Registration is repeatable**: `session.start` runs again after every reload, and a taken command name throws, so the registration is wrapped and logged to the debug log.
- **Pure logic stays plain**: `hooks/tally.ts` holds the counting and wording with no `$`, so the tests call it directly.

The count lives in a module variable on purpose: it starts over on every reload, which is the honest scope of "since this mod loaded". Move it to `$.state` to survive reloads, or to `$.store` to survive sessions.

## Files

| File                         | Role                                                          |
| :--------------------------- | :------------------------------------------------------------ |
| `.claude-plugin/plugin.json` | The manifest. Change `name`, `description`, and `author`.     |
| `hooks/hooks.json`           | Names the one hooks module under `modules`                    |
| `hooks/register.ts`          | The hooks module: `session.start`, `tool.call`, `command.run` |
| `hooks/tally.ts`             | Pure counting and wording                                     |
| `tests/register.test.ts`     | Unit tests of `tally.ts` and kit tests of the hooks           |

## Check it

From this directory:

```bash
claude plugin validate .
claude plugin test .
claude -p "/tool-tally" --plugin-dir .
```

The last command loads the mod headlessly and runs the command without a model turn. On 2.1.321 it printed `tool-tally: 0 tool calls since this mod loaded: 0 succeeded, 0 failed, 0 refused.` with zero turns and zero cost. For an interactive check, run `claude --plugin-dir .`, ask Claude to read a few files, then run `/tool-tally`.

Verified on 2026-11-12: validate and test passed on Claude Code 2.1.295, 2.1.309, 2.1.316, and 2.1.321, and the type-check passed against the 2.1.321 declarations. Mods need Claude Code 2.1.287 or later in a terminal and 2.1.286 or later in the Desktop app.
