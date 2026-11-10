# KeyFacts design and accessibility review

Complete this record before merge. Automated checks can detect malformed APIs, missing semantics, and structural regressions. They cannot decide that a component is drab, bulbous, ugly, has a poor layout, or whether the interaction model is wrong. Those judgments require human review.

## Design review (required)

- Reviewer: Cinder maintainers
- Review outcome: Final review complete—approved.
- Nearest neighbours: DescriptionList, StackedListItem meta line, Badge.
- Why this component exists: A line of facts joined by a separator glyph breaks mid-fact when it wraps and reads as one run of text. Typed facts with an icon and a value, separated by space, wrap only between facts.
- Findings and resolutions: Colour never carries meaning: the icon is decorative and each fact can carry a hidden kind label. A long value is cut with an ellipsis instead of breaking inside the fact.

## Novel interaction accessibility review

A novel interaction model includes a new disclosure or keyboard pattern, entering or leaving the top layer, or making previously static content interactive.

- Applies: No—the row is a static list; a linked value is an ordinary link.
- Reviewer: Not applicable.
- Review outcome: No novel interaction review required.

### Focus management

Not applicable; only a linked value is focusable, in document order.

### Keyboard matrix

| Key or gesture | Context      | Expected behavior                   |
| -------------- | ------------ | ----------------------------------- |
| Tab            | Linked value | Moves focus to the link.            |
| Enter          | Linked value | Follows the link, as any link does. |

### Assistive-technology announcements

The row is a list. Each fact reads its optional kind label ("Neighborhood:") and then its value. The icon is hidden. The row is not a live region.

## Forced colors

Text and links use system colours; the row carries no information in colour.
