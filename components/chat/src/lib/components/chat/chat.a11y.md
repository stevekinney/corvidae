# Chat · accessibility

## Pattern

Chat packages a higher-level workflow. Confirm the composed controls, labels, states, and keyboard path match the domain task instead of treating the visual shell as the accessibility contract.

Purpose: Opinionated conversation surface bundling message list, composer, attachments, and scroll affordances for AI or support transcripts.

## Use when

- Shipping a full chat surface with composer, scroll-anchor, unread indicator, and attachments bundled as one heavyweight drop-in.
- Building an AI assistant or support thread where conversation state is modeled as a transcript of role-tagged messages.

## Avoid when

- Rendering a one-off message list — compose lighter primitives directly instead of pulling the full suite.
- The transcript is read-only and needs no composer — a simple list of message bubbles is a better fit.

## Keyboard and focus

Keyboard behavior follows the rendered native elements and any ARIA pattern documented by the component. Avoid adding handlers that change focus order without a matching visible and programmatic state update.

Keep focus indicators visible. If you wrap or restyle Chat, verify the focused element remains visually apparent in default and forced-colors modes.

## Names, roles, and state

Use the public props and documented examples to provide accessible names, descriptions, current state, disabled state, selection state, or value text. Do not rely on color, icon shape, placeholder text, or layout position as the only way to communicate meaning.

When Chat accepts snippets or arbitrary children, the caller owns the semantics inside those children. Prefer native elements first, and add ARIA only when it matches the rendered behavior.

## Verification

- Render Chat in the playground or a focused test fixture.
- Navigate the component with keyboard only.
- Inspect the accessible name, role, and state in browser accessibility tools.
- Check forced-colors mode when the component adds borders, focus rings, selected state, or status color.

## Follow-ups during a run

When the adapter provides `sendRunInput`, the composer textarea stays enabled while `streaming` is `true`, so keyboard focus is never pulled out of it mid-run. While the box is empty Stop takes Send's place as one button named "Stop generating"; once a follow-up is typed, Send comes back beside it as a second button named "Send message", so the message can be sent without a keyboard too. The composer's shortcut description names the key the composer's `submitOn` listens for, so a modifier-Enter composer never announces a bare Enter. When the run ends and the side Stop button unmounts while it has focus, focus moves to Send, or to the textarea while Send is disabled; when the main button turns back from Stop to a disabled Send while it has focus, focus moves to the textarea. A follow-up that is waiting for the transport shows a visible "Sending…" label rather than relying on color or opacity; the row adds no live region of its own, because the transcript's log region announces the added message. One that the transport rejected shows the existing "Failed to send" alert with a Retry button.

A follow-up submitted during a run waits in the Up next drawer instead of going to the run, and Send reads "Queue message" while a draft is typed. The drawer is a labelled section ("Up next"); each waiting follow-up is a list item whose Edit and remove buttons are named with its position, such as "Edit queued follow-up 1" and "Remove queued follow-up 1", and the position number itself is hidden from assistive technology so it is not read twice. Queueing a follow-up and removing one are announced through the chat's polite live region. Removing the last one moves focus to the composer. Send now instead is a plain button. The drawer that appears when the run is stopped or fails is a labelled group ("Follow-ups not sent") with Dismiss before Restore.

## Composer actions

`composerActions` renders host-owned controls in the composer footer, before Send, so they sit in the tab order between the attachment button and Send. The host owns their semantics: give a `Select` or `Combobox` an accessible name (a visually hidden `label` works when the footer has no room for a visible one), and keep their state announced the way the control already does. Chat does not disable them while a run streams or a tool approval is pending; if the host locks a control during a run, it should disable it natively so the state is exposed.

## Composer controls, the hint and the blocked row

`composerControls` renders the host's selects right after the attach button, in the tab order before Send; give each a name with a visually hidden `label`, and draw its visible words (`Model`, `Effort`, `Permissions`) with `valuePrefix`, which is hidden from assistive technology. The hint under the box ("Enter to send · Shift and Enter for a new line") is for sighted readers and is `aria-hidden`: the composer's hidden shortcut description is what Send and the textarea point at. `composerStatus` replaces the hint with a line of the host's own, and its change is announced politely through the composer's live region.

