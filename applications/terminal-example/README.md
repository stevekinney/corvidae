# Terminal example

`@lostgradient/terminal-example` is a local development tool: one command gives you a working browser terminal backed by a process on your own machine. It is the reference for wiring [`@lostgradient/terminal`](../../components/terminal/README.md) in the browser to [`@lostgradient/ventriloquist`](../../packages/ventriloquist/README.md) on a Bun server, and the place the terminal's behavior is proven in a real browser. It is not a public shell service. It starts shells, so it listens on a loopback address only and refuses to run anywhere else.

## Run it

From the corvidae root, after `bun install --frozen-lockfile`:

```sh
bun run --filter=@lostgradient/terminal-example dev
```

`dev` builds the client and then starts the server, which prints `Terminal example listening on http://127.0.0.1:54240`. Open that address. There is no file watcher: stop the server with Ctrl+C and run `dev` again after a change.

- `bun run --filter=@lostgradient/terminal-example build` bundles the client into `build/` and does nothing else. It is the only task that writes there.
- `bun run --filter=@lostgradient/terminal-example start` serves an existing `build/`. It refuses to start, and says to build first, when there is none.
- `--hostname` and `--port` go after the command, for example `bun src/server/main.ts --port 54300` from this directory. The port must be a whole number from 1 to 65535: the one origin the server accepts is decided before it listens, so `0` is not allowed.

Binding anything but a loopback address (`127.0.0.1`, `::1` or `localhost`) fails before a socket exists. The message names the address and the allowed ones, and the exit code is `2`:

```sh
bun src/server/main.ts --hostname 0.0.0.0
```

The Ctrl+C that stops the server first revokes every session and waits for each process to be cleaned up.

## What is in the page

The page renders the `Terminal` component and offers four server-owned profiles. The page picks an identifier and whether it wants to be read-only, and nothing else: it never sends an executable, an argument, a working directory or an environment, and the server refuses a request that carries any of them.

