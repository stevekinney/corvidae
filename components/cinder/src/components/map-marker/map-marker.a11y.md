# MapMarker design and accessibility review

Complete this record before merge. Automated checks can detect malformed APIs, missing semantics, and structural regressions. They cannot decide that a component is drab, bulbous, ugly, has a poor layout, or whether the interaction model is wrong. Those judgments require human review.

## Design review (required)

- Reviewer: Cinder maintainers
- Review outcome: Pending. The design-reviewer verdict has not been recorded yet.
- Nearest neighbours: Badge, StatusDot, FloatingAction.
- Why this component exists: Hand-built map pins were 24px floating pills with no anchor, and live against not-live was carried by colour alone.
- Findings and resolutions: The pin has a 10px rotated-square anchor. Idle shows its start time, live is a filled pill with a dot, selected is raised with a ring, and a cluster is a round count. The button is at least 44px.

## Novel interaction accessibility review

A novel interaction model includes a new disclosure or keyboard pattern, entering or leaving the top layer, or making previously static content interactive.

- Applies: No—the marker is a native button; a selected marker is a toggle with `aria-pressed`.
- Reviewer: Not applicable.
- Review outcome: Pending. The design-reviewer verdict has not been recorded yet.

### Focus management

The marker is one tab stop in document order. Focus draws a ring around the pill.

### Keyboard matrix

| Key or gesture | Context | Expected behavior                 |
| -------------- | ------- | --------------------------------- |
| Tab            | Marker  | Moves focus to the marker.        |
| Enter, Space   | Marker  | Activates it, as any button does. |

### Assistive-technology announcements

The marker reads its `name`, or its label followed by a hidden state word ("live", "selected", "cluster"). A selected marker reads as pressed. The glyph and the tail are hidden.

## Forced colors

Edges use `CanvasText`, and a selected marker draws a `Highlight` outline in place of its ring.
