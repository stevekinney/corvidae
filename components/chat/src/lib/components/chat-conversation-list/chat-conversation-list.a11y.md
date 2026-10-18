# ChatConversationList · accessibility

## Pattern

ChatConversationList packages a higher-level workflow. Confirm the composed controls, labels, states, and keyboard path match the domain task instead of treating the visual shell as the accessibility contract.

Purpose: Conversation navigation list for switching among Chat transcripts without embedding the list inside Chat.

## Use when

- Rendering a multi-conversation chat sidebar beside one active Chat transcript.
- Showing unread counts and last-message previews for compatible conversation snapshots.

## Avoid when

- Rendering the message transcript itself — use chat for the active conversation surface.
- Building app-wide primary navigation — use side-navigation or navigation-bar.

## Keyboard and focus

Keyboard behavior follows the rendered native elements and any ARIA pattern documented by the component. Avoid adding handlers that change focus order without a matching visible and programmatic state update.

Keep focus indicators visible. If you wrap or restyle ChatConversationList, verify the focused element remains visually apparent in default and forced-colors modes.

## Names, roles, and state

Use the public props and documented examples to provide accessible names, descriptions, current state, disabled state, selection state, or value text. Do not rely on color, icon shape, placeholder text, or layout position as the only way to communicate meaning.

When ChatConversationList accepts snippets or arbitrary children, the caller owns the semantics inside those children. Prefer native elements first, and add ARIA only when it matches the rendered behavior.

## Agent, activity, and load more

The agent name is read with an "Agent:" prefix. `running` and `awaiting-input` activity render Cinder's `StatusDot` with `role="img"`, an accessible name ("Running", "Awaiting input"), and the same text visible beside the dot, so state is never carried by color alone; `idle` renders nothing. Because the dot sits inside the row's button, it is part of the button's name, and a screen reader hears it with the title and preview.

The load-more control is Cinder's `LoadMore`: a real button that remains available when the scroll sentinel does not fire, `aria-busy` and disabled while `loading`, and a polite status for its states. It follows the last row inside the navigation landmark. The list becomes the scroll container only while the control is showing; keep its height bounded and verify keyboard focus reaches the button after the last row.

## Verification

- Render ChatConversationList in the playground or a focused test fixture.
- Navigate the component with keyboard only.
- Inspect the accessible name, role, and state in browser accessibility tools.
- Check forced-colors mode when the component adds borders, focus rings, selected state, or status color.

Related components: `chat`, `chat-conversation-header`, `side-navigation`.
