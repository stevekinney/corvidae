# GroupedList design and accessibility review

Complete this record before merge. Automated checks can detect malformed APIs, missing semantics, and structural regressions. They cannot decide that a component is drab, bulbous, ugly, has a poor layout, or whether the interaction model is wrong. Those judgments require human review.

## Design review (required)

- Reviewer: Cinder maintainers
- Review outcome: Pending. The design-reviewer verdict has not been recorded yet.
- Nearest neighbours: DataList, StackedListItem, Card.
- Why this component exists: A stack of boxed cards or a list with a border under every row reads as enterprise furniture. One rounded surface with separators that start at the text groups related rows with tone and space.
- Findings and resolutions: The group is a list, and the optional header names it. The quick-add input has its own accessible name, and its focus ring wraps the whole row.

## Novel interaction accessibility review

A novel interaction model includes a new disclosure or keyboard pattern, entering or leaving the top layer, or making previously static content interactive.

- Applies: No—the group is a static list. The quick-add input is an ordinary text input in a form.
- Reviewer: Not applicable.
- Review outcome: Pending. The design-reviewer verdict has not been recorded yet.

### Focus management

Not applicable; links, row actions and the quick-add input are focusable in document order.

### Keyboard matrix

| Key or gesture | Context | Expected behavior |
| --- | --- | --- |
| Tab | Row link or action | Moves focus to the next link or control. |
| Enter | Row link | Follows the link; the whole row is the target. |
| Enter | Quick-add input | Submits the trimmed text to `onItemAdd` and clears the input. |

### Assistive-technology announcements

The group is a list, named by its header when it has one. The quick-add input is announced by its label.

## Forced colors

The group draws a border in forced-colors mode, a selected row an outline, and separators use system colours.
