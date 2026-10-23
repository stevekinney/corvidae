# Credentials

Read this when a step needs a credential that a script does not already resolve for itself. Credentials are not ambient shell state, and a run must never print one. `scripts/chef/credentials.ts` finds a credential and hands it to a command without showing it.

```bash
bun scripts/chef/credentials.ts resolve TYPESAFE_API_KEY
bun scripts/chef/credentials.ts exec LINEAR_API_KEY -- bun scripts/chef/linear.ts read COR-123
```

`resolve` prints the source, never the value: `environment`, `keychain`, `.env:<path>`, or `unavailable`. It exits 0 when the credential is found and 1 when it is not. `exec` sets the variable for the command that follows `--`, passes its stdio through, and exits with the command's code, or 3 when the value is unavailable. `--keychain-service <service>` overrides the Keychain service. The defaults are `typesafe-api` for `TYPESAFE_API_KEY`, `linear-api` for `LINEAR_API_KEY`, `anthropic-api` for `ANTHROPIC_API_KEY`, and `turborepo-remote-cache` for `TURBO_TOKEN`.

The lookup order is fixed:

- the environment;
- the macOS Keychain, with the service above and an account equal to the variable name, read only on macOS (`security find-generic-password -s <service> -a <NAME> -w`);
- a `.env` file in the current worktree's root;
- a `.env` file in the main checkout's root;
- unavailable.

A value is usable only when it is printable ASCII with no whitespace and no control character. Anything else (a trailing newline, curly quotes pasted into a `.env`) would make the HTTP or spawn layer fail with an error message that quotes the whole value, so the resolver skips that source, goes on to the next, and reports only the source it skipped. Scripts report a network or spawn failure by the error's name, never its message.

Bun loads `.env` from the current directory into the environment before a script runs, and nothing scoped to these scripts turns that off (`bun --no-env-file` and `env = false` in `bunfig.toml` are global). From a directory that holds a `.env`, a value that came from it is therefore reported as `environment`; the precedence is unchanged, only the label differs.

`linear.ts` and `jev.ts` call this resolver themselves, so a wrapper is only needed for other commands. Personal wrappers such as `with-turborepo-cache` and `with-linear-credentials` are conveniences that one machine may have; do not depend on them in a charter, and do not assume a teammate has them.

Never print, echo, log, or write a credential value: not to the terminal, a note, a log, a commit, a pull request, an issue, a recorded command line, or a worker charter. A charter names the variable and the command, never the value. Never copy a `.env` file or a credential between worktrees. When a credential is unavailable, the dependent step reports that it is unavailable; a skill does not grant a missing credential. For Jev specifically, unavailable means the decision goes back to the coordinator or the owner, as [decisions](decisions.md) describes.