- `shell`: your login shell, `$SHELL -l` (or the shell your account records when `$SHELL` is unset), on a pseudo-terminal, started in your home directory. Its environment is explicit rather than inherited: `TERM`, `COLORTERM`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG` and `PATH` from the host. There is no fallback shell: a missing one is reported as unavailable.
- `fullscreen`: a small committed `sh` program that takes over the alternate screen, counts the keys it is given and leaves on `q`. A committed script rather than `vi` or `less` so it behaves the same on every host.
- `diagnostic`: a committed `sh` program on pipes, with standard output and standard error in two `Terminal` views side by side. It reads no input and exits with status 3.
- `readonly-output`: a read-only replay of a committed byte fixture (`src/server/fixtures/replay.ansi`, colour, Unicode, a carriage-return rewrite and enough lines to scroll) that is the same bytes every time.

The contract froze the identifiers `shell`, `readonly-output` and `diagnostic`; `fullscreen` is the fourth behavior. A profile with no input channel (`diagnostic` and `readonly-output`) is granted read-only whatever the page asks for.

What to try, each of which `bun run --filter=@lostgradient/terminal-example test:browser` also proves:

- **Restart is a new session.** When the process exits or the connection ends, the terminal offers `New session` once the server has finished cleaning up. It starts empty: nothing from the earlier session is replayed, including input typed while the connection was down. The terminal's recovery actions are wired to the page's own handlers (`onNewSession`, `onTryAgain`, `onRetry`, `onCheckCleanup`, `onCancel`, and `cleanupPending`).
- **Disconnect handling.** `Drop connection` closes the socket the way a lost network would. Input freezes at once, the page says `Disconnected` (not `Process exited`), and the server ends the shell and its children. Reloading the page does the same, and the new page gets a new shell.
- **Paste review.** Pasting text with a line break opens a review that shows the line breaks and controls before anything is sent.
- **Search, accessible output and export.** The toolbar under the output searches the retained text, clears it locally, and opens a snapshot dialog you can read, copy or download. `Announce output` mirrors output to a screen-reader live region. Both are bounded; the [terminal README](../../components/terminal/README.md) lists the bounds.
- **Read-only mode.** `Open read-only` asks for a read-only grant. The server then gives the session no input and no resize, the terminal sends nothing (not even its automatic replies to terminal queries), and selection and scrolling still work.
- **Mouse reporting.** `Report the mouse` opts the terminal in to sending mouse reports to a program that asks for them, only while `Capture terminal keys` is on and the session is writable.

## How it is wired

```
browser                                         Bun server (127.0.0.1)
GET /                          ───────────────▶ serves build/index.html, Set-Cookie (HttpOnly)
POST /session {profile,readOnly} ─────────────▶ waits for the last session's cleanup, issues {sessionId, ticket}
new WebSocket(/terminal?profile=…) ───────────▶ origin, cookie, profile name: then upgrade
hello {sessionId, token: ticket} ─────────────▶ ticket redeemed once, profile resolved, process started
output, input, resize, acknowledgements ◀────▶  one attachment, one process
```

- `src/server/application.ts` is the request handler. It checks the `Host` header against the served authority (a different name is a `421`, which is how DNS rebinding arrives), serves only the files the build wrote, and routes `/terminal` to `createTerminalWebSocketServer` from `@lostgradient/ventriloquist/websocket`.
- **One origin.** `allowedOrigins` holds the served origin and nothing else, and `allowInsecureLoopback` is on with `boundHostname` set to the address given to `Bun.serve`, which the package requires for that switch. A `null`, missing, foreign or different-port origin is refused before authentication. `trustedProxies` is left empty: there is no proxy, so the scheme comes from the URL and an `X-Forwarded-Proto` header is never read.
- **The cookie.** `GET /` gives each browser an unguessable `terminal-example-session` cookie that is `HttpOnly` (page script cannot read it) and `SameSite=Strict`, and has no `Secure` attribute only because the example serves plain HTTP on loopback. It identifies the browser; the server remembers it, with that browser's one terminal slot (`slotFor`), in `src/server/session-store.ts`. Nothing is persisted: restarting the server forgets every browser.
- **The ticket.** Because script cannot read the cookie, `POST /session` is how the page asks for a session. It needs the cookie, the served origin and a JSON body of exactly `profile` and `readOnly`, and it answers with a fresh session identity and a one-time ticket, which the page sends as the `hello` token. The server redeems it once, for that browser and that session, within 30 seconds. The upgrade URL carries only `?profile=`; the package refuses any other query key.
- **Profiles are the server's.** `src/server/profiles.ts` turns an identifier into a launch: the mode, the executable, its arguments, the directory and the whole environment. Nothing the page sends reaches a process.
- **One session per browser.** A reload or a restart arrives while the last shell is still being cleaned up, so `POST /session` waits for that cleanup (up to 15 seconds, then `409`) before issuing the next ticket. `GET /session/status` reports `free`, `busy` or `quarantined`, which the page polls after a session ends so `New session` is offered only when it will work.
- **Cleanup.** A closed page, a dropped socket, `End session` and Ctrl+C on the server all end the session's whole process group with `TERM` and then `KILL`.

### The Content-Security-Policy

Every response carries the policy COR-483 proved the selected engine under (`src/server/content-security-policy.ts`):

```
default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; worker-src 'self' blob:; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; script-src 'self'; connect-src 'self'
```

`@xterm/xterm` needs `script-src 'self'` and no `'wasm-unsafe-eval'`, and the page's only network destinations are its own origin: the session request and the WebSocket upgrade, which `connect-src 'self'` covers. `style-src` allows inline styles because Svelte injects the component stylesheets and the engine positions its cells with style attributes. The first browser check fails on any policy violation or page error.

### The client

`src/client/` is a Svelte application bundled with Bun, not Vite: `scripts/build.ts` calls `buildBrowser` from `@lostgradient/testing`, which owns the Svelte plugin and the WebAssembly handling, with `src/client/index.html` as the entry. `session-model.svelte.ts` holds the one session's state in the order the contract requires: ask for a session, connect with a new `TerminalWebSocketClient`, show what the transport reports, and after any end wait for the server's cleanup before offering a replacement. It never reconnects, replays or reuses a client. The pipe demo gives each view a `channelView` of one client, so each shows one channel and reports the other's bytes parsed.

## Limits

- A background job the shell starts with `&` is put in a process group of its own, which is beyond the group cleanup owns. The host can see it, cannot prove it is gone, and reports cleanup `unknown`: the slot is quarantined, the terminal shows `Cleanup incomplete` with no `New session`, and the server has to be restarted. A foreground child, such as `sleep 300` typed at the prompt, is ended with the shell. The browser checks start a background job on purpose to show this.
- It is a development tool: no authentication beyond the loopback cookie, no TLS, no persistence, no sharing between viewers, and one server-owned set of profiles.
- Tabs, splits, user-defined profiles, shell integration (working-directory tracking, command marks) and persistence across a restart are host concerns this example does not provide. See the [terminal README](../../components/terminal/README.md).

## Tests

- `bun run --filter=@lostgradient/terminal-example test` runs the colocated unit tests: the configuration, the cookie and ticket store, the profile table and fixture, the policy, every route and refusal of the request handler (with a stand-in for the process, so no shell starts), and the client's request and channel code.
- `bun run --filter=@lostgradient/terminal-example test:browser` builds the client and runs the Playwright checks (`bun --bun playwright test`) against the built application on loopback, in Chromium. It starts the server with `SHELL=/bin/sh` so a personal shell configuration cannot change what the checks see, on port 54241. It needs Chromium (`bunx playwright install chromium`). The checks:
  - type into the login shell and see the output, with no policy violation;
  - resize: narrowing the viewport changes the size `stty` reports;
  - reload into a new session and the old shell ends;
  - no child process survives after the page closes (the shell and a foreground child both end);
  - a cross-origin upgrade is denied, from a socket with a foreign `Origin` and from a page on another origin, with the admitted origin as the control;
  - a `hello` needs a ticket issued to this browser for this session, once;
  - the policy, the cookie flags, and a foreign origin on `POST /session`;
  - the non-loopback refusal and its exit code;
  - the four profiles, read-only mode, disconnect, exit and restart, paste review, search and export, and the background-job limit.

The Playwright checks are a separate script rather than part of `test`, like the playground's `test:browser` and the root `test:browser:terminal`: browser suites with real shells and a fixed port are explicit commands and are not part of the turbo `test` or `validate` graph.
