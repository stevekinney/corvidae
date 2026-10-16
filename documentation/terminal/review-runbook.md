# Terminal human review runbook

This is the procedure for COR-471: reviewing the terminal with VoiceOver in Safari and Chrome and recording the result in [`review-evidence.md`](./review-evidence.md). The record is yours to fill; nothing in this packet was run with VoiceOver, and no cell is pre-filled with an outcome.

## Before you start

Pick the `main` SHA you are reviewing and write it in the header of `review-evidence.md`. From a clean checkout of that SHA:

```sh
git rev-parse HEAD
bun install --frozen-lockfile
```

Create the screenshot folder once. Name each image after its row, for example `T2-S.png`:

```sh
mkdir -p documentation/terminal/review-screenshots
```

On macOS, `Cmd+Shift+5`, Options, Save to, Other Location puts captures there directly. Crop the address bar if it ever shows the start token.

## Start the example application

```sh
bun run --filter=@lostgradient/terminal-example dev --browsers 2
```

`dev` builds the client and starts the server. It prints three lines that matter, for example:

```
Terminal example listening on http://127.0.0.1:54240
Open http://127.0.0.1:54240/?token=<random token>
That address carries the start token: ... It admits 2 browsers; restart the server for another.
```

The port is `54240` by default; add `--port 54300` after `--browsers 2` to change it. The token is random on every start. Treat the printed URL like a password: anyone who opens it first gets a shell as you.

Open that exact `Open …/?token=…` URL in Safari, then the same URL in Chrome. Each browser is enrolled by that top-level navigation and the address bar is then cleaned to the bare address. `--browsers 2` admits exactly these two; a third browser, or a private window, is refused with `403`, and you restart the server for a new token. Each browser has its own cookie and its own single terminal slot, so both can stay open at once. Reloading in an enrolled browser does not spend an admission.

To stop, press Ctrl+C in the terminal that is running it. That ends every session and waits for each shell to be cleaned up. Stop it again and restart it whenever a row leaves the slot in `Cleanup incomplete` (see below).

Verified at preparation time against `0cd6a952`: the start URL is printed; with the headers a browser's top-level navigation sends (`Sec-Fetch-Site: none`, `Sec-Fetch-Dest: document`) the token answers `303` with an `HttpOnly`, `SameSite=Strict` cookie; the bare address and a token-only request without those headers answer `401`; with `--browsers 2` the first two enrollments answer `303` and the third `403`; Ctrl+C ended the server and released the port.

## Profiles

Use the segmented `Profile` control at the top of the page.

- `Login shell`: your login shell on a pseudo-terminal. Used for typing, paste, search, export, interrupt, scrolling, disconnect and read-only.
- `Full-screen program`: a small committed program on the alternate screen that counts the keys it receives (`Keys received: N`) and leaves on `q`. Used wherever a row asks whether a key reached the program: capture, overlays, control keys.
- `Pipe demo`: standard output and standard error in two read-only views, exits with status 3.
- `Replay`: a read-only replay of fixed bytes with color, Unicode, a carriage-return rewrite and scrollable length.
- `Escaped job`: starts a process that leaves the terminal session on purpose and prints `escaped=<pid>`. `End session` then produces the real `Cleanup incomplete`.
- `Links`: a read-only fixture with visible HTTPS text, a hidden OSC 8 destination, a path, a command scheme, an insecure address and a download-looking address.
- `Open read-only`: asks for a read-only grant for the current profile.
- `Report the mouse`: lets the terminal send mouse reports (only while capture is on and the session is writable).
- `Announce output`: mirrors output into a screen-reader live region.
- `End session` and `Drop connection`: end the session cleanly, or close the socket as a lost network would.

## Review controls

Expand `Review controls` on the page (collapsed by default). They change what the page shows or when it acts, and they never choose a command, argument, directory or environment: the server owns every profile. Each state below is either real (the page or server produced it) or injected (the page handed the terminal the state), and the page says which.

