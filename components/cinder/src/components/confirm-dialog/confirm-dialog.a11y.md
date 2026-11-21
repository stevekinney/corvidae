# ConfirmDialog Accessibility

## Dialog model

ConfirmDialog is one of three dialog-level components. For the general dialog contract see [`Modal`](../modal/modal.a11y.md); for the sticky blocking variant see [`AlertDialog`](../alert-dialog/alert-dialog.a11y.md).

## Role Inheritance

`ConfirmDialog` has no own `role`. It inherits `role="dialog"` and `aria-modal="true"` from the underlying `<Modal>`. The `dialog` role is used intentionally — not `alertdialog`.

`alertdialog` is reserved for system-initiated urgency where the session state has already changed and dismissal without acting is incorrect (session expiry, process failures, out-of-band errors). User-initiated confirmation prompts are non-urgent: the user can press Escape to reconsider without consequence. Overusing `alertdialog` for routine confirmations degrades its effectiveness as an urgency signal.

Use `AlertDialog` when the dialog is triggered by a _system event_ and Escape would let the user bypass a mandatory acknowledgement. Use `ConfirmDialog` when the user voluntarily initiated the action — even a high-impact or irreversible one — and Escape is a valid "never mind."

## ARIA Attributes

- **`aria-labelledby`**: Inherited from `<Modal>`; points at the `<h2>` title element. The title is the confirm dialog's accessible name, announced when the dialog opens.
- **`aria-describedby`**: When `description` is provided, `<dialog>` gets `aria-describedby` referencing the `<p>` in the modal body. Screen readers announce the description immediately after the title on open. When `description` is omitted, no `aria-describedby` is set — the attribute is never emitted as an empty string.

**Description constraint**: `aria-describedby` works best with short, plain text. Screen readers announce the entire referenced text as one continuous run — a paragraph plus a list would be announced as an unbroken blob. For rich body content (markup, lists, multiple paragraphs), compose `<Modal>` + `<Button>` directly instead.

## Default Focus

The cancel button carries the `autofocus` attribute. When the dialog opens, `<Modal>` detects the `[autofocus]` child and defers its body-container fallback, letting the browser move focus to the cancel button.

This is the industry-standard guard against accidental destructive confirms:

- macOS NSAlert defaults focus to the non-destructive button.
- GNOME HIG and APG's confirmation pattern example both default to cancel.
- [WCAG 3.2.1](https://www.w3.org/WAI/WCAG22/Understanding/on-focus.html) is satisfied—focus is moved by the dialog opening, not by user input.

The confirm button never carries `autofocus`. `ConfirmDialog` exposes no prop to change the default focus target — consumers who need a different focus default should compose `<Modal>` + `<Button>` directly.

**Color is never the sole destructive signal.** `destructive={true}` changes the confirm button to `variant="danger"`. The cancel button still receives default focus. The `confirmLabel` prop is required so consumers must name the action being confirmed ("Delete account", "Discard changes")—generic labels like "OK" or "Confirm" are explicitly disallowed.

## Keyboard Interactions

| Key | Behaviour |
| --- | --- |
| Tab / Shift+Tab | Cycles focus through focusable elements inside the dialog. Focus trap is inherited from `<Modal>` via native `<dialog>.showModal()`. |
| Escape | Closes the dialog and fires `onCancel` via Modal's native `cancel` event handler. |
| Enter on cancel button | Dismisses without confirming. |
| Enter on confirm button | Confirms the action and closes the dialog. |

## Cancellation Paths

`onCancel` fires on all four user-initiated dismissal paths:

1. **Cancel button click** (button owned by `ConfirmDialog`).
2. **Escape key** — via the native `cancel` event on `<dialog>`, routed through Modal's `onDismiss`.
3. **Backdrop click** — routed through Modal's `onDismiss`.
4. **Close-X button** — routed through Modal's `onDismiss`.

Parent-driven `open = false` does **not** fire `onCancel`.

## Focus Return

Inherited from `<Modal>`. When the dialog closes, focus is restored to `triggerRef` if provided, otherwise to the element that held focus when the dialog opened.

## Screen Reader Announcements

On open, supporting screen readers announce:

1. The dialog role (`dialog`).
2. The accessible name (from `aria-labelledby`, the title).
3. When `description` is provided: the description text (from `aria-describedby`).

While `pending`, the skeleton's `pendingLabel` is announced once as a status and nothing describes the dialog. The failure region is mounted before any failure and is a live alert, so a failure that arrives, including one that carries an `errorAction`, is announced. Cancel stays enabled in both states. On a phone, when a failure carries an `errorAction`, Cancel is the only button of the footer row and is drawn compact at the inline end rather than full width, so the action in the callout leads in reading and focus order; it still reaches 44px through its hit area (`data-cinder-hit-target`) and keeps its label. `errorAction` removes the confirm button while the failure shows; if that button held focus, the page decides where focus goes (the action in the callout, or the refreshed description), because the dialog does not move it.

## Label Guidelines

`confirmLabel` is required. The component is scoped to action confirmation; making the label required forces consumers to name the specific action rather than ship a generic affirmative:

- **Destructive**: "Delete", "Delete account", "Discard changes", "Remove from organization".
- **Non-destructive**: "Save", "Save changes", "Continue", "Publish".
- **Never in production**: "OK", "Confirm", "Yes" — these don't communicate what will happen.

If a truly generic affirmative is required, compose `<Modal>` + `<Button>` directly.
