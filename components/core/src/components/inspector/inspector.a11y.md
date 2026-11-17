# Inspector design and accessibility review

Complete this record before merge. Automated checks can detect malformed APIs, missing semantics, and structural regressions. They cannot decide that a component is drab, bulbous, ugly, has a poor layout, or whether the interaction model is wrong. Those judgments require human review.

## Design review (required)

- Reviewer: Cinder maintainers
- Review outcome: Pending. The design-reviewer verdict has not been recorded yet.
- Nearest neighbours: DescriptionList, SettingRow, GroupedList.
- Why this component exists: Detail pages showed properties as stacks of always-editable fields or as gray label grids. An inspector shows them as quiet rows that become editable on activation.
- Findings and resolutions: The group is a description list, so each label is the term of its value. A header names the group. The rail and the phone layout share one markup: the tint and the stacked label change below 700px, and no second component is needed.

## Novel interaction accessibility review

A novel interaction model includes a new disclosure or keyboard pattern, entering or leaving the top layer, or making previously static content interactive.

- Applies: No. The group itself is static; the interaction belongs to each InspectorRow, which carries its own review record.
- Reviewer: Not applicable.
- Review outcome: Pending. The design-reviewer verdict has not been recorded yet.

### Focus management

Not applicable; only the rows' controls are focusable, in document order.

### Keyboard matrix

| Key or gesture | Context | Expected behavior                               |
| -------------- | ------- | ----------------------------------------------- |
| Tab            | Row     | Moves focus to the next editable row's control. |

### Assistive-technology announcements

With a `header`, the group is announced as a named group. Each row is a term and a definition in a description list.

## Forced colors

The group draws a border in system colours, because its tint is not drawn.
