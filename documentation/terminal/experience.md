# Terminal experience and accessibility specification

Status: COR-484 review candidate. This document defines the interaction and accessibility contract for the v1 terminal surface described by [`contract.md`](./contract.md). It is a review artifact, not an implementation API. The five tables below are the acceptance record: every row is independently reviewable.

## Admission and boundaries

The nearest Cinder components are `TerminalFrame` (chrome, status, recovery, and character-cell sizing), `TerminalOutput` (read-only ANSI output with native selection and a focusable log viewport), `Button`, `Modal`, `Textarea`, and `FormField`. `TerminalFrame` is the right shell because it supplies connection state without intercepting the consumer-owned terminal keyboard model; `TerminalOutput` is the right read-only precedent because it preserves selection and bounded log semantics. A hypothetical all-in-one Cinder `Terminal` component clears admission for v1: it would have to own the renderer, transport, parser, process lifetime, input authority, and recovery policy that the runtime contract deliberately keeps in the application controller. The application composes these primitives around the private engine instead.

Resting-state visual examples are: an empty frame with `Disconnected` status and `No terminal session` content; a writable frame with `Connected` status, a visible caret, and no capture mode; a read-only frame with the same output chrome but no input affordance; and a disconnected frame retaining the last output plus one recovery action. Error and cleanup states keep the last useful output visible and put the next action in the same frame. The browser fixture corpus uses Cinder's `light` and `dark` themes and the named `mobile` (375×900), `tablet` (768×900), and `desktop` (1280×900) viewports. Steve accepted the following decision: capture starts off; the visible Cinder Button labelled `Capture terminal keys` enters capture through normal button activation; `Ctrl+Shift+Escape` releases it; bare `Escape` remains shell input unless a package overlay owns it.

## State and action

| State | Entry and visible treatment | Allowed action and exact result | Focus, authority, and exit rule |
| --- | --- | --- | --- |
| empty | No session exists; frame shows `No terminal session` and no output. | `New session` creates one explicit new session; it never replays prior input or output. | Focus returns to the invoking `New session` button after a failed attempt; success enters `loading`. |
| loading | Session is being constructed; show `Loading terminal…`; input is disabled. | `Cancel` cancels construction and returns to `empty`; no process is started. | Focus remains on the activated control; cancellation is announced once. |
| connecting | Transport is opening; show `Connecting…`; input is disabled. | `Cancel` stops the connection and returns to `empty`; a completed connection enters `writable` or `read-only`. | No automatic reconnect, respawn, replay, or focus steal. |
| writable | Connected with server input authority; show `Connected`; terminal surface accepts shell input when capture is active. | `Capture terminal keys` enters capture; `Ctrl+Shift+Escape` releases capture; `Interrupt` sends the interrupt byte; `Clear` clears only the local rendered buffer; `New session` performs the explicit restart after cleanup, with no replay. | Capture starts off. Bare `Escape` is sent to the shell unless a package overlay owns it. Selection and copy remain native browser behavior. |
| read-only | Connected without input authority; show `Read-only`; output remains selectable and scrollable. | `Copy` copies the current native selection; `Export` opens the bounded snapshot; input, capture, interrupt, and `New session` are disabled until the current attachment is cleaned up. | Focus never moves because output arrives; no query replies or input are emitted. |
| backpressured | Connected but the host cannot take more input: its bounded operation FIFO is full, or the process is not reading and the host is holding accepted input; show `Backpressure: input paused`. | New input and resize operations are rejected with `Input paused`; no recovery action is offered, because the client queues nothing and there is no unsent operation to cancel; output remains readable. | Existing accepted bytes are not rewritten or replayed, and held bytes are delivered once, in order, when the process reads. Return to `writable`/`read-only` only after capacity is acknowledged. |
| exited | The process has exited and the attachment is revoked; retain output and show `Process exited` plus the known exit result. | `New session` starts an explicit new session after cleanup; it never resumes or replays. `Export` remains available. | Focus restores to `New session` after it completes; replacement is blocked until cleanup is complete. |
| disconnected | Transport failed or closed unexpectedly; disable input immediately and retain output; show `Disconnected`. | `New session` is available only after cleanup; `Export` and local selection/copy remain available. | No automatic reconnect, keystroke replay, or claim that the process survived. |
| denied | Origin, token, or requested capability was rejected; show `Access denied`. | `Try again` repeats connection authorization only; `New session` starts a fresh attempt. | Never expose a shell or accept bytes; restore focus to the invoking control. |
| failed | Startup or operation failed; show `Terminal failed` and the exact safe next action. | `Retry` starts a new session; `Export` preserves received output; `Clear` is still local-only. | Failed connection is not a successful exit; focus stays in the error action group. |
| cleanup-incomplete | Disposal did not prove that owned resources ended; show `Cleanup incomplete—new sessions are disabled`. | `Check cleanup` requests the host cleanup result; no replacement, retry, input, or replay is allowed while quarantined. | Keep the ownership slot quarantined until a complete result; focus returns to `Check cleanup`. |
| engine-load-failed | The selected engine or required asset could not load; show `Terminal engine unavailable`. | `Retry` retries asset/engine loading; `Export` is available only for an existing bounded snapshot. | Do not construct a partial renderer, intercept keys, or silently choose a fallback engine. |

