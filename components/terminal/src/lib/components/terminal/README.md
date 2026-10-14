# Terminal

Render a terminal session's screen, cursor, colors, and scrollback inside Cinder's `TerminalFrame`, with the selected engine mounted only in the browser.

## Usage

```svelte
<script lang="ts">
  import {
    Terminal,
    type TerminalGeometry,
    type TerminalRendererController,
    type TerminalState,
  } from '@lostgradient/terminal';

  const { controller }: { controller: TerminalRendererController } = $props();

  let state = $state<TerminalState>('connecting');

  function handleGeometryChange(geometry: TerminalGeometry): void {
    // Create or resize the process with the grid the engine measured.
    state = 'writable';
  }
</script>

<!-- Terminal fills its parent; give the ancestor a definite height. -->
<div style="height: 24rem;">
  <Terminal title="Build shell" {state} {controller} onGeometryChange={handleGeometryChange} />
</div>
```

## What it owns

The component owns the view: the frame, the engine mounted into its viewport, fitting, and the display of every state. It does not own the session. A `controller` is borrowed: the component subscribes to its output once the engine is mounted, unsubscribes when the controller is replaced or the component unmounts, and never disposes it, terminates its process, or closes its attachment.

The engine is private. The component never exposes the engine instance, its options, its parser, or its write queue, and offers no engine selector, fallback engine, or addon hook.

## Props

| Prop | Meaning |
| --- | --- |
| `title` | Title shown in the frame chrome. Required. |
| `state` | One of the twelve interaction states. Defaults to `'empty'`. |
| `controller` | The session controller whose output is rendered. Borrowed. |
| `onGeometryChange` | Called with the engine's measured `{ columns, rows }`, once per accepted change. |
| `ownerGeometry` | The grid a non-owning view adopts and scrolls locally. |
| `error`, `onRecoveryRequest` | The frame's recovery message and the handler for its reload control. |
| `ariaLabel` | Accessible name of the input surface. Defaults to `Terminal`. |
| `announceOutput` | Mirror output into the engine's bounded live region. Defaults to `false`. |
| `onLinkActivate` | Turns links on and receives a visible HTTPS address the reader activated. |
| `onTitleChange` | Receives the program-set title as bounded plain text. |
| `maximumPasteBytes` | The most paste text, in UTF-8 bytes, offered for review. Integer from 1 to 262144; anything else uses 65536. |
| `onInputRefused` | Receives `{ reason, acceptedOperations?, totalOperations? }` when input, or part of it, did not reach the wire. |

### The controller the renderer needs

`TerminalRendererController` is the narrowest view of a session controller the renderer consumes:

- `subscribeOutput(listener)` delivers ordered output bytes and returns an unsubscribe function. The listener receives each chunk and a `parsed` callback. The renderer calls `parsed` once per chunk when the engine has parsed it, which is the accepted parse boundary. It is independent of painting: output keeps parsing, and is acknowledged, while the page is hidden. The controller delivers everything produced since the attachment started, in order, because the renderer subscribes only after its engine is mounted.
- `rendererFailed(failure)` is called once if the renderer fails closed. The engine is already disposed; the controller revokes input and runs cleanup.
- `input` (optional) is where typing, paste and the engine's automatic replies go. It is `TerminalInputController`: `input(bytes)` offers one operation and returns the protocol's typed result (a throw means the delivery is unknown), `authorityRevoked` says the controller may no longer send, and `terms` carries the negotiated `maxFrameBytes` and `maxQueuedOperations`. A `ClientEndpoint` plus the transport that carries its frames satisfies it. Without `input` the terminal is a viewer and sends nothing.

## Input

Input is enforced in the client for feedback; the host enforces authority for security. Every engine report becomes bytes by its own conversion: text (`onData`) as UTF-8, binary (`onBinary`) as one byte per character. A report that cannot be converted exactly is refused, never repaired. Bytes are split to the negotiated frame budget only between characters and complete escape sequences, so the bracketed-paste markers and every sequence a paste carries stay whole. An input that cannot fit the queue, or has a sequence larger than a frame, is refused before anything is sent.

