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

When the adapter provides `sendRunInput`, the composer textarea stays enabled while `streaming` is `true`, so keyboard focus is never pulled out of it mid-run. Stop becomes a separate button beside Send, each with its own accessible name ("Stop generating", "Send message"), and the composer's shortcut description names the key the composer's `submitOn` listens for, so a modifier-Enter composer never announces a bare Enter. When the run ends and the side Stop button unmounts while it has focus, focus moves to Send, or to the textarea while Send is disabled. A follow-up that is waiting for the transport shows a visible "Sending…" label rather than relying on color or opacity; the row adds no live region of its own, because the transcript's log region announces the added message. One that the transport rejected shows the existing "Failed to send" alert with a Retry button.

## Composer actions

`composerActions` renders host-owned controls in the composer footer, before Send, so they sit in the tab order between the attachment button and Send. The host owns their semantics: give a `Select` or `Combobox` an accessible name (a visually hidden `label` works when the footer has no room for a visible one), and keep their state announced the way the control already does. Chat does not disable them while a run streams or a tool approval is pending; if the host locks a control during a run, it should disable it natively so the state is exposed.

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

Reasoning, tool calls, approval details, and step groups use the same Collapsible-based entry frame. The nearest existing patterns are `Collapsible` for disclosure state and `RunStepTimeline` for grouped execution history. The frame exists to unify the trigger, chevron, expanded-region semantics, and bounded body while leaving each domain part responsible for its own status and controls.

Design review outcome: approved. The frame removes competing disclosure treatments without inventing a second visual hierarchy, keeps native button semantics, and preserves the existing tool-approval actions. Consecutive completed tool calls may collapse into a timeline summary; action-required calls stay individual so Approve and Reject remain available.

Accessibility review outcome: approved with an explicit scroll-fade boundary. The message timeline and non-interactive bounded reading regions may use the shared overflow fade. Keyboard-navigable toolbars, tab lists, menus, listboxes, and chip rows intentionally do not: roving focus can place an item flush against an edge, where an opaque fade would obscure its focus indicator or text. Firefox continues to receive the non-animation fallback or no decorative fade; no control depends on the fade to communicate overflow.