Every state is rendered inside Cinder `TerminalFrame`'s closed status vocabulary: `empty` maps to `status="disconnected"` while its content says `No terminal session`; `loading` and `connecting` map to `status="connecting"`; `writable`, `read-only`, and `backpressured` map to `status="connected"`; `exited` and `disconnected` map to `status="disconnected"`; and `denied`, `failed`, `cleanup-incomplete`, and `engine-load-failed` map to `status="error"`. The application copy and recovery controls refine these states without inventing another `TerminalFrame` status.

`Clear` changes only the local rendered buffer and never sends bytes. There is no controller reset operation in v1. Full terminal reset/restart means waiting for the current attachment's cleanup result, then activating `New session`, which creates a new attachment generation with no replay. A read-only or quarantined attachment cannot be restarted until its authority and cleanup rules permit replacement.

## Copy and announcement

| Surface or event | Exact copy or announcement | Reviewable behavior |
| --- | --- | --- |
| empty | `No terminal session` | A status element exposes the same text; no live announcement is repeated. |
| loading | `Loading terminal…` | Announce once on entry, then remain quiet. |
| connecting | `Connecting…` | Announce once; do not announce transport frames or every byte. |
| writable | `Connected` | Visible status names authority; capture remains off until activated. |
| read-only | `Read-only` | Visible status and disabled input affordances explain why typing has no effect. |
| backpressured | `Backpressure: input paused` | Announce once per transition into the state, throttled on repeated capacity failures. |
| exited | `Process exited` plus `Exit code: <number>` when known, otherwise `Process ended` | Keep the exact output snapshot; do not turn EOF into exit code zero. |
| disconnected | `Disconnected` | Announce once; include `Input disabled` in the visible recovery region. |
| denied | `Access denied` | Do not disclose tokens, origin details, or hidden server diagnostics. |
| failed | `Terminal failed` | Pair the message with `Retry` and preserve output already received. |
| cleanup-incomplete | `Cleanup incomplete—new sessions are disabled` | Announce once and expose `Check cleanup`; do not imply that cleanup succeeded. |
| engine-load-failed | `Terminal engine unavailable` | Announce once and expose `Retry`; no fallback engine is implied. |
| capture enter/release | `Terminal key capture on` / `Terminal key capture off` | Announce only the transition; `Ctrl+Shift+Escape` is the release action. |
| copy | `Terminal selection copied` | Announce after a successful user-initiated copy, never on selection changes. |
| export | `Terminal snapshot ready` or `Terminal snapshot truncated` | The export is a frozen bounded snapshot; the latter is exposed when the bound truncates content. |
| refresh | `Terminal snapshot refreshed` or `Terminal snapshot stale` | Refresh is explicit; stale data is labelled rather than silently replaced. |

Announcements are concise, polite, throttled, and never emitted for every output byte. Arrival never forces focus. The accessible output is a frozen bounded snapshot in a labelled read-only Cinder `Textarea` inside a Cinder `Modal`; the modal has explicit `Refresh`, `Copy`, and `Close` actions. The snapshot modal intentionally owns bare `Escape` with Cinder Modal's default `dismissOnEscape={true}`: Escape dismisses the modal, is consumed by the overlay, and never reaches the shell. Closing by Escape or `Close` returns focus deterministically to the invoking `Export` button; a refresh failure keeps focus on `Refresh`. A stale snapshot says `Snapshot stale`; a bound-exceeded snapshot says `Snapshot truncated` and includes the retained byte/line bound.

