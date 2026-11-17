# Spotlight design and accessibility review

Complete this record before merge. Automated checks can detect malformed APIs, missing semantics, and structural regressions. They cannot decide that a component is drab, bulbous, ugly, has a poor layout, or whether the interaction model is wrong. Those judgments require human review.

## Design review (required)

- Reviewer: Cinder maintainers
- Review outcome: Pending. The design-reviewer verdict has not been recorded yet.
- Nearest neighbours: Statistic, StatisticGroup, StatusDot.
- Why this component exists: A screen reads best with one focal value. Statistic is a labelled tile in a grid, so nothing on a screen is the first thing to read. Spotlight is that one value at display size, in neutral text.
- Findings and resolutions: The value uses the default text colour, never the accent, which is reserved for actions. Liveness is a status dot with a word, never colour alone. A caveat directly under the value shows staleness in warning text.

## Novel interaction accessibility review

A novel interaction model includes a new disclosure or keyboard pattern, entering or leaving the top layer, or making previously static content interactive.

- Applies: No—Spotlight is static and non-interactive.
- Reviewer: Not applicable.
- Review outcome: Pending. The design-reviewer verdict has not been recorded yet.

### Focus management

Not applicable; Spotlight is not focusable or interactive.

### Keyboard matrix

| Key or gesture | Context          | Expected behavior        |
| -------------- | ---------------- | ------------------------ |
| None           | Static component | No keyboard interaction. |

### Assistive-technology announcements

The value and caveat are plain paragraphs read in order, with the status word first when there is one. Spotlight is not a live region: when the value changes, announce it in the surrounding page.

## Forced colors

Text uses system colours; the status dot follows StatusDot's forced-colors rules.
