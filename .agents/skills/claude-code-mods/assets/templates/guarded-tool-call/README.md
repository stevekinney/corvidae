# protected-paths

A middleware template with an explicit failure policy for each hook:

- **A fail-closed guard**: `tool.call` on `Edit`, `Write`, and `NotebookEdit` refuses writes to `.env` files and to files inside `.git`, judging both the path as written and where it lands with links followed (`$.fs.stat(path, { resolve: true })`). Its `.catch` handler refuses the write when the check itself throws or runs out of time, and replays the settled result instead of running the tool again when the failure came after `next`.
- **A confirmation hold**: `tool.call` on `Bash` asks the person with `$.ui.ask` before a recursive delete, a hard reset, a force push, or `git clean`. Every answer except the explicit confirmation refuses, including a dismissed question and a `claude -p` run with nobody to ask.
- **A fail-open observer**: an outer `tool.call` hook logs each outcome to the debug log and returns the result unchanged. A reporting failure never changes what Claude reads and never runs the tool twice.

`claude plugin validate .` reports the two guards as `gating hook with .catch` and the observer as `gating hook without .catch`, which is the intended split.

## What this does not protect

These are reminders that steer Claude, not a security boundary. The pattern match misses spellings it does not list, a different tool or a shell command can reach the same files, and another mod's `$.fs` calls never pass through `tool.call`. A refusal returned after `next(e)` withholds the result from Claude and undoes nothing the tool did. Protect what matters with file permissions, branch protection, or a policy mod your organization installs.

## Files

| File                         | Role                                                            |
| :--------------------------- | :-------------------------------------------------------------- |
| `.claude-plugin/plugin.json` | The manifest. Change `name`, `description`, and `author`.       |
| `hooks/hooks.json`           | Names the one hooks module                                      |
| `hooks/register.ts`          | The three hooks and their `.catch` handlers                     |
| `hooks/policy.ts`            | Pure rules: protected spellings, risky commands, outcome labels |
| `tests/register.test.ts`     | Unit tests of the rules and kit tests of each failure path      |

The kit tests make the guard's own `$.fs.stat` call reject by answering it with `{ deny }`, which is how they reach the `.catch` handler. A stub that throws is skipped instead and would not exercise it.

## Check it

From this directory:

```bash
claude plugin validate .
claude plugin test .
```

Verified on 2026-11-12: validate and test passed on Claude Code 2.1.295, 2.1.309, 2.1.316, and 2.1.321, and the type-check passed against the 2.1.321 declarations. The hold was exercised only through the test kit, which answers `$.ui.ask` with a stubbed `AskUserQuestion` call; try it in an interactive session before relying on it.
