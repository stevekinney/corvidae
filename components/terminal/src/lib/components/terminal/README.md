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

### The controller the renderer needs

`TerminalRendererController` is the narrowest view of a session controller the renderer consumes:

- `subscribeOutput(listener)` delivers ordered output bytes and returns an unsubscribe function. The listener receives each chunk and a `parsed` callback. The renderer calls `parsed` once per chunk when the engine has parsed it, which is the accepted parse boundary. It is independent of painting: output keeps parsing, and is acknowledged, while the page is hidden. The controller delivers everything produced since the attachment started, in order, because the renderer subscribes only after its engine is mounted.
- `rendererFailed(failure)` is called once if the renderer fails closed. The engine is already disposed; the controller revokes input and runs cleanup.

## Geometry

The engine's measured cell size is the only resize authority. The frame's own `onDimensionsChange` estimate is never connected. The first accepted geometry arrives before any process exists, so the host creates the process with it. After that, container size changes, font loading, zoom, and device-pixel-ratio changes collapse into at most one measurement per frame, and a measurement is reported only when it differs from the last accepted one. A hidden, detached, or zero-size container measures as nothing and reports nothing.

The element the engine mounts into (`.cinder-terminal__viewport`) carries no padding, because the fit addon reads that element's computed size and subtracts only the engine element's own padding. The reader's inset is on `.cinder-terminal__viewport .xterm` instead, so the measured grid matches the visible area. Real-browser proof stays with COR-474.

A view that does not own the grid (every state except `loading`, `connecting`, `writable`, and `backpressured`) never fits itself or reports geometry. It adopts `ownerGeometry` and scrolls, or letterboxes, locally.

## Failure

A load, initialization, parse, or render failure disposes the engine and shows `engine-load-failed` with a `Retry` control. The renderer never switches engines, resets silently, drops bytes and carries on, or replays anything. `Retry` loads the engine again; the controller has already been told the renderer failed. `engine-load-failed` is derived by the renderer, so when the host passes that state itself, `Retry` calls `onRecoveryRequest` instead, because only the host can resolve a state it supplied.

## Engine notes

- Unicode width follows `@xterm/xterm` 6.0.0's built-in tables (Unicode 6): East Asian wide and full-width characters take two cells, a combining mark or zero-width joiner joins the cell before it, and each emoji, including each member of a joined sequence, takes one cell.
- `@xterm/xterm` 6.0.0 drops U+200B and U+200D when a write ends between the second and third byte of their encoding. The renderer never ends a write inside a UTF-8 sequence: it holds the unfinished tail (at most three bytes) and parses it with the next chunk. The tail is acknowledged with its own chunk.
- Fitting uses `@xterm/addon-fit`, the engine's own helper, to read the measured cell size.

## Retained content

`projectBuffer` in `terminal-projection.ts` is a private, bounded plain-text projection of the active retained buffer: soft wraps are joined using the engine's own wrap metadata, hard line boundaries are LF, wide characters add no padding, and the result is capped at 64 KiB of UTF-8. It is private to the package for the accessible snapshot, search, and export that later issues add, and it is not part of the package entry.

## Testing

`bun run test:renderer` runs the colocated tests. They cover lifecycle (dispose during the import, double dispose, controller replacement), the accepted parse boundary, geometry, fail-closed behavior, inert output, and the shared byte corpus from `@lostgradient/ventriloquist` delivered contiguously, under every two-chunk split, byte by byte, and under the fixed-seed partitions, each compared with a declared oracle.
