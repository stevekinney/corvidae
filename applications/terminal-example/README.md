# Terminal example

`@lostgradient/terminal-example` is a local development tool: one command gives you a working browser terminal backed by a process on your own machine. It is the reference for wiring [`@lostgradient/terminal`](../../components/terminal/README.md) in the browser to [`@lostgradient/ventriloquist`](../../packages/ventriloquist/README.md) on a Bun server, and the place the terminal's behavior is proven in a real browser. It is not a public shell service. It starts shells, so it listens on a loopback address only and refuses to run anywhere else.

## Run it

From the corvidae root, after `bun install --frozen-lockfile`:

```sh
bun run --filter=@lostgradient/terminal-example dev
```

`dev` builds the client and then starts the server, which prints the address it listens on and a _start URL_ such as `http://127.0.0.1:54240/?token=…`. Open the start URL, not the bare address: it carries a random token the server made when it started, the browser trades it for a session cookie, and the address bar is then cleaned to `http://127.0.0.1:54240/`. Opening the bare address without having done that shows a page that says where to find the start URL. There is no file watcher: stop the server with Ctrl+C and run `dev` again after a change.

- `bun run --filter=@lostgradient/terminal-example build` bundles the client into `build/` and does nothing else. It is the only task that writes there.
- `bun run --filter=@lostgradient/terminal-example start` serves an existing `build/`. It refuses to start, and says to build first, when there is none.
- `--hostname`, `--port`, `--start-token` and `--browsers` go after the command, for example `bun src/server/main.ts --port 54300` from this directory. The port must be a whole number from 1 to 65535: the one origin the server accepts is decided before it listens, so `0` is not allowed. `--start-token` (at least 16 characters) chooses the token instead of a random one, which a script needs and which then shows in the process list; `--browsers` is how many browsers the start URL admits. With more than one, the `/?token=…` URL can stay in a browser's history while admissions remain, so anyone with access to that history can still enroll with it until they are all spent or the server restarts.

Binding anything but a loopback address (`127.0.0.1`, `::1` or `localhost`) fails before a socket exists. The message names the address and the allowed ones, and the exit code is `2`:

```sh
bun src/server/main.ts --hostname 0.0.0.0
```

### The start URL