Links are disabled by default. A host may opt in only for visible HTTPS text with matching intentional pointer or keyboard activation. OSC 8 hidden destinations, paths, command schemes, and downloads remain inert and are never copied as links or opened by keyboard focus.

## Platform keyboard

| Input or platform behavior | Writable/capture behavior | Read-only and overlay behavior | Acceptance check |
| --- | --- | --- | --- |
| Normal printable keys | With capture on, preserve accepted UTF-8 bytes exactly and send them in order; with capture off, browser focus and shell policy apply. | Never send input. | No one-line rewrite, normalization, or replay. |
| `Ctrl+Shift+Escape` | Always releases terminal capture when the terminal owns capture. | Closes no modal unless that modal explicitly owns the chord. | Capture-off announcement occurs once. |
| Bare `Escape` | Remains shell input. | Does nothing to the terminal unless a package overlay owns it. | Do not reserve bare Escape for capture release. |
| Selection and copy | Native text selection works in the renderer; `Cmd/Ctrl+C` copies selection and does not interrupt when a selection exists. | Native selection and `Copy` remain available. | Copy preserves selected bytes/text exactly. |
| Interrupt | `Interrupt` sends the documented interrupt byte only after intentional activation; it does not use bare Escape. | Disabled. | Accepted interrupt is visible in operation status. |
| Search | `Search` opens a literal, bounded search field; `Next` and `Previous` select the matching output occurrence without changing bytes or scroll anchoring. | Search remains available against the frozen snapshot; no input is sent. | Closing search restores focus to the exact invoking `Search` control and restores the prior output focus/scroll position. |
| IME composition | `compositionstart`, updates, and `compositionend` are respected; do not emit partial composition strings as independent shell input. | Composition is not started. | Test dead-key and IME commit paths on macOS and Chromium. |
| Dead keys and international layouts | Preserve the browser's committed character sequence; do not infer characters from physical key codes. | No input. | Test accent composition and a non-US layout. |
| Function and modifier keys | Preserve function keys and modifier bytes according to the controller contract; do not turn unknown keys into text. | No input. | Test `F1`–`F12`, arrows, Home/End, and modifier chords. |
| Optional mouse reporting | Off by default. If the host advertises and enables it, terminal reporting takes precedence over selection only while capture is active; otherwise native selection wins. | Never report mouse input. | Show the active mode visibly and verify selection remains available when disabled. |
| Bracketed paste | Review every paste with bracketed mode on: preserve the bracket bytes and payload exactly, including a trailing newline/control byte. | Paste is text selection/copy only. | A multiline/control-bearing paste is not rewritten to one line and is never replayed. |
| Multiline/control paste | Review every multiline and control-bearing paste; accepted bytes and trailing newline/control meaning remain exact. | Not accepted as input. | Include bracketed and unbracketed fixtures; reject only by explicit authority/queue failure. |
| Resize, zoom, and zero size | Resize is sent only when dimensions are finite and positive; zero-size or invalid measurements pause resize without inventing a dimension. | Output remains readable. | Verify no resize callback for invalid dimensions and no stale resize masquerading as current. |
| Modal focus | Terminal does not move focus on output or status changes. An open snapshot modal traps focus per Cinder modal behavior. | `Close` and `Refresh` follow normal button activation. | Close restores focus to the exact invoking control; refresh keeps focus on `Refresh`. |

The following binary conflict matrix covers the supported desktop browser review set. `YES` means the specified outcome is required; `NO` means the terminal must not claim or perform it.

