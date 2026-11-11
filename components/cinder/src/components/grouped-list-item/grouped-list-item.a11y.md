# GroupedListItem design and accessibility review

Complete this record before merge. Automated checks can detect malformed APIs, missing semantics, and structural regressions. They cannot decide that a component is drab, bulbous, ugly, has a poor layout, or whether the interaction model is wrong. Those judgments require human review.

## Design review (required)

- Reviewer: Cinder maintainers
- Review outcome: Pending. The design-reviewer verdict has not been recorded yet.
- Nearest neighbours: StackedListItem, SettingRow, Avatar.
- Why this component exists: Rows need leading, title, subtitle and trailing slots with aligned columns and a single link target, without a border per row.
- Findings and resolutions: The row is one link through a stretched pseudo-element, so there is one tab stop per row; the trailing and action columns sit above it. The chevron is decorative.

## Novel interaction accessibility review

A novel interaction model includes a new disclosure or keyboard pattern, entering or leaving the top layer, or making previously static content interactive.

- Applies: No—a linked row is an ordinary link; an action is an ordinary button.
- Reviewer: Not applicable.
- Review outcome: Pending. The design-reviewer verdict has not been recorded yet.

### Focus management

Not applicable; the link and any action are focusable in document order, and the focus ring wraps the whole row.

### Keyboard matrix

| Key or gesture | Context  | Expected behavior                                |
| -------------- | -------- | ------------------------------------------------ |
| Tab            | Row link | Moves focus to the link; the ring wraps the row. |
| Enter          | Row link | Follows the link.                                |

### Assistive-technology announcements

A selected row without a link carries aria-current. A linked row is announced as a link with its title text.

## Forced colors

The focus ring and the selected outline use system colours.
