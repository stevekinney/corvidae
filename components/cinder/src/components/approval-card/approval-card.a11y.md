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
| Arguments toggle (`card`) | button | `<tool> arguments` (or `inputLabel`) and the summary pairs | Collapsed by default; `aria-expanded`, `aria-controls` the disclosed region |
| Touched file | list item | The path, read whole | The file glyph is decorative (`aria-hidden`); the copy button is named `Copy path <path>` |
| Add a note | button | `Add a note` | Opens the `Note` textarea and moves focus into it; the button leaves, and the field stays open until the request changes |
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

Risk and approval state are communicated with more than color. The status dot is accompanied by its visible text label. The risk is also written as a muted word (Reads, Changes things, Dangerous), and "Can't be undone" is written out, so the amber glyph is never the only signal; the glyph's `aria-label` names the level (`Low risk` / `Medium risk` / `High risk`). A denied approval is neutral text, not an error colour. An unavailable approval shows the word "Unavailable" and its reason, with no decision buttons. A row decided on another page (`decidedIn`) drops the risk glyph for a decorative check or prohibition glyph (`aria-hidden`), because the decision is written out beside it ("Approved by you in Reviews, 10:46 AM").

When `expiresAt` passes, the effective state becomes `expired` and the action buttons are removed. Expiration never fires `onResolve`; the host remains the source of truth for persisted state.

While an answer is in flight (`resolving`), the button being answered carries `aria-busy` and `aria-disabled` (it stays focusable), shows a spinner, and a polite status announces "Approving…" or "Denying…"; the other button is natively disabled. A failed answer (`failure`) is written in a `role="alert"` region so it is announced when it appears, and its meaning never rests on colour: the summary is bold, a glyph leads it, and the sentence says what failed and what is still true.

## Decision layout

The `decision` layout names its article by the action title. An irreversible primary is armed by its first press: the button's name changes to "Press again to ...", it is described by a polite status that reads "Reverts in 3 seconds." and a visually hidden keyboard instruction that reads "Escape cancels.", and focus stays on the button. The arm reverts after three seconds, on Escape, when a new request replaces the approval, or when a `disabledReason` appears; the Escape handler runs only while armed and prevents the event's default so a host can tell it was handled. While `disabledReason` is set, every commit path (Deny, the primary, an armed press, Confirm edited approval) stays inert with `aria-disabled` and names the reason with `aria-describedby`. The receipt's outcome is written as a text badge beside a decorative check or prohibition glyph, so colour and the glyph never carry it alone. The "Details", "Input" and "Why the agent wants to do this" disclosures are native buttons with `aria-expanded` and `aria-controls`.

## Security boundary

`env` accepts environment variable names only. If a caller accidentally passes a `NAME=value` string, the component renders only the name before `=` and never renders the value. Names render as plain text chips — no masked placeholders that would imply secret material is present in the DOM. The list carries an `aria-label` stating that values are never shown, for anyone using a screen reader.