| Platform and browser | Capture state | Exact key/modifier | Copy result | Interrupt result | Focus destination | Reserved browser/OS/AT conflict | Expected behavior |
| --- | --- | --- | --- | --- | --- | --- | --- |
| macOS Safari | off | `Cmd+C` with a non-empty selection | YES: native copy | NO: do not interrupt | Selection remains in the output | `Cmd+L`, `Cmd+T`, `Cmd+W`, `Cmd+Tab`, and VoiceOver `Ctrl+Option` remain reserved | Browser/AT wins; no terminal byte is sent. |
| macOS Safari | on | `Cmd+C` with a non-empty selection | YES: native copy | NO: do not interrupt | Selection remains in the output | Same reserved browser/OS/AT chords | Copy wins over interrupt when a selection exists. |
| macOS Chromium | off | `Cmd+C` with a non-empty selection | YES: native copy | NO: do not interrupt | Selection remains in the output | `Cmd+L`, `Cmd+T`, `Cmd+W`, `Cmd+Tab`, and VoiceOver `Ctrl+Option` remain reserved | Browser/AT wins; no terminal byte is sent. |
| macOS Chromium | on | `Cmd+C` with a non-empty selection | YES: native copy | NO: do not interrupt | Selection remains in the output | Same reserved browser/OS/AT chords | Copy wins over interrupt when a selection exists. |
| macOS Firefox | off | `Cmd+C` with a non-empty selection | YES: native copy | NO: do not interrupt | Selection remains in the output | `Cmd+L`, `Cmd+T`, `Cmd+W`, `Cmd+Tab`, and VoiceOver `Ctrl+Option` remain reserved | Browser/AT wins; no terminal byte is sent. |
| macOS Firefox | on | `Cmd+C` with a non-empty selection | YES: native copy | NO: do not interrupt | Selection remains in the output | Same reserved browser/OS/AT chords | Copy wins over interrupt when a selection exists. |
| Linux Chromium | off | `Ctrl+C` with a non-empty selection | YES: native copy | NO: do not interrupt | Selection remains in the output | `Ctrl+L`, `Ctrl+T`, `Ctrl+W`, `Alt+Tab`, and the configured AT modifier remain reserved | Browser/AT wins; no terminal byte is sent. |
| Linux Chromium | on | `Ctrl+C` with a non-empty selection | YES: native copy | NO: do not interrupt | Selection remains in the output | Same reserved browser/OS/AT chords | Copy wins over interrupt when a selection exists. |
| Linux Firefox | off | `Ctrl+C` with a non-empty selection | YES: native copy | NO: do not interrupt | Selection remains in the output | `Ctrl+L`, `Ctrl+T`, `Ctrl+W`, `Alt+Tab`, and the configured AT modifier remain reserved | Browser/AT wins; no terminal byte is sent. |
| Linux Firefox | on | `Ctrl+C` with a non-empty selection | YES: native copy | NO: do not interrupt | Selection remains in the output | Same reserved browser/OS/AT chords | Copy wins over interrupt when a selection exists. |
| All five browser/platform pairs | on | `Ctrl+C` on Linux or `Cmd+C` on macOS with no selection | NO: there is no selection to copy | YES: send the documented interrupt byte; the explicit `Interrupt` action is equivalent | Focus remains in the terminal | Browser/OS/AT-reserved chords are never captured | No-selection copy chord is the intentional interrupt path; a non-empty selection always wins with native copy and no interrupt. |

## Visual fixture

| Fixture | Theme and viewport | Required resting-state evidence | Pass condition |
| --- | --- | --- | --- |
| empty | `light` and `dark`; `mobile` 375×900, `tablet` 768×900, `desktop` 1280×900 | `No terminal session`, `New session`, no renderer or capture affordance | Text and action remain visible without horizontal overflow. |
| loading/connecting | Both themes and all three viewports | `Loading terminal…` and `Connecting…` states with disabled input | Status is readable and does not move focus. |
| writable | Both themes and all three viewports | Connected frame, visible caret, capture off, `Capture terminal keys` button | Terminal content fits measured cells; title/status remain readable. |
| read-only | Both themes and all three viewports | Read-only frame with selectable output and no input affordance | Narrow layout remains usable and output selection is not hidden. |
| backpressured | Both themes and all three viewports | `Backpressure: input paused` with retained output | Recovery copy is visible without covering output. |
| exited/disconnected | Both themes and all three viewports | Last output plus `Process exited` or `Disconnected` and `New session` | No false connected styling; action remains reachable. |
| denied/failed/engine-load-failed | Both themes and all three viewports | Error copy, exact recovery action, retained output when present | Errors have sufficient contrast and are not color-only. |
| cleanup-incomplete | Both themes and all three viewports | Quarantine copy and `Check cleanup`; no `New session` | The disabled replacement state is visually unambiguous. |
| snapshot modal | Both themes and all three viewports | Labelled read-only Textarea, `Refresh`, `Copy`, `Close`, stale/truncated variant | Modal content is bounded, scrollable, and restores focus exactly. |
| keyboard/paste | Both themes and all three viewports | Capture on/off, selection, bracketed multiline/control paste, function/dead-key fixtures | No byte loss, rewrite, unexpected link, or focus jump. |