| State | How | Real or injected |
| --- | --- | --- |
| empty | Open the page with `?autostart=off` after enrolling (add it to the clean address, `http://127.0.0.1:54240/?autostart=off`), or `Show empty` | Real |
| loading | `Hold the next session at`, `Loading`; then `Start a session`. `Cancel` returns to empty; `Release held session` carries on | Real; the page waits before it asks the server for a session |
| connecting | `Hold the next session at`, `Connecting`; then `Start a session`. `Cancel` and `Release held session` as above | Real; the page waits before it opens the socket |
| writable | `Login shell`, after `Connected` appears | Real |
| read-only | Toggle `Open read-only`, or open `Replay` | Real |
| exited | In `Login shell`, type `exit` | Real |
| disconnected | `Drop connection` | Real |
| denied | `Make the next session end in`, `Denied`; then `Start a session`. `Try again` repeats it; set `Nothing` first to see it succeed | Real; the page sends a ticket the server never issued and the server denies the upgrade |
| failed | `Make the next session end in`, `Failed`; then `Start a session`. `Retry` repeats it | Real; the page asks for a profile the server does not have and it answers `400` |
| backpressured | `Inject backpressure`. `Cancel` keeps the session and its output (there are no unsent operations to cancel); `Clear the injected state` stands for capacity being acknowledged | Injected; a real stalled process failed the session instead of holding backpressure |
| engine-load-failed | `Inject engine load failure`; the terminal's own `Retry` hands control back | Injected |
| cleanup-incomplete | Real: choose `Escaped job`, wait for `escaped=<pid>`, activate `End session`, and the slot is quarantined with no `New session`; afterward `kill <pid>` and restart the server (Ctrl+C, then start it again for a new start URL). Injected: `Inject cleanup incomplete` ends the session first, and `Check cleanup` then reads the real, complete result | Both |
| failed (transport) | Stop the server with Ctrl+C, then activate `New session`. Do this last, since it ends the run | Real |

Other controls: `Theme` (`Light` or `Dark`) sets `data-theme` on the page, and `Open visible HTTPS links` turns on the terminal's link handling (off by default; the page opens a visible HTTPS address in a new tab without an opener and reports `Last link opened`). `Remove the toolbar in 8 seconds` is for the focus-fallback row: start it, open `Export` before the countdown ends, and the `Export` button disappears while the dialog stays open; close the dialog and watch where focus goes. It works by handing the terminal `engine-load-failed`, so use `Retry` or `Clear the injected state` afterward.

Keep the terminal in view while you read it: when the `Review controls` panel is expanded the terminal can sit below the fold, and its engine does not repaint output there until it scrolls into view. Collapse the panel (or scroll) before judging what the screen shows.

A note on `Ctrl+C` inside `Full-screen program`: the program traps it and exits, so do not use it as a test key there unless you mean to leave.

## Turn on VoiceOver

Toggle VoiceOver with `Cmd+F5`, or System Settings, Accessibility, VoiceOver. VoiceOver Utility (`VO+F8`) is where to set and record the options named in the header block: speech rate and verbosity, typing echo, the Navigation option "Keyboard focus follows VoiceOver cursor", Quick Nav, and Visuals, Show caption panel (which prints what VoiceOver speaks and helps you quote it). `VO` is `Ctrl+Option`, or Caps Lock if you set it. `VO+F1` opens the command list.

In Chrome, VoiceOver turns on the browser's accessibility tree automatically; if the page seems to expose nothing, open `chrome://accessibility` and enable native accessibility API support.

Record in the header which settings you used, and keep them the same across Safari and Chrome unless a row says otherwise.

## VoiceOver commands for this review

| Need | Command |
| --- | --- |
| Next or previous item | `VO+Right`, `VO+Left` |
| Activate the item | `VO+Space` |
| Interact with a group, text area, or the terminal | `VO+Shift+Down` |
| Stop interacting | `VO+Shift+Up` |
| Read from here, continuously | `VO+A` |
| Read the current item again | `VO+L` |
| Open the rotor (landmarks, headings, form controls, buttons) | `VO+U`, then Left or Right to change list, Up or Down to pick |
| Jump to the page's main region from the rotor | `VO+U`, Landmarks |
| Move VoiceOver to the keyboard focus | `VO+Shift+F` |
| Command list | `VO+H`, `VO+H` |
| Mute speech briefly | `Ctrl` |

