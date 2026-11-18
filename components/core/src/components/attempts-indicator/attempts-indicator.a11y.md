# AttemptsIndicator design and accessibility review

Complete this record before merge. Automated checks can detect malformed APIs, missing semantics, and structural regressions. They cannot decide that a component is drab, bulbous, ugly, has a poor layout, or whether the interaction model is wrong. Those judgments require human review.

## Design review (required)

- Reviewer: Cinder maintainers
- Review outcome: Final review complete—approved.
- Nearest neighbours: Progress, Meter, Sparkbar.
- Why this component exists: A goal, a retry or a reconnection has a fixed number of attempts, and a continuous fill hides how many whole attempts are left. One segment per allowed attempt shows the count at a glance, and the list row and the reconnecting dialog draw it the same way.
- Findings and resolutions: The bar is neutral by default because the status word beside it carries the outcome; colour never carries meaning alone. The segments are hidden from assistive technology and the whole bar is one named image.

## Novel interaction accessibility review

A novel interaction model includes a new disclosure or keyboard pattern, entering or leaving the top layer, or making previously static content interactive.

- Applies: No—the indicator is static and non-interactive.
- Reviewer: Not applicable.
- Review outcome: No novel interaction review required.

### Focus management

Not applicable; the indicator is not focusable or interactive.

### Keyboard matrix

| Key or gesture | Context          | Expected behavior        |
| -------------- | ---------------- | ------------------------ |
| None           | Static indicator | No keyboard interaction. |

### Assistive-technology announcements

The indicator is `role="img"` with the name "2 of 5 attempts" (or the `label` you pass). It is not a live region: when attempts change, announce the change in the surrounding text, as the reconnecting dialog does ("Attempt 3 of 8").

## Forced colors

Under forced colors the filled segments are drawn with `Highlight` and the empty ones as a `GrayText` outline, so the count survives without author colours.