Any process on this machine can reach a loopback port, and a web page you visit can make your browser reach it too, so the port alone is not a credential. The start URL is. A browser is enrolled only by a top-level navigation (the browser's own `Sec-Fetch-Site` is `none` or `same-origin`, and `Sec-Fetch-Dest` is `document`; a page on another site cannot forge either) to `/?token=…` with the right token. Anything else, with or without a token, gets a page that explains and no cookie, and no `HEAD` request enrolls.

The token admits one browser by default, which is the choice this example makes (the alternative is binding it to a first browser and refusing others): the first enrollment spends it, a second browser gets `403` and is told to restart the server, and the browser that already holds the cookie can open the URL again without spending anything. `--browsers 3` admits three. Restarting the server makes a new token and forgets every browser.

The consequence of sharing the start URL, in a chat, a screenshot or a shell history, is that whoever opens it first gets a shell as you on this machine. Treat it like a password. Enrollment needs a browser that sends fetch metadata (`Sec-Fetch-Site` and `Sec-Fetch-Dest`), which current Chromium, Firefox and Safari 16.4 or later do. An older browser, such as Safari before 16.4, cannot enroll, and the page it is shown says so as a possible reason. The token is compared in constant time and never appears in a response.

The Ctrl+C that stops the server first revokes every session and waits for each process to be cleaned up.

## What is in the page

The page renders the `Terminal` component and offers five server-owned profiles. The page picks an identifier and whether it wants to be read-only, and nothing else: it never sends an executable, an argument, a working directory or an environment, and the server refuses a request that carries any of them.

- `shell`: your login shell, `$SHELL -l` (or the shell your account records when `$SHELL` is unset), on a pseudo-terminal, started in your home directory. Its environment is explicit rather than inherited: `TERM`, `COLORTERM`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG` and `PATH` from the host. There is no fallback shell: a missing one is reported as unavailable.
- `fullscreen`: a small committed `sh` program that takes over the alternate screen, counts the keys it is given and leaves on `q`. A committed script rather than `vi` or `less` so it behaves the same on every host.
- `diagnostic`: a committed `sh` program on pipes, with standard output and standard error in two `Terminal` views side by side. It reads no input and exits with status 3.
- `readonly-output`: a read-only replay of a committed byte fixture (`src/server/fixtures/replay.ansi`, colour, Unicode, a carriage-return rewrite and enough lines to scroll) that is the same bytes every time.

- `links`: a read-only replay of a committed fixture (`src/server/fixtures/links.ansi`) with visible HTTPS text, a hidden OSC 8 destination, a path, a command scheme, an insecure address and a download-looking address, for reviewing the host-enabled link behavior.

The contract froze the identifiers `shell`, `readonly-output` and `diagnostic`; `fullscreen` and `links` are the behaviors this example adds. A profile with no input channel (`diagnostic` and `readonly-output`) is granted read-only whatever the page asks for.

What to try, each of which `bun run --filter=@lostgradient/terminal-example test:browser` also proves:

- **Restart is a new session.** When the process exits or the connection ends, the terminal offers `New session` once the server has finished cleaning up. It starts empty: nothing from the earlier session is replayed, including input typed while the connection was down. The terminal's recovery actions are wired to the page's own handlers (`onNewSession`, `onTryAgain`, `onRetry`, `onCheckCleanup`, `onCancel`, and `cleanupPending`).
- **Disconnect handling.** `Drop connection` closes the socket the way a lost network would. Input freezes at once, the page says `Disconnected` (not `Process exited`), and the server ends the shell and its children. Reloading the page does the same, and the new page gets a new shell.
- **Paste review.** Pasting text with a line break opens a review that shows the line breaks and controls before anything is sent.
- **Search, accessible output and export.** The toolbar under the output searches the retained text, clears it locally, and opens a snapshot dialog you can read, copy or download. `Announce output` mirrors output to a screen-reader live region. Both are bounded; the [terminal README](../../components/terminal/README.md) lists the bounds.
- **Read-only mode.** `Open read-only` asks for a read-only grant. The server then gives the session no input and no resize, the terminal sends nothing (not even its automatic replies to terminal queries), and selection and scrolling still work.
- **Mouse reporting.** `Report the mouse` opts the terminal in to sending mouse reports to a program that asks for them, only while `Capture terminal keys` is on and the session is writable.

## Review controls

The `Review controls` section of the page (collapsed by default) exists for the human review in `documentation/terminal/review-runbook.md`. It lets a reviewer put the terminal into each state of the specification and hold it there. None of it lets the page choose an executable, argument, directory or environment: the server still owns every profile, and the controls only change what the page shows or when it acts.

- **Theme**: `Light` and `Dark` set `data-theme` on the page.
- **Empty**: `?autostart=off` on the address (after the start URL has enrolled the browser), or `Show empty`, leaves the page in `empty` with `New session`.
- **Loading and connecting**: `Hold the next session at` waits at the page's own `loading` step (before it asks the server for a session) or `connecting` step (before it opens the socket) until `Release held session`. `Cancel` works while held. This delays the page's steps only.
- **Denied and failed**: `Make the next session end in` sends a ticket the server never issued (the server denies the upgrade) or asks for a profile the server does not have (the server answers `400`). Both refusals are the real server's.
- **Backpressure and cleanup incomplete**: injected. A real stalled process did not hold backpressure (the session ended as `failed` instead), so `Inject backpressure` hands the terminal the state; `Cancel` then leaves the session and its output alone, and `Clear the injected state` is the capacity acknowledgement. `Inject cleanup incomplete` ends the session and hands the terminal that state; `Check cleanup` reads the real cleanup result. A real `cleanup-incomplete` still comes from a background job (see Limits).
- **Engine load failed**: injected. `Inject engine load failure` passes the state; the terminal's own `Retry` hands control back. `Remove the toolbar in 8 seconds` does the same after a delay, which removes the `Export` button while its dialog can be open.
- **Links**: `Open visible HTTPS links` turns `onLinkActivate` on (off by default). The page opens the visible HTTPS address in a new tab with `noopener`.

Every injected state is named as injected in the page, beside the session's own state.

## How it is wired

```
browser                                         Bun server (127.0.0.1)
GET /?token=… (top-level)       ───────────────▶ token checked, Set-Cookie (HttpOnly), 303 to /
GET /                          ───────────────▶ serves build/index.html to an enrolled browser
POST /session {profile,readOnly} ─────────────▶ waits for the last session's cleanup, issues {sessionId, ticket}
new WebSocket(/terminal?profile=…) ───────────▶ origin, cookie, profile name: then upgrade
hello {sessionId, token: ticket} ─────────────▶ ticket redeemed once, profile resolved, process started
output, input, resize, acknowledgements ◀────▶  one attachment, one process
```

- `src/server/application.ts` is the request handler. It checks the `Host` header against the served authority (a different name is a `421`, which is how DNS rebinding arrives), serves only the files the build wrote, and routes `/terminal` to `createTerminalWebSocketServer` from `@lostgradient/ventriloquist/websocket`.
- **One origin.** `allowedOrigins` holds the served origin and nothing else, and `allowInsecureLoopback` is on with `boundHostname` set to the address given to `Bun.serve`, which the package requires for that switch. A `null`, missing, foreign or different-port origin is refused before authentication. `trustedProxies` is left empty: there is no proxy, so the scheme comes from the URL and an `X-Forwarded-Proto` header is never read.
- **The cookie.** The start URL gives each browser an unguessable `terminal-example-session-<port>` cookie that is `HttpOnly` (page script cannot read it) and `SameSite=Strict`, and has no `Secure` attribute only because the example serves plain HTTP on loopback. The port is in the name so two instances on one host do not overwrite each other's cookie. It identifies the browser; the server remembers it, with that browser's one terminal slot (`slotFor`), in `src/server/session-store.ts`, up to 32 browsers and 60 enrollments a minute. A browser whose slot holds a live or quarantined session is never forgotten to make room: a newcomer is refused with `503 The server is full` instead. Nothing is persisted: restarting the server forgets every browser.
- **The ticket.** Because script cannot read the cookie, `POST /session` is how the page asks for a session. It needs the cookie, the served origin and a JSON body of exactly `profile` and `readOnly`, at most 1024 bytes (it answers `411` without a `Content-Length`, and `413` on a declared or actual length over the limit before reading more, and the listener itself caps any request body at 4 KiB), and it answers with a fresh session identity and a one-time ticket, which the page sends as the `hello` token. The server redeems it once, for that browser and that session, within 30 seconds. The upgrade URL carries only `?profile=`; the package refuses any other query key.
- **Profiles are the server's.** `src/server/profiles.ts` turns an identifier into a launch: the mode, the executable, its arguments, the directory and the whole environment. Nothing the page sends reaches a process.
- **One session per browser.** A reload or a restart arrives while the last shell is still being cleaned up, so `POST /session` waits for that cleanup (up to 15 seconds, then `409`) before issuing the next ticket. `GET /session/status` reports `free`, `busy` or `quarantined`, which the page polls after a session ends so `New session` is offered only when it will work.
- **Cleanup.** A closed page, a dropped socket, `End session` and Ctrl+C on the server all end the session with `SIGHUP` to the shell, then `TERM` and then `KILL` to every process in the terminal's session, background and stopped jobs included.

### The Content-Security-Policy

Every response carries the policy COR-483 proved the selected engine under (`src/server/content-security-policy.ts`):

```
default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; worker-src 'self' blob:; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; script-src 'self'; connect-src 'self'
```

`@xterm/xterm` needs `script-src 'self'` and no `'wasm-unsafe-eval'`, and the page's only network destinations are its own origin: the session request and the WebSocket upgrade, which `connect-src 'self'` covers. `style-src` allows inline styles because Svelte injects the component stylesheets and the engine positions its cells with style attributes. The first browser check fails on any policy violation or page error.

### The client

`src/client/` is a Svelte application bundled with Bun, not Vite: `scripts/build.ts` calls `buildBrowser` from `@lostgradient/testing`, which owns the Svelte plugin and the WebAssembly handling, with `src/client/index.html` as the entry. `session-model.svelte.ts` holds the one session's state in the order the contract requires: ask for a session, connect with a new `TerminalWebSocketClient`, show what the transport reports, and after any end wait for the server's cleanup before offering a replacement. It never reconnects, replays or reuses a client. The pipe demo gives each view a `channelView` of one client, so each shows one channel and reports the other's bytes parsed.

## Limits

- A background job the shell starts with `&`, and a job stopped with Ctrl+Z, belong to the terminal's session, so ending the session ends them and cleanup is `complete`: a new session is offered as usual. Only a process that deliberately leaves the session, through `setsid` or a double-fork daemon, is beyond cleanup. The host cannot prove it is gone and reports cleanup `unknown`: the slot is quarantined, the terminal shows `Cleanup incomplete` with no `New session`, and the server has to be restarted. The browser checks start a background job to show that it no longer does this, and a `setsid` job to show that it does.
- It is a development tool: no authentication beyond the loopback cookie, no TLS, no persistence, no sharing between viewers, and one server-owned set of profiles.
- Tabs, splits, user-defined profiles, shell integration (working-directory tracking, command marks) and persistence across a restart are host concerns this example does not provide. See the [terminal README](../../components/terminal/README.md).

## Tests

- `bun run --filter=@lostgradient/terminal-example test` runs the colocated unit tests: the configuration, the cookie and ticket store, the profile table and fixture, the policy, every route and refusal of the request handler (with a stand-in for the process, so no shell starts), and the client's request and channel code.
- `bun run --filter=@lostgradient/terminal-example test:browser` builds the client and runs the Playwright checks (`bun --bun playwright test`) against the built application on loopback, in Chromium. It starts the server with `SHELL=/bin/sh` so a personal shell configuration cannot change what the checks see. The ports and the start token are chosen free and random when the Playwright configuration first loads, so concurrent runs on one host do not collide. It needs Chromium (`bunx playwright install chromium`). The checks:
  - type into the login shell and see the output, with no policy violation;
  - resize: narrowing the viewport changes the size `stty` reports;
  - reload into a new session and the old shell ends;
  - no child process survives after the page closes (the shell and a foreground child both end);
  - a cross-origin upgrade is denied, from a socket with a foreign `Origin` and from a page on another origin, with the admitted origin as the control;
  - a `hello` needs a ticket issued to this browser for this session, once;
  - the policy, the cookie flags, and a foreign origin on `POST /session`;
  - the non-loopback refusal and its exit code;
  - the start URL: no token or a wrong one enrolls nothing, a page on another origin cannot enroll the browser, the printed URL opens the terminal, it admits one browser (or `--browsers` many), and the request body is bounded;
  - the profiles, read-only mode, disconnect, exit and restart, paste review, search and export, and cleanup of background and escaped jobs;
  - the review controls (`tests/review-controls.playwright.ts`): theme, `?autostart=off`, held loading and connecting with `Cancel`, a real denial and a real failure, injected engine failure, backpressure and cleanup incomplete, the links profile with links off and on, and focus after the `Export` button is removed.

The Playwright checks are a separate script rather than part of `test`, like the playground's `test:browser` and the root `test:browser:terminal`: browser suites with real shells and a fixed port are explicit commands and are not part of the turbo `test` or `validate` graph.
