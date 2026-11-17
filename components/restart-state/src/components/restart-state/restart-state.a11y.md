# RestartState design and accessibility review

Complete this record before merge. Automated checks can detect malformed APIs, missing semantics, and structural regressions. They cannot decide that a component is drab, bulbous, ugly, has a poor layout, or whether the interaction model is wrong. Those judgments require human review.

## Design review (required)

- Reviewer: Cinder maintainers
- Review outcome: Final review complete—approved.
- Nearest neighbours: Modal, AlertDialog, ConfirmDialog, Banner, Steps.
- Why this component exists: A restart takes the host that serves the page away, so the page cannot say anything true about itself until the host is back. Every product that restarts itself needs the same three words (it is restarting, it is not answering yet, it did not come back), and the failure needs the way back to be on the screen, because the restart route is on the host that is not answering. A modal that can be dismissed leaves the person looking at stale data; a banner leaves the page live.
- Findings and resolutions: The card is drawn inside a chromeless Modal rather than a default one, because the default header cannot carry the phase's icon and draws a rule the design does not have. The steps are Steps with the status variant rather than a bespoke list, and the copy button is a Button, so the card adds no new control.

## Novel interaction accessibility review

A novel interaction model includes a new disclosure or keyboard pattern, entering or leaving the top layer, or making previously static content interactive.

- Applies: Yes—the state enters the top layer through Modal and has no way to dismiss it.
- Reviewer: Cinder maintainers
- Review outcome: Approved. Nothing dismisses it by design, and every phase either has an action that leaves it (Retry now, Keep waiting) or ends when the page closes it.

### Focus management

Modal traps focus inside the card and focuses the dialog body when it opens, because no control has initial focus. The buttons each phase shows are ordinary buttons in tab order. Focus is restored to the trigger when the page closes the state.

### Keyboard matrix

| Key or gesture | Context | Expected behavior |
| --- | --- | --- |
| Tab, Shift+Tab | Any phase | Moves between the card's buttons and the error-details disclosure, and stays inside the card. |
| Enter, Space | Retry now, Keep waiting, Copy, the disclosure | Activates the control. |
| Escape | Any phase | Does nothing: the state is not dismissible. |
| Click or tap | The scrim | Does nothing. |

### Assistive-technology announcements

The dialog is named by its heading and described by the sentence under it. The steps list is a status region, so each step that finishes is announced. The attempt meter is decorative and hidden from assistive technology; a separate polite status says "Attempt 3 of 8." when the attempt changes, so a countdown that ticks each second is not read out. Copy announces "Copied the command." The spinning glyph and the phase icons are decorative.

## Forced colors

The card's border repaints with `CanvasText`, and the meter's segments repaint with `GrayText` and `Highlight` so progress still reads without a fill colour.

## Reduced motion

The restarting glyph stops spinning under `prefers-reduced-motion: reduce`; the steps list and the heading still say what is happening.