Nothing is queued, retried or replayed. A failure after part of an input was accepted, or a delivery whose outcome is unknown, freezes input for the life of that session binding. Typing, paste, and the automatic replies the engine makes to terminal queries are all refused unless the state is `writable` and the controller still has authority. A read-only view sends nothing, and its selection and scrolling keep working.

Keys are routed in the order the experience specification sets: a focused package overlay (the paste review), then reserved platform and host actions, then authorized terminal input. Capture starts off, so Tab and Shift+Tab move through the page; the `Capture terminal keys` button (`aria-pressed`) sends them to the shell instead, and `Ctrl+Shift+Escape` releases it. Bare Escape is always shell input unless the review owns it. Capture lasts only while the terminal has focus, and it never ends up on a previous session.

A multiline or control-bearing paste opens a review that shows its line breaks and controls, how long it is, and whether it ends in a newline, with Cancel and Paste. A paste over `maximumPasteBytes` is refused whole. An accepted paste goes through the engine, which converts line breaks to carriage returns and brackets it when the program asked for it. The keys that close the review do not reach the shell.

## Geometry

The engine's measured cell size is the only resize authority. The frame's own `onDimensionsChange` estimate is never connected. The first accepted geometry arrives before any process exists, so the host creates the process with it. After that, container size changes, font loading, zoom, and device-pixel-ratio changes collapse into at most one measurement per frame, and a measurement is reported only when it differs from the last accepted one. A hidden, detached, or zero-size container measures as nothing and reports nothing.

The element the engine mounts into (`.cinder-terminal__viewport`) carries no padding, because the fit addon reads that element's computed size and subtracts only the engine element's own padding. The reader's inset is on `.cinder-terminal__viewport .xterm` instead, so the measured grid matches the visible area. Real-browser proof stays with COR-474.

A view that does not own the grid (every state except `loading`, `connecting`, `writable`, and `backpressured`) never fits itself or reports geometry. It adopts `ownerGeometry` and scrolls, or letterboxes, locally.

## Failure

A load, initialization, parse, or render failure disposes the engine and shows `engine-load-failed` with a `Retry` control. The renderer never switches engines, resets silently, drops bytes and carries on, or replays anything. `Retry` loads the engine again; the controller has already been told the renderer failed. `engine-load-failed` is derived by the renderer, so when the host passes that state itself, `Retry` calls `onRecoveryRequest` instead, because only the host can resolve a state it supplied. Without an `onRecoveryRequest` handler there is nothing to ask, so a host-supplied `engine-load-failed` shows the message and no `Retry`.

## Engine notes

- Unicode width follows `@xterm/xterm` 6.0.0's built-in tables (Unicode 6): East Asian wide and full-width characters take two cells, a combining mark or zero-width joiner joins the cell before it, and each emoji, including each member of a joined sequence, takes one cell.
- `@xterm/xterm` 6.0.0 drops U+200B and U+200D when a write ends between the second and third byte of their encoding. The renderer never ends a write inside a UTF-8 sequence: it holds the unfinished tail (at most three bytes) and parses it with the next chunk. The tail is acknowledged with its own chunk.
- Fitting uses `@xterm/addon-fit`, the engine's own helper, to read the measured cell size.

## Retained content

`projectBuffer` in `terminal-projection.ts` is a private, bounded plain-text projection of the active retained buffer: soft wraps are joined using the engine's own wrap metadata, hard line boundaries are LF, wide characters add no padding, and the result is capped at 64 KiB of UTF-8. It is private to the package for the accessible snapshot, search, and export that later issues add, and it is not part of the package entry.

## Testing

`bun run test:renderer` runs the colocated tests. They cover lifecycle (dispose during the import, double dispose, controller replacement), the accepted parse boundary, geometry, fail-closed behavior, inert output, and the shared byte corpus from `@lostgradient/ventriloquist` delivered contiguously, under every two-chunk split, byte by byte, and under the fixed-seed partitions, each compared with a declared oracle.