`composerHeader` draws the host's control above the text, inside the composer's border, before the toolbar and the text in the tab order. When the composer is narrower than `COMPOSER_FOLD_WIDTH`, `composerControls` is called with `folded: true` so the host can replace its selects with one control, named for what it holds ("Settings: Model, Effort and Permissions"); the footer never wraps, and its controls are 44px tall on a phone-width composer. The formatting toolbar (`composerFormattingToolbar`) is a `toolbar` named "Formatting" that appears once the box or the toolbar takes focus and stays while focus is in the composer (a control the host places in the composer does not open it, so that control does not move under a click); each button names its shortcut with `aria-keyshortcuts`, and the visible list of shortcuts beside it is `aria-hidden`, because the buttons already carry the words. Link is Cmd or Ctrl with Shift and K; plain Cmd or Ctrl with K is never consumed, so the host's command palette still opens from the text box. The attached files are a list named "Attached files": each chip names the file and its size, Remove is named for its file (`Remove refund-photo.png`), and a file that failed puts its reason in text beside the chip rather than in the chip's colour alone.

`composerFooter` draws the host's own content after the composer, so it follows the text box, its controls and Send (and the hint or the blocked row) in the tab order and the reading order; the host owns its semantics. With `composerPlacement="centered"` the empty state, the composer and the footer are one block in the middle of the surface; the reading order is unchanged, because the transcript region still comes before the composer, and the composer docks again once the conversation has a message.

`composerLead` draws the host's own content directly before the composer in the tab order and the reading order, whether the composer is live or blocked; the host owns its semantics. While `composerStarting` is set, Send keeps its place, reads the starting word as its name (`Starting chat…`), and is disabled, and the composer is marked busy; the typed text stays in the box, so nothing the person wrote is lost if the start fails.

With `composerStatus` of `kind: 'blocked'` the composer is one `group` named "Composer unavailable": a decorative warning glyph, the reason as text, and an optional button and link. There is no text box to focus, so the reason is also announced politely when the row appears. A draft typed before the row came, and files attached before it, are kept and return with the composer.

## Quoting agent messages

Quoting is reachable without a pointer. Every assistant message has a Quote message button in its action row that quotes the selection inside that message, or the whole message when nothing in it is selected, so a keyboard user never needs the selection popover. The popover is a Cinder `SelectionPopover` named "Quote selection". It is a toolbar with one Quote button: focus moves to the button when the popover opens, and Escape or any outside press closes it and returns focus to where it was. It waits for a pointer drag to finish before taking focus, so it does not cut a selection short.

Quoted excerpts are a list named "Quoted excerpts" above the composer, in the order they were added. Each item shows the first 80 characters of its quote and has a Remove button named "Remove quote: " followed by that preview. Removing a chip moves focus to the Remove button that takes its place, and to the composer when none are left. Adding, removing, repeating, and refusing a quote are announced politely through the transcript's status region ("Quote added", "Quote removed", "That text is already quoted"). When a failed send puts its quotes back and some do not fit within the limit, Chat announces how many were dropped.

At 10 quotes both Quote buttons are disabled natively and reference the visible "Quote limit reached" text in the chip row through `aria-describedby`, so the reason is exposed even though a disabled button cannot take focus. The Quote button's meaning does not rely on its icon: the message action carries an accessible name and the popover button has a text label.

## scrollFadeVisible (Tier 3 polish)

`scrollFadeVisible` paints an opaque, scroll-driven fade (never a `mask-`) on the top and bottom edges of the message timeline as it overflows, using `@lostgradient/cinder`'s shared `_scroll-fade.css` recipe. It is presentation-only and never the sole signal that more messages exist — the jump-to-latest button and unread-count indicator (`atBottom`, `unreadCount`, `newMessageIndicatorVisible`) remain the authoritative affordances, unaffected by this prop. The timeline's own `role="log"`/`aria-live` and `:focus-visible` ring (documented above) are unchanged. Only visible when `surfaceMode` is `'default'`: with `surfaceMode="transparent"` the timeline paints no background of its own, so the JS driver is gated off entirely rather than fading toward an incorrect color (see `chat.types.ts`). `@media (forced-colors: active)` disables the fade outright.

Related components: `markdown-editor`.

## Nested transcript and navigation rail

`ChatSubSession` is a bounded, nested `role="log"` that reuses Chat's existing message and typography contracts. Its reduced type ramp, 7.75rem clamp, and edge fade preserve hierarchy without adding a second conversation model. Live motion is limited to the child while `live` is true and is disabled under `prefers-reduced-motion`.

`ChatNavigationRail` uses real buttons, `aria-current` from a Set of IntersectionObserver hits, and `aria-describedby` preview text. Pointer capture scrubbing maps to message rows and clamps beyond either end. The rail is a navigation aid, never the only way to reach a message; the transcript remains keyboard navigable. CSS sibling selectors provide proximity falloff without per-row JavaScript. Reduced motion removes every rail transition.

Design review outcome: approved. The two surfaces are Chat-owned because they need transcript identity and virtualization-aware navigation, while remaining small enough to compose beside a Chat instance. No general table-of-contents abstraction is introduced.

