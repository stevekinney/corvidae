# Terminal accessibility

## Pattern

Terminal composes Cinder's `TerminalFrame`, a labelled region with a title and status, around the selected terminal engine. The frame supplies the region and the status vocabulary; the engine supplies the screen, the selection, and the text-input surface. The interaction and accessibility contract is `documentation/terminal/experience.md`.

## Use when

- Showing a real terminal session whose output the reader may select, scroll, and copy.
- Sizing a process to the grid the engine measured, instead of an estimate.

## Avoid when

- Rendering a finished log: `TerminalOutput` is a read-only focusable log viewport and is the better fit.

## Names, roles, and state

The frame is a `region` named by its title. Every state has one visible message in the component's only polite `status` region, so a change between states that share a frame status, such as writable, read-only, and backpressured, is still announced. The frame's own status chip names the state in its closed vocabulary and stays visible, but the component sets `announceStatus={false}` on the frame so it does not announce a second time. An error or cleanup state is stated in text, never by color alone, and keeps the last useful output on screen.

| State                | Message                                      |
| -------------------- | -------------------------------------------- |
| `empty`              | No terminal session                          |
| `loading`            | Loading terminal…                            |
| `connecting`         | Connecting…                                  |
| `writable`           | Connected                                    |
| `read-only`          | Read-only                                    |
| `backpressured`      | Backpressure: input paused                   |
| `exited`             | Process exited                               |
| `disconnected`       | Disconnected                                 |
| `denied`             | Access denied                                |
| `failed`             | Terminal failed                              |
| `cleanup-incomplete` | Cleanup incomplete—new sessions are disabled |
| `engine-load-failed` | Terminal engine unavailable                  |

Until the engine mounts, the viewport is `inert` and the message says `Loading terminal…`, so a server-rendered page never offers an editable surface that does nothing. The engine's input surface takes its accessible name from `ariaLabel` (default `Terminal`). `announceOutput` mirrors engine output into the engine's bounded live region; it is off by default.

## Keyboard and focus

Arriving output, a state change, and mounting never move focus. The engine's input surface is an ordinary tab stop, so Tab enters and leaves it. A visible focus ring surrounds the viewport while focus is inside it, and under forced colors the ring uses the system `Highlight` color. Sending input, safe paste, and the `Capture terminal keys` interaction belong to the input layer; this component only renders the control. Mouse reporting is off by default; when the host turns on `mouseReporting`, the pointer reports to the program only while the `Capture terminal keys` button is pressed, and otherwise the pointer selects text. While it reports, a `Mouse reporting on` badge is shown in the control group and referenced by the capture button's `aria-describedby`; it is plain text, not a live region. The program turning reporting on or off is announced once each in the polite status region; capture or the view changing it adds no second announcement. A paste while the program has bracketed paste on is always reviewed, and the review states whether a pasted terminator ends the protected paste early.

## Recovery actions

Recovery actions are Cinder buttons in a group labelled `Terminal recovery`, in the order the state table gives. They are native buttons: Enter and Space activate them, and they are ordinary tab stops. A button that cannot be used yet (`New session` and `Retry` while cleanup is pending) is disabled rather than hidden, so the reader can see why replacement waits; the state message says why. After activation focus stays on the button when it is still there. When the new state removes it, focus moves to the first action of the new state's group (`Cancel` after `New session`, `New session` after `Cancel`) or to the frame, and arriving output never moves focus. `Capture terminal keys` is a toggle: `aria-pressed` carries the state and the pressed button takes Cinder's filled accent face.

## Copying the selection

Copying the engine's selection (Cmd+C on a Mac, Ctrl+C elsewhere, or the browser's copy command) announces `Terminal selection copied` once through the polite status region. Selecting alone announces nothing, a copy of other page content announces nothing, and a copy with no selection is the interrupt chord, which is not a copy. The announcement is made from the copy chord, because Chromium raises no `copy` event for the engine's selection, and from a `copy` event that has no chord before it; a `copy` event within half a second of the chord is the same copy and is not announced again. The terminal observes the copy and does not take part in it: the browser and the engine complete it, and no byte is sent. A read-only view announces too.

## Output tools

The toolbar is a labelled group of buttons. `Search` is a disclosure (`aria-expanded`); its field is a labelled `Textarea`, and its status line (`role="status"`) reports `Match 2 of 7`, `No matches`, a wrap, or that only the most recent part of the output was searched. Enter steps to the next match, Shift+Enter inserts a line break, and Escape closes the search and returns focus to `Search`.

Each search step also selects the match in the terminal without scrolling or moving focus; closing the search drops that selection and returns focus to `Search`.

`Export` opens a `Modal` whose body is a labelled read-only `Textarea` of an immutable snapshot, with a status region for `Snapshot stale`, `Snapshot truncated` (earlier output was omitted), a replaced session, an empty terminal, and what `Download` will save (`Download ready` or `Download truncated`), all before anything is saved. Opening and refreshing are announced politely (`Terminal snapshot ready`, `Terminal snapshot truncated`, `Terminal snapshot refreshed`, `Terminal snapshot stale`). The actions are `Refresh`, `Copy`, `Download` and `Close`. Escape and `Close` dismiss it, and focus returns to `Export`, or to the frame when that button is gone; `Refresh` keeps focus on itself. Clearing is announced once (`Terminal screen cleared`, `Terminal history cleared`, `Terminal reset`).

## Motion and color

Reduced motion stops the cursor blinking and removes transitions and animations from the component. Cinder's `--cinder-terminal-ansi-*` tokens, text, and inset surface feed the engine theme, resolved against the terminal's own element so a themed subtree gets its own colors, and they are resolved again when the color scheme or a `data-theme` attribute changes.

## Reading position

New output follows only while the viewport shows the live bottom. A reader who scrolled away stays where they are while output appends, and scrolling back to the bottom resumes following.

## Output is inert

Terminal output is text. HTML, script, and escape sequences never become DOM or run code; a hidden OSC 8 destination is never offered or opened; OSC 52 clipboard requests and window-control requests are ignored; a program-set title reaches the host only as bounded plain text. Links are off unless the host handles `onLinkActivate`, and then only visible HTTPS text is offered.

## Human review verdict

The human design and accessibility review (COR-471) is performed by the named reviewer with VoiceOver in Safari and Chrome against `applications/terminal-example`. The task rows, versions, screenshots, findings, inherent limits, and acceptance are recorded in [`documentation/terminal/review-evidence.md`](../../../../../../documentation/terminal/review-evidence.md); the procedure is in [`documentation/terminal/review-runbook.md`](../../../../../../documentation/terminal/review-runbook.md). Automated browser and axe passes do not satisfy this verdict. The fields below stay blank until the reviewer records them.

| Field                              | Value |
| ---------------------------------- | ----- |
| Reviewer                           |       |
| Date                               |       |
| Reviewed source SHA                |       |
| Engine version                     |       |
| Verdict (accepted or not accepted) |       |
| Blocking findings open             |       |
