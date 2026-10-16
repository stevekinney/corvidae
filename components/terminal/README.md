# @lostgradient/terminal

`@lostgradient/terminal` is the browser terminal component for Corvidae. It renders terminal sessions with the engine the [terminal contract](../../documentation/terminal/contract.md) selected, `@xterm/xterm`, composed with [Cinder](../cinder/README.md) components. Its entry exports the [`Terminal` component](./src/lib/components/terminal/README.md), the engine identity and the WebSocket client described below; the session controller arrives in a later issue.

## Workspace usage

Declare `"@lostgradient/terminal": "workspace:*"` in the consuming workspace's dependencies and run `bun install` from the Corvidae root. The package is private and exports TypeScript and Svelte source directly, so the consuming application compiles it and there is no build step. Shared external versions come from the root Bun catalog.

## Use it inside corvidae

The [terminal example application](../../applications/terminal-example/README.md) is the reference. Run `bun run --filter=@lostgradient/terminal-example dev` from the Corvidae root and open the start URL it prints to get a working terminal backed by a Bun PTY. Its `src/client/` shows the browser half of the wiring below and its `src/server/` the host half.

The page side is one `Terminal` and one `TerminalWebSocketClient` per session:

```svelte
<script lang="ts">
  import { Terminal, TerminalWebSocketClient, type TerminalState } from '@lostgradient/terminal';

  // `sessionId` and `ticket` come from your own host (see "Authorized WebSocket wiring").
  const { sessionId, ticket }: { sessionId: string; ticket: string } = $props();

  let state = $state<TerminalState>('connecting');
  const client = new TerminalWebSocketClient({
    url: `wss://${window.location.host}/terminal?profile=shell`,
    sessionId,
    ticket,
  });
  client.subscribeState((next) => (state = next));
  void client.connect().catch(() => undefined);
</script>

<!-- Give the ancestor a definite height: the terminal fills it. -->
<div style="height: 28rem;">
  <Terminal
    title="Shell"
    {state}
    controller={client}
    onGeometryChange={(size) => client.sendResize(size.columns, size.rows)}
  />
