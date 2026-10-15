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
| `mouseReporting` | Reports the mouse to a program that asks for it (tmux, vim), but only while key capture is on and the view is writable. Defaults to `false`: reports are dropped and the pointer selects text. |
| `maximumPasteBytes` | The most paste text, in UTF-8 bytes, offered for review. Integer from 1 to 262144; anything else uses 65536. |
| `onInputRefused` | Receives `{ reason, acceptedOperations?, totalOperations?, source? }` when input, or part of it, did not reach the wire. |
| `onInspectionEvent` | Receives a typed metric (counts, booleans, fixed words) for search, clear, accessible output, export and link activation. Never output or a query. |

### The controller the renderer needs

`TerminalRendererController` is the narrowest view of a session controller the renderer consumes:

- `subscribeOutput(listener)` delivers ordered output bytes and returns an unsubscribe function. The listener receives each chunk and a `parsed` callback. The renderer calls `parsed` once per chunk when the engine has parsed it, which is the accepted parse boundary. It is independent of painting: output keeps parsing, and is acknowledged, while the page is hidden. The controller delivers everything produced since the attachment started, in order, because the renderer subscribes only after its engine is mounted.
- `rendererFailed(failure)` is called once if the renderer fails closed. The engine is already disposed; the controller revokes input and runs cleanup.
- `input` (optional) is where typing, paste and the engine's automatic replies go. It is `TerminalInputController`: `input(bytes)` offers one operation and returns the protocol's typed result (a throw means the delivery is unknown), `authorityRevoked` says the controller may no longer send, and `terms` carries the negotiated `maxFrameBytes` and `maxQueuedOperations`. A `ClientEndpoint` plus the transport that carries its frames satisfies it. Without `input` the terminal is a viewer and sends nothing.

## Input

Input is enforced in the client for feedback; the host enforces authority for security. Every engine report becomes bytes by its own conversion: text (`onData`) as UTF-8, binary (`onBinary`) as one byte per character. A report that cannot be converted exactly is refused, never repaired. Bytes are split to the negotiated frame budget only between characters and complete escape sequences, so the bracketed-paste markers and every sequence a paste carries stay whole. An input that cannot fit the queue, or has a sequence larger than a frame, is refused before anything is sent.

Nothing is queued, retried or replayed. A failure after part of an input was accepted, or a delivery whose outcome is unknown, freezes input for the life of that session binding. A full operation queue holds input too, so a later keystroke cannot change what a dropped one meant, until the `state` leaves `writable` (the host reports `backpressured`) and returns to it. Dropped input is announced once through the polite status region, except typing into a view that is read-only. Typing, paste, and the automatic replies the engine makes to terminal queries are all refused unless the state is `writable` and the controller still has authority. A read-only view sends nothing, and its selection and scrolling keep working.

Keys are routed in the order the experience specification sets: a focused package overlay (the paste review), then reserved platform and host actions, then authorized terminal input. Capture starts off, so Tab and Shift+Tab move through the page; the `Capture terminal keys` button (`aria-pressed`) sends them to the shell instead, and `Ctrl+Shift+Escape` releases it. Bare Escape is always shell input unless the review owns it. Capture lasts only while focus is in the terminal, on the capture button, or on the Interrupt button, so pressing the pressed capture button turns it off, Interrupt returns focus to the terminal with capture kept, and capture returns after a paste review closes. Capture never ends up on a previous session.

Mouse reports are off by default. A program can turn on the engine's mouse tracking at any time; the terminal never changes that mode, but sends the reports it produces (default, SGR and SGR-pixel encodings, including the raw bytes of the default one) only when `mouseReporting` is set, capture is on and the view is writable. Otherwise they are dropped without a refusal, and a press is handed to the engine as a selection gesture (Shift, or Option on a Mac), so the pointer selects text. A read-only view never reports the mouse. While reports are actually being sent (opted in, the program tracking the mouse, capture on, view writable) a `Mouse reporting on` Cinder `Badge` shows beside the controls and describes the capture button. The badge is not a live region; the program turning the mode on or off is announced once each, and capture or the view changing it leaves the announcement to capture's own.

A multiline or control-bearing paste, and any paste while the program has bracketed paste on, opens a review that shows its line breaks and controls, how long it is, and whether it ends in a newline, with Cancel and Paste. A paste over `maximumPasteBytes` is refused whole. An accepted paste goes through the engine, which converts line breaks to carriage returns and brackets it when the program asked for it. The bytes are never rewritten: a pasted bracket terminator ends the protected paste early, and the review says so while bracketed paste is on (and that it is sent as typed while it is off). If the mode changes while the review is open, the review is shown again with the new warning before anything is sent. The keys that close the review do not reach the shell.

## Inspection