Across every fixture, fitting uses positive finite cell dimensions only. Hidden, detached, or zero-size terminal containers do not send fabricated resize values. `TerminalFrame` may replay its last valid measurement when a new `onDimensionsChange` handler is supplied, even after sizing becomes invalid; the host must therefore tag each accepted measurement with the current valid-fit generation, ignore callbacks while width/height are hidden, zero, non-finite, or otherwise invalid, and ignore any replay whose tag is older than the first invalid measurement. Only a fresh valid measurement after visibility and positive finite dimensions are restored may update the controller. Font fallback and zoom preserve readable content and re-fit when a valid measurement returns. Light/dark theme tokens remain legible; forced-colors/high-contrast mode retains borders, focus indicators, status text, and error meaning without relying on color. Reduced motion disables nonessential transitions and never delays status or focus restoration. Scroll anchoring follows `TerminalOutput`: output follows the end until the reader scrolls away, then preserves the reader's position; returning to the end resumes following. At narrow widths, read-only output may scroll horizontally but controls and recovery copy remain in document order and reachable.

## Manual assistive-technology task

| Browser and AT | Task | Expected observation | Pass condition |
| --- | --- | --- | --- |
| VoiceOver + Safari | Navigate to empty, create a session, and enter/leave capture with the labelled button and `Ctrl+Shift+Escape`. | VoiceOver announces `No terminal session`, `New session`, `Connected`, `Capture terminal keys`, and capture on/off once each; bare Escape is not consumed by the package. | Focus follows activation and returns to the invoking control; no byte-by-byte chatter. |
| VoiceOver + Safari | In writable mode, type printable, IME/dead-key, function-key, and multiline/control paste fixtures; select and copy output. | Committed input is preserved; output remains selectable; copy announces `Terminal selection copied`. | Accepted bytes, trailing newline/control meaning, and selection are exact. |
| VoiceOver + Safari | Open `Export`, use `Refresh`, navigate stale/truncated snapshot, then close. | Modal name and labelled read-only Textarea are announced; `Snapshot stale`/`Snapshot truncated` is present; focus returns to `Export`. | Refresh is explicit and no snapshot silently updates or exceeds its bound. |
| VoiceOver + Chrome | Traverse every state row from `connecting` through `cleanup-incomplete`. | State text and next action are exposed in reading order; denied, failed, and cleanup-incomplete do not sound like success. | Each required state has one truthful status and reachable recovery action. |
| VoiceOver + Chrome | Scroll output away from the end, receive more output, return to the end, then activate `Clear` and `New session` after cleanup. | Scroll position stays anchored while away; following resumes at end; clear is local and a new session is separately announced. | No unexpected scroll jump, backend operation on clear, or replay. |
| VoiceOver + Chrome | Enable host opt-in link behavior and activate visible HTTPS text by pointer and keyboard; inspect OSC 8, paths, command schemes, and downloads. | Only the matching visible HTTPS text activates intentionally; hidden destinations and unsafe/download targets are inert. | Links are disabled by default and no unsafe destination is exposed. |
| VoiceOver + Chrome | Repeat the modal and keyboard tasks at 375×900, 768×900, and 1280×900 in light/dark and reduced-motion/high-contrast settings. | Controls remain reachable, text remains legible, and no animation or theme removes focus/meaning. | All six theme/viewport combinations pass without overflow that hides required controls. |

Tabs, splits, profiles, persistence, shell integration, path opening, SSH, shared viewers, Windows, and interactive mobile behavior are outside v1. COR-471 owns later human implementation acceptance; this document is the COR-484 interaction/accessibility candidate only.