## Shared transcript entry frame

The lines a run leaves under a message (`cinder:notes` metadata: memory written, a time the run continues at, a child run, why the run stopped) are plain text rows. A time is a `<time>` with a machine-readable `datetime`, a link is shown only when it is a path inside the application, and a child run's status is spelled out in words rather than shown by colour. The disclosure that holds a model's reasoning is labelled "Thinking".

In the transcript presentation (`variant="transcript"`) the role label of each message stays in its accessible name but is not drawn. The line under a message is a labelled group, "Message details". A message that was not sent has a button, "Not sent: details", that opens a popover (focus moves into it) with the reason and a Retry button; an inert Retry is a disabled button with its reason beside it, and "Not sent" is a polite status. A failed run's stop note is a status line, so its words are announced when it appears, and its action is an ordinary button. A queued message says "Queued · sends when the run is ready" in text, and Remove is a button. The agent's instructions are behind a button, "Instructions · Show", with `aria-expanded` and `aria-controls` naming the text it opens.

A turn's run outcome (`messageTurnState`) sits on the turn, after its text and inside its row, so it is read with the message it describes. A reconnecting turn's warning is a note, not a live region, because its countdown changes every second; the composer's own reconnect status is what is announced. Its bar is a progressbar named "Time until the next try", whose value text is the seconds left. A stopped turn's pill is text, and Discard and Continue are ordinary buttons in that order. A turn that failed partway is an alert, so "This answer is incomplete." and its cause are announced once when it appears, with Retry as an ordinary button. An empty turn's words are a polite status beside its time and Try again. In a step group, the spinner of the step under way is hidden from assistive technology, because the group's live summary already names each step's status; a failed step's row opens with its Failed status in text, and Copy error and Retry this step are ordinary buttons under it. Every outcome's text sets `dir="auto"`.

Reasoning, tool calls, approval details, and step groups use the same Collapsible-based entry frame. The nearest existing patterns are `Collapsible` for disclosure state and `RunStepTimeline` for grouped execution history. The frame exists to unify the trigger, chevron, expanded-region semantics, and bounded body while leaving each domain part responsible for its own status and controls.

While a tool approval waits, a group named "Approval waiting" above the composer carries the sentence "Waiting for your approval. Anything you send now queues until you decide." and a Review approval button. The button scrolls the approval into view and moves focus to its card, which is focusable by script alone, so activating it never answers the approval. With a draft in the composer, Send is named "Queue message" and carries the queue icon. The explicit decision surface arms an irreversible primary with a polite status ("Reverts in 3 seconds. Escape cancels."); Escape reverts the arm and is handled, so the same keystroke does not cancel the approval.

Design review outcome: approved. The frame removes competing disclosure treatments without inventing a second visual hierarchy, keeps native button semantics, and preserves the existing tool-approval actions. Consecutive completed tool calls may collapse into a timeline summary; action-required calls stay individual so Approve and Reject remain available.

Accessibility review outcome: approved with an explicit scroll-fade boundary. The message timeline and non-interactive bounded reading regions may use the shared overflow fade. Keyboard-navigable toolbars, tab lists, menus, listboxes, and chip rows intentionally do not: roving focus can place an item flush against an edge, where an opaque fade would obscure its focus indicator or text. Firefox continues to receive the non-animation fallback or no decorative fade; no control depends on the fade to communicate overflow.

## Docked question and availability states

With `questionPlacement="docked"` a question that has choices takes the composer's place as a form whose fieldset is named by its legend, "The agent is asking", with the question as its first line. The choices are Cinder's `ChoiceGrid` cards (a radio group named by the question), so the arrow keys move and select, and Space or Enter selects. A choice only selects: the primary Answer is the one control that sends, and while it is off its reason ("Choose an answer to continue") is visible and named by `aria-describedby`. The keys 1 to 9 choose a card (the number is drawn on the card in an `aria-hidden` key cap) but only while focus is inside the dock, never inside a field and never with Alt, Control or Meta held, so they cannot take over typing or a browser shortcut. "Needs you" and "Question 2 of 3" are text, not colour. Reply in chat instead is an ordinary secondary button that moves focus to the composer.

An `availability` state replaces the transcript. While loading, the status line is announced once ("Loading conversation…") and again when the read turns slow; the ticking seconds are never in a live region. A failed or deleted conversation is Cinder's `ErrorState`, so a failure is an alert and a deleted conversation is a plain group, and both hide the composer. An archived or read-only chat draws a neutral group in the composer's place; "Read only" is a focusable control that names its tooltip with `aria-describedby`.