A toolbar of Cinder buttons (`Search`, `Export`, `Clear screen`, `Clear history`, `Reset terminal`) appears while an engine is mounted, in every state that keeps one, including `read-only`, `exited` and `disconnected`. Nothing in it sends a byte to the process, restarts it, or reports to the controller: it reads the engine's retained output and, for clearing, acts on the engine's own buffer. `bun run test:inspection` proves zero input bytes while a program has focus reporting on. One byte is the engine's doing, not inspection's: enabling focus reporting (`CSI ? 1004 h`) makes the engine report its own current focus once, and a focus-reporting terminal reports focus leaving or entering it as the protocol requires. Those are protocol-correct reports from the engine, not input from an inspection path.

The package chooses these bounds, and none is raised to make a test pass: a search query is at most 256 code points; at most 10,000 matches are kept; search reads at most 1 MiB; the accessible snapshot is at most 64 KiB; the export is at most 1 MiB and 10,000 lines; a snapshot lists at most 50 distinct addresses; and `retainedBytes` reads retained output up to 16 MiB.

When retained output is larger than a bound, every read keeps the newest content. It reads back from the newest row and starts at a whole logical line, or, when the newest line alone is larger than the bound, at a whole code point. Nothing is added to the text to mark the cut: the visible messages say `earlier output was omitted`.

**Search** opens a labelled field (a Cinder `Textarea`, one row, so a query can hold a line feed) over a snapshot of the active retained buffer. Matching is case-sensitive and exact over Unicode code points, with no normalization and no regular expression: `é` and `e` followed by a combining acute are different, and half of a surrogate pair never matches. Soft wraps are joined, a hard line break is one LF, and Shift+Enter inserts one; Enter steps to the next match. `Next match` and `Previous match` wrap once at the ends, the status line reports the index and the count, and the panel shows the match with the text around it. Each step also selects the match in the terminal, through the engine's selection, without scrolling the viewport or moving focus; a match that cannot be placed exactly is not selected. Closing the search drops the selection it made (a selection the reader made is left alone) and returns focus to `Search`. New output re-searches at most once per frame; the active match survives only when the new text has a match at the same logical position with the same 32 code units before it, and otherwise nothing is active. Output that was evicted from the scrollback, cleared or reset is not found, and the alternate screen is searched on its own, because only the active buffer is retained.

**Clear screen**, **Clear history** and **Reset terminal** are distinct local operations without confirmation, each applied in order behind output already received, so everything written before the call is gone and everything after it is kept. Clear screen erases the visible rows and keeps the scrollback. Clear history discards the scrollback and every row except the cursor's own, as the engine's `clear()` does; only the active buffer is affected. Reset is the engine's full reset, which also returns modes and the active buffer to their start state. A unicode prefix still held from before the call is dropped with the output it belonged to, so a continuation byte written afterwards is an orphan and never completes a character that began before the clear.

**Export** opens a Cinder `Modal` holding an immutable snapshot (at most 64 KiB) in a labelled read-only `Textarea`, with `Refresh`, `Copy` (Cinder's `CopyButton`), `Download` and `Close`. New output never changes it: it says `Snapshot stale` until `Refresh` recaptures, and `Refresh` only recaptures the same live session; it keeps focus either way, and a refresh that cannot recapture announces `Terminal snapshot stale`. When the controller or engine is replaced the snapshot says so, `Refresh` is disabled, and the text stays as it was. Closing releases the text; focus returns to `Export` while it is mounted, and otherwise to the frame. The dialog always states what `Download` will save before it saves it: `Download ready` with the size, or `Download truncated` saying earlier output was omitted and the limits. `Download` saves the plain-text file that was described, taken with the snapshot: UTF-8 without a byte order mark, LF line endings, soft wraps joined, no HTML and no escape codes, as `terminal-output.txt`. The result has `text`, `truncated`, `exportedBytes` and `retainedBytes`. Nothing is recorded automatically. With `onLinkActivate` set, the dialog also lists the distinct visible HTTPS addresses found in the snapshot as buttons, under the terminal's one link policy; hidden OSC 8 destinations, paths, downloads and command links are not text the policy accepts, so they are never listed. A listed address stays activatable after the process exits; only a replaced session disables it.

`onInspectionEvent` receives events built only from numbers, booleans and a few fixed words, so output, queries, keystrokes, arguments, environment and credentials cannot be in one. A handler that throws changes nothing. Nothing in this package logs.

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

`projectBuffer` in `terminal-projection.ts` is a private, bounded plain-text projection of the active retained buffer: soft wraps are joined using the engine's own wrap metadata, hard line boundaries are LF, wide characters add no padding, and the result is capped at 64 KiB of UTF-8 unless a caller passes another limit. It keeps the newest content when it must cut, and it records where each whole logical line starts so a search match can be selected. The export dialog, search and export read it, and it is not part of the package entry.

## Testing

`bun run test:renderer` runs the colocated tests. They cover lifecycle (dispose during the import, double dispose, controller replacement), the accepted parse boundary, geometry, fail-closed behavior, inert output, and the shared byte corpus from `@lostgradient/ventriloquist` delivered contiguously, under every two-chunk split, byte by byte, and under the fixed-seed partitions, each compared with a declared oracle.