</div>
```

The client is the controller: it has the `subscribeOutput`, `rendererFailed` and `input` the component takes, and its state is already one of the component's states. A new session is a new client, and a new `Terminal` (or `{#key}`) so the new engine starts empty. Pass `onNewSession`, `onTryAgain`, `onRetry`, `onCheckCleanup` and `onCancel` to offer the recovery actions the [component README](./src/lib/components/terminal/README.md) describes; each button appears only when its handler is given. The example's `session-model.svelte.ts` is a complete model of that loop.

## CSS

Importing the component module pulls in two stylesheets: the engine's own `@xterm/xterm/css/xterm.css`, which positions its helper textarea, accessibility tree and scrollbar, and `terminal.css`, which sizes the frame and sets the viewport, the reader's inset, focus ring and error text. The package declares `**/*.css` as a side effect, so a bundler must keep them. `terminal.css` is written in Cinder's `cinder.components` layer and reads only Cinder tokens, so a Cinder theme (light, dark, or a scoped override) reaches the terminal with no other setup. The engine paints with concrete colors, so the component resolves these tokens against its own element and passes them as the engine theme:

- the foreground, background, cursor and selection colors come from `--cinder-text-default`, `--cinder-surface-inset` and `--cinder-accent-solid`;
- the sixteen ANSI colors come from the `--cinder-terminal-ansi-*` tokens.

Importing `@lostgradient/cinder` supplies the base and component stylesheets the toolbar buttons and dialogs use. Svelte can inject a component's styles from script, and the engine positions its cells with style attributes, so a Content-Security-Policy needs `style-src 'unsafe-inline'`. The terminal needs `script-src 'self'` and no `'wasm-unsafe-eval'`, and the WebSocket needs `connect-src 'self'` for a same-origin host. The example sends the full policy COR-483 proved; see its README.

## Server rendering

`Terminal` renders on a server without touching `document` or any DOM global. The server markup is the frame (a `region` named by its title), the status message for the state, and a viewport that is `inert`, so a server-rendered page never offers a field that does nothing. The engine is imported dynamically in the browser when the terminal mounts, so a server never loads it, and hydration then mounts the engine into the markup. Importing `@lostgradient/terminal` has no side effects: `bun run test:boundaries` proves it loads no engine, reads no DOM global, opens no socket and arms no timer.

## The component and controller API

The public surface is `Terminal`, `TerminalWebSocketClient` with its types, and `TERMINAL_ENGINE`. The component's props are in its [README](./src/lib/components/terminal/README.md). A controller is any object with the shape of `TerminalRendererController`:

- `subscribeOutput(listener)`: delivers ordered chunks and a `parsed` callback, and returns an unsubscribe function. The listener of the WebSocket client also receives the `channel` each chunk came from (`pty`, or `stdout` and `stderr` for a pipe), which a view that wants one channel uses to report the other's bytes parsed at once.
- `rendererFailed(failure)`: called once if the renderer fails closed, so the controller revokes input and cleans up.
- `input` (optional): `input(bytes)` returning the protocol's typed result, `authorityRevoked`, and the negotiated `terms`. Without it the terminal is a viewer.

The component borrows its controller: unmounting never stops the session. `TerminalWebSocketClient` is the one implementation this package ships. The `TerminalController` with `attach`, `write`, `readText`, `search` and `dispose` that the [contract](../../documentation/terminal/contract.md) froze is not built yet: reading, searching and clearing output are done by the component's own toolbar, and ending a session is `client.stop()` or `client.close()`.

## Pipe versus PTY

A host chooses the mode, and the client reports it as `capabilities.mode`.

- A PTY (`pty`) is one terminal with one combined stream. It takes input and resize, and the kernel's line discipline sits between the process and the page, so echo and `\n` to `\r\n` are the terminal's doing. Use it for shells and full-screen programs.
- A pipe (`pipe`) keeps standard output and standard error as two channels and has no terminal: no resize, no terminal queries, no line discipline. A pipe never silently becomes a PTY. Lines a program writes to a pipe need their own `\r\n` for a terminal view to start each line at the left margin. Show the channels in two `Terminal` views as the example's pipe demo does, or merge them yourself.
- An output-only source (a Bun Shell result or a finished log) has no process at all, so there is no input, resize or exit code, only the end of the source.

On Windows neither helper runs: the PTY helper needs a POSIX host, and the host matrix is macOS and Linux.

## Authorized WebSocket wiring

The browser carries no credential in the URL: the socket's address names one profile (`?profile=shell`), the browser sends the host's HttpOnly session cookie by itself, and the host's `authenticate` reads it. The host's `authorize` decides the whole launch (the mode, the executable, its arguments, the directory and the environment) from the profile name and a one-time `ticket` the page sends in `hello`, so a page can choose among server-owned profiles and nothing else. The host half is `createTerminalWebSocketServer` from `@lostgradient/ventriloquist/websocket`; its README lists every option, including the origin allowlist, `trustedProxies` for a TLS-terminating proxy, the loopback development switch and the required `slotFor`. The example's `src/server/application.ts` is a complete, small host.

## Custom direct integration

The WebSocket client is one transport for `@lostgradient/ventriloquist`'s neutral root export, and you can build another. `ClientEndpoint` validates every frame and builds the frames to send, and owns no transport. Implement `TerminalRendererController` over your own channel and pass it as `controller`:

```ts
import type { TerminalRendererController } from '@lostgradient/terminal';
import { ClientEndpoint } from '@lostgradient/ventriloquist';

declare const endpoint: ClientEndpoint; // attached over your own transport
declare const channel: { send(frame: string | Uint8Array): void };

const controller: TerminalRendererController = {
  subscribeOutput(listener) {
    // Call `listener(bytes, parsed)` for each output message, in order, and report `parsed()`
    // to the endpoint (`endpoint.consumeOutput(bytes.length)`) when it is called.
    return () => undefined;
  },
  rendererFailed() {
    // Revoke input and tell the host to clean up.
  },
  input: {
    input: (bytes) => endpoint.input(bytes),
    get authorityRevoked() {
      return endpoint.phase !== 'attached';
    },
    terms: endpoint.terms,
  },
};
```

You own what the client otherwise does: the state you pass as `state`, the output acknowledgements that keep the host's producer running, and what happens on a dropped transport. Read `src/lib/transport/websocket-client.ts` for the ordering the contract requires.

## Ctrl+C versus copy

A non-empty selection always wins. Ctrl+C on Linux and Cmd+C on a Mac copy it, natively, and send nothing to the process. With no selection the chord is the interrupt: Ctrl+C reaches the engine, which sends the interrupt byte (`0x03`) itself, and on a Mac Cmd+C sends it, as does the `Interrupt` button. A read-only view never sends either. Reserved browser and platform chords (Cmd+L, Ctrl+T, Ctrl+W and the assistive technology modifiers) always belong to the browser. Capture starts off, so Tab and Shift+Tab move through the page until `Capture terminal keys` sends them to the shell; Ctrl+Shift+Escape releases capture, and bare Escape is always shell input.

## Paste review

Copying the engine's selection announces `Terminal selection copied` once, and the copy itself is left to the browser; see the [component accessibility notes](./src/lib/components/terminal/terminal.a11y.md).

A paste that is multiline, carries control characters, or arrives while the program has bracketed paste on opens a review before any byte is sent. It shows the line breaks and controls, the length and whether it ends in a newline. Cancel sends nothing; Paste sends the bytes as the engine converts them, never rewritten, and says when a pasted bracket terminator would end the protected paste early. A paste over `maximumPasteBytes` (64 KiB unless the host sets 1 to 256 KiB) is refused whole.

## Read-only authority

The server decides authority. A read-only grant, a pipe with no stdin, an output-only source and a host that revoked the attachment all give a session with no input, resize or kill, and the host enforces it: a client that sends input anyway receives a typed failure and the input is never queued. The component mirrors it for feedback (the `read-only` state, no key capture, no automatic replies to terminal queries) and keeps selection, scrolling, search and export working. Asking for `requestedMode: 'read-only'` can only reduce authority, never raise it.

## Resize fitting

The engine's measured cell size is the only resize authority; the frame's own estimate is never used. The component reports `{ columns, rows }` through `onGeometryChange` once per accepted change, after at most one measurement per frame, and never from a hidden, detached or zero-size container. Send it with `client.sendResize(columns, rows)`; the host creates a PTY at its own default size, so the first report resizes it. A view that does not own the grid (a read-only or finished session) adopts `ownerGeometry` and scrolls instead of fitting.

## Normal exit, failed exit, disconnect and unknown delivery

These are different states and none is derived from another.

- **Exit.** The process ended. State `exited`, whatever its exit code, and the code or signal arrives on the client's `process-exit` event. A nonzero exit is still an exit, and end of file on a PTY or pipe is a separate event that is never read as exit code zero.
- **Failure.** Startup failed (`spawn-failed`, `unsupported-runtime`), a submitted operation failed after the host accepted it, or the protocol broke. State `failed`. A failed connection is never presented as a successful exit.
- **Denied.** The host refused the upgrade or the attachment before issuing capabilities. State `denied`, and all a browser can tell about a refused upgrade is that it closed with 1008.
- **Disconnect.** The socket ended without a host report, or the host expired the session's liveness. State `disconnected`. Input freezes at once, the process may or may not have survived (the host cleans up what the connection owned), and nothing reconnects, respawns or replays.
- **Unknown delivery.** An input or resize that the host had not answered when the transport ended is `unknown`, listed in `client.deliveryUnknown`, and is never retried or counted as sent. An accepted input only means it entered the host's queue, never that the process read it.

## Restart

A restart is a new session: a new client, a new session identity and ticket from the host, and a new terminal, started after the previous cleanup is complete. The host refuses a second attachment to a busy slot (1013) and a replacement while the slot is quarantined (1008), so wait for the host to report the slot free (the example polls `GET /session/status`) before offering `New session`. Nothing is carried across: no output, no input, no process.

## Cleanup limits

Ending a session ends the owned process group with TERM and then KILL and reports `complete` only after a probe finds the group empty, and the scope of that claim is the group:

- a descendant in a group or session of its own, such as a shell's background job started with `&`, is beyond it. The host reports `unknown` when it can see one, the slot is quarantined, and the terminal shows `cleanup-incomplete`;
- anything left running by a crashed host is beyond it, and no helper can report it;
- a group still occupied after the KILL window is `incomplete`.

Both `incomplete` and `unknown` block replacement until the host itself attests the group is gone, which this package cannot do for it. [`@lostgradient/ventriloquist`](../../packages/ventriloquist/README.md) and the [security and budgets document](../../documentation/terminal/security-and-budgets.md) define the rest.

## Bounded search and export

Search, the accessible snapshot and export read the engine's retained output and are bounded: a search query is at most 256 code points, at most 10,000 matches are kept, search reads at most 1 MiB, the accessible snapshot is at most 64 KiB, and the export is at most 1 MiB and 10,000 lines. When output is larger than a bound the newest content is kept and the dialog says that earlier output was omitted, so a truncation is never silent. Search is literal and case-sensitive, over the active buffer only. Nothing sends a byte to the process. The [component README](./src/lib/components/terminal/README.md) has the full behavior.

## Telemetry privacy

The package logs nothing. `onInspectionEvent` receives events built only from numbers, booleans and a few fixed words (a search ran, an export was truncated, a link was activated), so output, queries, keystrokes, arguments, environment and credentials cannot be in one. The WebSocket client's events carry codes, counts and the host's own short messages, never output or input bytes, and the host's ticket appears in no event, error or result. A handler that throws changes nothing.

## The selected engine

The terminal uses `@xterm/xterm` 6.0.0, exposed as `TERMINAL_ENGINE`. The [contract](../../documentation/terminal/contract.md) records the selection: the engine probe installed `ghostty-web`, `@xterm/xterm` and `@wterm/dom` in separate fresh directories under each candidate's CSP and the hard gates decided. `@xterm/xterm` and `@wterm/dom` reached a resolved Chromium state, and `ghostty-web` was rejected because its retained soft-wrap metadata cannot be trusted for the search and export projection. `@xterm/xterm` is the candidate the committed evidence selected, and it needs only `script-src 'self'`, with no WebAssembly. The engine is private: there is no engine selector, fallback engine, addon hook or option bag, and the root catalog and the tests pin the version.

## Host and extension concerns

The terminal renders one session and takes input for it. These belong to the host application, or to a later extension, and are not here: tabs and splits, user-defined profiles and their editing, shell integration (working-directory tracking, command marks, prompt detection), persistence of a session or its scrollback across a reload or a host restart, shared or multiple viewers, recording and replay, SSH, graphics protocols, and an Electrobun desktop bridge. Publishing `@lostgradient/terminal` is also later work. The supported browser is desktop Chromium; the real-browser proof also runs Firefox and WebKit, which the contract does not yet claim.

## The WebSocket client

`TerminalWebSocketClient` (`src/lib/transport/websocket-client.ts`) carries one attachment over the browser's own `WebSocket`, joined to the protocol's `ClientEndpoint`. It does not use the engine's attach or WebSocket addon. It is single-use: it connects once, reports what the host says, and when the transport ends it stays ended, with no reconnect, no replay of input and no resume. A restart is a new client for a new session.

- **Address**: a `wss:` address naming the profile (`?profile=shell`). It carries no credential. The browser sends the host's HttpOnly session cookie by itself, and an address with userinfo, or with any query parameter other than exactly one `profile`, is refused when the client is built. A plain `ws:` address is allowed only to a loopback host and only with `allowInsecureLoopback`. The `ticket` option is the host's own opaque attachment value, sent as the `hello` token. It is not the cookie and appears in no event, error or result.
- **State**: `state` is one of `empty`, `connecting`, `writable`, `read-only`, `backpressured`, `exited`, `disconnected`, `denied`, `failed` or `cleanup-incomplete`, and `subscribeState` reports changes. A dropped socket or a liveness expiry on the host is `disconnected`, and every operation still unresolved is `unknown` delivery (`deliveryUnknown` lists them). A close with 1008 before any capabilities is `denied`, which is all a browser can tell about a refused upgrade. An exit is `exited`, a startup error or a failed submitted operation is `failed`, and an incomplete or unknown cleanup is `cleanup-incomplete`.
- **Backpressure**: input refused as `fifo-full`, either locally because the operation window is full or by the host, is `backpressured`. While it holds, input and resize are refused without being sent. The next operation the host acknowledges frees the window and the state returns to `writable`, which is the transition the terminal's input path waits for before it takes input again. The host sends nothing when its own queue drains, so after a refusal with nothing in flight the client asks: it sends an _empty input_ as a capacity probe, which carries no byte for the process and which the host accepts exactly when it has an operation slot free. Probes run only while paused and idle, on an injected-clock backoff that starts at 250 ms (`probeInitialMilliseconds`), doubles on each refusal to a cap of 8 s (`probeMaximumMilliseconds`), and starts over when real input is accepted. A probe's acknowledgement returns the state to `writable`; a refusal keeps it and backs off; closing, stopping or losing the transport stops probing. A probe proves a free operation slot, not free input bytes, so if only the byte budget is full a real keystroke may pause the client again and the next probe lifts it. The host acknowledges input when it accepts it, so a process that is not reading is invisible until something is refused. A paste larger than the terminal's queue is accepted whole and then held, and the host refuses everything after it. So once the user has stopped typing and nothing is in flight, the client sends one empty input after the same first delay; an accepted one changes nothing, and a `fifo-full` refusal moves the view to `backpressured`, where the paused probe takes over. The view then returns to `writable` when the process reads again and the host accepts a probe. While the view is `backpressured` the engine takes no keystrokes, and a paste is refused as _paused_ (announced as `Terminal input paused. Keystrokes are not being sent.`), not as read-only.
- **Output**: `subscribeOutput(listener)` delivers chunks in order with a `parsed` callback, which is the only thing that acknowledges them, and the `channel` each came from (`pty`, `stdout` or `stderr`). A listener that wants one channel must still report the other channel's chunks parsed, because acknowledgements count every byte in delivery order. It reports the cumulative count of UTF-8 bytes, in delivery order, so receipt, the socket's buffer and a paint never acknowledge output. Output that arrives with no subscriber is held, bounded by the host's own output budget, and delivered to the first subscriber. Parse acknowledgements are also what keep a fast producer running: the host stops reading the process when the unacknowledged output reaches its queue limit and resumes as `parsed` reports return room, so a client that parses promptly never loses a session to `yes` or a large `cat`, and one that stops parsing pauses the process instead of ending it (see `documentation/terminal/security-and-budgets.md`).
- **Operations**: `sendInput` and `sendResize` resolve when the host answers, as `accepted` (it entered the host FIFO, which is not backend consumption), `failed`, `refused` (never sent) or `unknown`. The `input` property is the shape the terminal's input path takes. `stop()` revokes authority and resolves with the host's cleanup report, or `unknown` and a closed socket if none arrives within `stopTimeoutMilliseconds` (10 s), and `close()` ends the transport from this side.

## Boundaries

This package is browser-only and is checked by `tsconfig.browser.json`, which has the DOM library, no ambient types, and the `browser` condition. It depends on [`@lostgradient/ventriloquist`](../../packages/ventriloquist/README.md) and may import only that package's platform-neutral root export. It never imports `@lostgradient/ventriloquist/bun`, `@lostgradient/ventriloquist/websocket`, `bun:*`, or Node modules.

`bun run test:boundaries` runs three checks. Each states what it enforces and what it hands to another backstop.

- **Source imports** (`scripts/check-boundaries.ts`): every `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs` and `.svelte` file under `src/`, except test scaffolding, is parsed with the script kind its extension implies. A runtime load of `bun`, `bun:*`, a Node built-in, a ventriloquist subpath, a rejected comparison engine, or a relative path that leaves the package fails. That covers static imports, re-exports, `import x = require()`, and `import()` or `require()` with a string-literal argument, including inside Svelte `<script>` blocks and markup. Type-only imports erase before runtime and are allowed. A dynamic `import()` or `require()` whose argument is not a string literal or a plain template is a computed specifier: it cannot be resolved statically, so it fails closed. The check does not read tsconfig `paths` or bundler aliases; the browser typecheck (`tsconfig.browser.json`) is the backstop for what an alias resolves to.
- **Engine pin** (`scripts/check-boundaries.ts`): the root catalog pins `@xterm/xterm` at the contract version, this package takes it through `catalog:`, and no key in the root `catalog`, in any named `catalogs` entry, or in the same fields under an object-form `workspaces` is a rejected comparison engine (`ghostty-web`, `@wterm/*`). What Bun actually resolved is the gate: every `bun.lock` package must not be a rejected engine, `@xterm/xterm` must resolve to exactly the contract version wherever it is installed, and no lockfile workspace may declare a rejected engine. Aliases, git sources, `overrides` and `resolutions` are not parsed; the lockfile shows their result. The lockfile is only as current as the last install, and every turbo task begins with `bun install --frozen-lockfile`, which fails on a lockfile out of step with the manifests; running the check directly without that preflight reads whatever lockfile is on disk.
- **Import probe** (`scripts/import-probe.ts`): importing only `src/index.ts` under plain Bun, with no test preload and no DOM, must not load `@xterm/xterm` or a Bun-only ventriloquist entry, read, from this package's own source, the listed DOM globals (`window`, `document`, `navigator`, `HTMLElement`, `customElements`, `requestAnimationFrame`, `ResizeObserver`, `MutationObserver`), call `fetch`, `WebAssembly.compile`, `instantiate` or their streaming forms, construct `WebAssembly.Module`, `WebAssembly.Instance`, `Worker`, `SharedWorker`, `WebSocket`, `EventSource` or `XMLHttpRequest`, arm a timer with `setTimeout`, `setInterval` or `setImmediate`, add a property to `globalThis`, or throw. It sees only the modules `src/index.ts` reaches, so source that nothing under the entry imports is covered by the source-import check alone, and a computed specifier is covered by neither the probe nor the static check except by failing closed.

The import check compiles this package's own Svelte components for the server and evaluates them, so their module-level code is what it inspects. Another workspace's components are not compiled, and a guarded DOM read made by a dependency while it imports (Cinder's does) is not counted against this package; the server-render test owns that. The engine is imported dynamically when a terminal mounts, so a server never loads it.

## Commands

- `bun run typecheck`: `svelte-check` against the browser program and then the Bun-typed program that also covers tests and scripts.
- `bun run test`: the colocated `*.test.ts` files under `src/`, plus the boundary tests, with the `browser` and `svelte` conditions.
- `bun run test:renderer`: the component's colocated tests under `src/lib/components/terminal`: lifecycle, the accepted parse boundary, geometry, fail-closed behavior, inert output, server render and hydration, and the shared byte corpus checked against declared oracles. An empty selection fails.
- `bun run test:input`: the input path under `src/lib/input`: engine reports to exact outbound bytes (text as UTF-8, binary as raw bytes), key routing, key capture, paste review and chunking, authority and freezing, IME and dead keys, read-only selection and scrolling, and the Terminal component's capture button and review dialog. An empty selection fails.
- `bun run test:inspection`: the output tools under `src/lib/inspection`: bounded literal search (retained buffer only, alternate screen, eviction, reflow) with the match selected in the terminal, newest-first truncation at every bound, the three local clears with writes pending, the Export dialog (empty, truncated, stale, replaced, close and reopen, Download), visible-HTTPS link listing, extraction after exit, zero input bytes, and metric redaction. An empty selection fails.
- `bun run test:transport`: the WebSocket client under `src/lib/transport`: connecting and refusal, operations and results, output acknowledgement, backpressure with the terminal's input path, ending and stopping, and a loopback suite that runs the client against the real server from `@lostgradient/ventriloquist/websocket`. Only test files import that subpath; the boundary check covers source. An empty selection fails.
- `bun run test:boundaries`: the boundary tests and the boundary check described above.
- `bun run test:browser:terminal` (from the Corvidae root): the real-browser proof in Chromium, Firefox and WebKit, through the browser-fixtures harness. The `terminal-*.playwright.ts` specs drive the component against a deterministic in-page session and assert exact bytes; `terminal-visual.playwright.ts` sweeps the visual fixtures of `documentation/terminal/experience.md` in both themes at three viewports, and their Chromium baselines live under `scripts/browser-fixtures/snapshots/chromium/linux/terminal/` (see `scripts/browser-fixtures/visual-baselines.md`). The command lists its selection first and fails when a browser, a spec in one browser, or a baseline cell is absent. It is not part of `bun run validate`.
- `bun run test:coverage`: the tests with LCOV output, then the ratchet in `coverage-ratchet.json` through `@lostgradient/testing/coverage-ratchet`. TypeScript lines and functions are held at 100 percent. The `svelte` ratchet was seeded from the first measurement of the renderer suite and is never lowered.

## Testing

`src/test/mount-harness.ts` mounts a Svelte component into its own container, flushes reactive updates, and tears it down, so a test can prove that a component renders, reacts, and leaves nothing behind. It is test-only and excluded from the browser program and from coverage.
