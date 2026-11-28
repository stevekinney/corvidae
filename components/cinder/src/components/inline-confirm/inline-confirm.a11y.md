# InlineConfirm design and accessibility review

## Design review (required)

- Reviewer: Cinder maintainers
- Review outcome: Final review complete—approved.
- Nearest neighbours: ConfirmDialog, Alert, ButtonGroup.
- Why this component exists: It keeps a short, reversible confirmation beside the action without interrupting the page with a top-layer dialog.
- Findings and resolutions: It uses document flow and existing Button primitives. It intentionally has no scrim, `aria-modal`, focus trap, body scroll lock, or modal backdrop. The non-destructive strip is a soft neutral; the destructive strip is a soft danger tint, and the tone is carried by the prompt (danger text color plus a decorative `aria-hidden` warning glyph) and the danger confirm button, while the prompt and the confirm label remain visible text. The strip dismisses with a quiet icon-only ghost X (COR-2825) before the confirm action, so the confirm action is the strip's one labelled button and keeps the trailing edge; under a coarse pointer the X answers a 44px press through Button's hit-area pseudo-element, which adds no spacing. With `flush`, at the start or end of a bordered container the strip drops its own rule there so it does not double the container's edge; without it, a standalone strip keeps both edges.

## Novel interaction accessibility review

- Applies: Yes—the component introduces an interactive group and participates in the shared Escape stack.
- Reviewer: Cinder maintainers
- Review outcome: Approved for implementation review.

### Focus management

The visible prompt labels `role="group"`. On open, focus moves to the dismissing X, the safe action. The focus ring shows when the strip was opened from the keyboard and not when it was opened with a pointer: the component remembers whether the last input was a `keydown` or a `pointerdown` and passes `focusVisible` to `focus()` accordingly. On cancel, confirm, or Escape, focus returns to the element active when the confirmation opened.

### Keyboard matrix

| Key or gesture | Context | Expected behavior |
| --- | --- | --- |
| Tab / Shift+Tab | Group open | Moves between actions and surrounding page content. |
| Enter / Space | Focused action | Activates the native Button action. |
| Escape | Group open | The topmost InlineConfirm cancels, prevents the page Escape action, and restores focus. |
| Pointer click | Either action | Runs the same cancel or confirm lifecycle as keyboard activation. |

### Assistive-technology announcements

The visible prompt names the group. The confirm action has a specific visible label; the X's glyph is `aria-hidden`, and `cancelLabel` (default "Cancel") is its accessible name, carried in screen-reader text rather than shown. The component does not use `role="alertdialog"`, `aria-modal`, or a live region because this is an in-flow decision rather than an urgent announcement.

### Two-press arming

A destructive two-press action is the solid danger face at rest and armed (COR-2683). Arming changes the label to the armed label, shows the optional `armedHint`, and draws a danger ring around the button, built like a filled button's focus ring (a 2px page-coloured gap, then `--cinder-status-danger-solid`, which clears 3:1 against the page in both themes). It outranks the Button's own danger focus ring, so a keyboard user who arms the action sees it and it stands in for the focus ring; under forced colours it is a `Highlight` outline. `inline-confirm-two-press.playwright.ts` measures it in both themes. Colour is never the only signal: the label change carries the armed state.

## Verification

- Verify the dismissing X, named by `cancelLabel`, receives focus first.
- Verify the X answers a 44px press under a coarse pointer (`inline-confirm-strip.playwright.ts`).
- Verify Escape follows LIFO ordering with another overlay.
- Verify both actions and Escape close the group without a dialog element or scroll lock.
