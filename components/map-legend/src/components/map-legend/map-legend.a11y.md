# MapLegend design and accessibility review

Complete this record before merge. Automated checks can detect malformed APIs, missing semantics, and structural regressions. They cannot decide that a component is drab, bulbous, ugly, has a poor layout, or whether the interaction model is wrong. Those judgments require human review.

## Design review (required)

- Reviewer: Cinder maintainers
- Review outcome: Pending. The design-reviewer verdict has not been recorded yet.
- Nearest neighbours: DescriptionList, KeyFacts, StatusDot.
- Why this component exists: A map's marker states need a key, and a map built on OpenStreetMap must show its credit; one hand-built map dropped it.
- Findings and resolutions: Each swatch has its marker's shape, so the key does not rely on colour. The attribution is always rendered and defaults to the OpenStreetMap and ODbL credit.

## Novel interaction accessibility review

A novel interaction model includes a new disclosure or keyboard pattern, entering or leaving the top layer, or making previously static content interactive.

- Applies: No—the legend is static; the attribution links are ordinary links.
- Reviewer: Not applicable.
- Review outcome: Pending. The design-reviewer verdict has not been recorded yet.

### Focus management

Not applicable; only the attribution links are focusable, in document order.

### Keyboard matrix

| Key or gesture | Context          | Expected behavior                   |
| -------------- | ---------------- | ----------------------------------- |
| Tab            | Attribution link | Moves focus to the link.            |
| Enter          | Attribution link | Follows the link, as any link does. |

### Assistive-technology announcements

The legend is a named region holding a list of meanings. The swatches are hidden. The attribution is read after the list.

## Forced colors

Swatch edges use `CanvasText`; links use system colours.
