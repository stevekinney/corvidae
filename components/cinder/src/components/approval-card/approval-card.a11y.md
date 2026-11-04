# ApprovalCard Accessibility

## Pattern

Repeatable approval unit rendered as an `<article>` with native button controls. The component is presentational: it never executes the operation and only calls `onResolve` when the user activates an explicit action. Nested content uses plain headings instead of labelled sections, so a queue of many approval cards adds no landmarks to the page.

## Roles names states

| Element | Role | Accessible name | State |
| --- | --- | --- | --- |
| Root `<article>` | `article` | Heading text, for example `Approval required for deploy-cloud` | `data-cinder-state`, `data-cinder-risk` |
| Header status | text + `StatusDot` | State label such as `Expired` or `Unavailable` | Shown for anything but an answerable pending approval |
| Risk glyph | `img` (`tabindex="0"` in the `card` layout) | Risk label, e.g. `High risk` (via `aria-label`) | `Tooltip` shows the same label on hover/focus in the `card` layout; the muted risk word is also written in text |
| Input toggle (`row`) | button | `Input` and the summary pairs | `aria-expanded`, `aria-controls` the disclosed region |
| Add a note (`row`) | button | `Add a note` | Opens the `Note (optional)` textarea |
| Allow checkbox | checkbox | `Allow <tool> for <scope>` | Rendered only when `rememberScope` is set |
| Disabled reason | text | The reason | Named by Deny and Approve through `aria-describedby` while they are off |
| Action group | `group` | `Approval actions` | Rendered only while actionable and `onResolve` is wired |
| Action buttons | button | Visible button text | `Approve with edits` is a disclosure with `aria-expanded` |
| Edited arguments textarea | textbox | `Edited arguments JSON` | `aria-invalid` and `role="alert"` error text when JSON is invalid |
| Details | button + panel | `Details` | Collapsed by default; holds sandbox, environment, and request metadata |

## Keyboard

All approval actions are native buttons and follow browser keyboard behavior. Activating `Approve with edits` reveals the JSON editor and moves focus into the textarea; the button reflects the panel with `aria-expanded`. The component does not add roving focus, global shortcuts, or key handlers.

## Heading structure

The card title renders at `headingLevel` (default `3`) and section headings one level deeper, so hosts can slot the card into an existing document outline without skipped levels.

## State communication

Risk and approval state are communicated with more than color. The status dot is accompanied by its visible text label. The risk is also written as a muted word (Reads, Changes things, Dangerous), and "Can't be undone" is written out, so the amber glyph is never the only signal; the glyph's `aria-label` names the level (`Low risk` / `Medium risk` / `High risk`). A denied approval is neutral text, not an error colour. An unavailable approval shows the word "Unavailable" and its reason, with no decision buttons.

When `expiresAt` passes, the effective state becomes `expired` and the action buttons are removed. Expiration never fires `onResolve`; the host remains the source of truth for persisted state.

## Security boundary

`env` accepts environment variable names only. If a caller accidentally passes a `NAME=value` string, the component renders only the name before `=` and never renders the value. Names render as plain text chips — no masked placeholders that would imply secret material is present in the DOM. The list carries an `aria-label` stating that values are never shown, for anyone using a screen reader.
