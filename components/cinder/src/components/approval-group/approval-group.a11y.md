# ApprovalGroup design and accessibility review

Complete this record before merge. Automated checks can detect malformed APIs, missing semantics, and structural regressions. They cannot decide that a component is drab, bulbous, ugly, has a poor layout, or whether the interaction model is wrong. Those judgments require human review.

## Design review (required)

- Reviewer: Cinder maintainers, with the `design-reviewer` verdict for board row A3 (COR-2438) pending the capture.
- Review outcome: Built to board row A3; the design-review verdict is recorded on COR-2438.
- Nearest neighbours: GroupedList, ApprovalCard, Section.
- Why this component exists: Two or more approvals waiting together read as one decision batch: "2 approvals waiting" over one bordered group of compact rows. A stack of separately bordered cards reads as unrelated asks and repeats a box per row; GroupedList carries tone and no border and expects GroupedListItem rows, while these rows are ApprovalCards that each stay answerable.
- Findings and resolutions: The group draws the only border; an ApprovalCard in the `row` layout inside it gives up its own border, radius and fill, so no box sits inside another. Rows stand one faint separator apart.

## Novel interaction accessibility review

A novel interaction model includes a new disclosure or keyboard pattern, entering or leaving the top layer, or making previously static content interactive.

- Applies: No. The group is static; every control in it belongs to the ApprovalCards it holds.
- Reviewer: Not applicable.
- Review outcome: No novel interaction review required.

### Focus management

Not applicable; the group is not focusable. Focus moves through the rows' own controls in reading order.

### Keyboard matrix

| Key or gesture | Context      | Expected behavior                                                |
| -------------- | ------------ | ---------------------------------------------------------------- |
| Tab            | Inside group | Moves through each row's controls in order; the group adds none. |

### Assistive-technology announcements

The group is a `section` named by its heading through `aria-labelledby`, so it reads as the region "2 approvals waiting". The heading renders at `headingLevel` (default `3`) to fit the page's outline. Nothing in the group is a live region; each row announces its own state as an ApprovalCard does.

## Forced colors

Under forced colors the group's border and the separators between rows are drawn with `CanvasText`.