If your VoiceOver version binds any of these differently, record the binding you used in the VoiceOver settings field.

Per task, what to listen for and where to look:

- Capture and keys (T1, X3, X9, X10): on `Capture terminal keys`, listen for the pressed state; `VO+Space` toggles it. Capture ends when focus leaves the terminal or on `Ctrl+Shift+Escape`. In `Full-screen program` compare `Keys received` before and after. VoiceOver's own `Ctrl+Option` chords stay with VoiceOver, so you may have to interact (`VO+Shift+Down`) with the terminal region before typing; record whether you needed to.
- Reading output (X6): `VO+Shift+Down` on the terminal region, then `VO+Down`/`VO+Right` through its rows, or `VO+A`. Write down what is spoken, including if only `Terminal` or `Login shell` is read.
- Dialogs (T3, X2): when the `Export` dialog opens, VoiceOver should announce the dialog name; `VO+Shift+Down` into the Textarea to read the snapshot. Check where focus and the VoiceOver cursor are after `Close`.
- Status (T4, X5): after an action, the polite status message is spoken without moving focus. If it was not spoken, say so; if it was spoken twice, say so.
- Toolbar and recovery groups: they are labelled groups of buttons. Use `VO+Shift+Down` to enter a group and `VO+Right` through its buttons.

## Viewports, theme, motion, contrast

Safari: Develop menu, Enter Responsive Design Mode, then type 375×900, 768×900, 1280×900. Chrome: DevTools, Toggle device toolbar, Dimensions Responsive. Theme: `Review controls`, `Theme`. Reduce motion and Increase contrast: System Settings, Accessibility, Display; the terminal and Cinder follow the system setting, and the terminal stops its cursor blinking under Reduce motion. Forced colors: Chrome DevTools, Rendering, `Emulate CSS media feature forced-colors`; Safari has no forced-colors emulation, so for Safari record the result under macOS Increase contrast. Contrast: Chrome DevTools color picker, or Xcode Accessibility Inspector.

## Recording each row

Work through `review-evidence.md` from top to bottom, one browser at a time (all Safari rows, then all Chrome rows) so VoiceOver and viewport settings stay fixed.

For each row:

- Follow the steps in the row's step column.
- Write what you observed in Observed, quoting what VoiceOver said. Compare it to the Expected column, which quotes the specification.
- Save a screenshot as `documentation/terminal/review-screenshots/<row>.png` and put the file name in Screenshot.
- Write `pass` or `fail` in Outcome. A row passes only when the observation meets the expected observation and the pass condition. Anything else is `fail`.
- For a `fail`, describe the finding in Finding and fix SHA and decide whether it is blocking.

Fill the resting-states table the same way, and the inherent-limits section last. Then fill the Acceptance block and the verdict section at the end of `components/terminal/src/lib/components/terminal/terminal.a11y.md`.

## Blocking findings

A blocking finding is one that makes a required task impossible, misleading, or inaccessible with VoiceOver, or that loses or rewrites input, steals focus, or sends bytes the user did not intend. Per the issue:

- Every blocking finding is fixed in source.
- The fixed behavior is re-reviewed at the new SHA, in a new row suffixed `.r2` (and so on), with the fix SHA recorded on the failing row. Rebuild the example from that SHA first (`dev` rebuilds on start).
- No required task is waived or turned into a follow-up. A row you cannot perform is not passed by omission: the application changes and the row is reviewed again. A state the review controls inject rather than produce is recorded as injected, and you decide whether that is acceptable evidence for the row.
- Automated axe or Playwright passes alone cannot close the issue.

## Checks the repository can run for you

These do not replace the review:

```sh
bun run test:browser:terminal
bunx prettier --check components/terminal/src/lib/components/terminal/terminal.a11y.md documentation/terminal/review-evidence.md documentation/terminal/review-runbook.md
bun run validate
```
