# JsonDiffViewer design and accessibility review

Complete this record before merge. Automated checks can detect malformed APIs, missing semantics, and structural regressions. They cannot decide that a component is drab, bulbous, ugly, has a poor layout, or whether the interaction model is wrong. Those judgments require human review.

## Design review (required)

- Reviewer: Cinder maintainers
- Review outcome: Pending. The design-reviewer verdict has not been recorded yet.
- Nearest neighbours: JsonViewer, SourceDiffViewer.
- Why this component exists: JsonViewer shows one value and SourceDiffViewer diffs text, so neither answers which key or index of two JSON values changed. Run comparison needs that answer, and the panel and the page share one component.
- Findings and resolutions: Each row leads with a symbol (`+`, `-`, `~`, `=`) beside its tint, and a changed entry reads `before → after` on one line. A value that changes type is a removed row and an added row, never a change.

## Novel interaction accessibility review

A novel interaction model includes a new disclosure or keyboard pattern, entering or leaving the top layer, or making previously static content interactive.

- Applies: Yes. Each level holds disclosure buttons: one that reveals its unchanged entries, and one that shows more entries past the first 200.
- Reviewer: Cinder maintainers
- Review outcome: Pending. The design-reviewer verdict has not been recorded yet.

### Focus management

Nothing moves focus. The controls are native buttons that keep focus when activated. Revealing entries adds rows after the control's own row, so the control stays where it was. A control that has nothing left to reveal leaves the document; the unchanged control never does, because it toggles.

### Keyboard matrix

| Key or gesture | Context | Expected behavior |
| --- | --- | --- |
| Tab | The comparison | Moves between the controls in reading order; rows are not focus stops. |
| Enter, Space | Unchanged-entries control | Toggles the unchanged entries of that level, and updates `aria-expanded`. |
| Enter, Space | Show-more control | Reveals the next 200 entries of that level; its name also gives how many are not shown. |
| Enter, Space | Nested-changes control | Opens or closes a nested level the render budget closed, and updates `aria-expanded`. |

### Assistive-technology announcements

The comparison is a named group (`label`, "JSON differences" by default) holding nested lists, so a screen reader announces each level's item count. Each row's first child is an image named "Added", "Removed", "Changed" or "Unchanged", so the kind is spoken as well as drawn. Identical values render Cinder's `EmptyState` (`kind="done"`, with its defaults, as the component now has one layout) titled "No differences", the same words `DiffStatistics` uses for no change. The unchanged control reports `aria-expanded`, and its text names how many entries it holds. The changes paging control reads "Show 200 changes", the row's own words, and names the level's remaining total in its accessible name ("Show 200 changes, 450 not shown"), so the total is not a second visible count. The unchanged entries' paging control reads "Show 200 more" and is named "Show 200 more unchanged entries, 250 not shown".

## Touch targets

Every control is Cinder's `Button` in the `link` variant at the `xs` size, so on a coarse pointer each carries Button's 44px hit region (`data-cinder-hit-target="44"`, a pseudo-element that takes no layout). Button lets a hit region overlap what is around it invisibly, so the viewer adds room only where it would take another control's taps: on a coarse pointer, between two stacked controls (a control's item, or a row that holds one), the second gains a block-start margin of twice `--cinder-space-3`. A lone control, and a tinted row beside plain rows, keep their own height. The label stays on one line, starting at the inline start.

## Forced colors

Tints do not survive forced colors, so each added, removed or changed row gains a two-pixel inline-start rule in `CanvasText`. The symbol and its name still carry the kind. Control focus draws as an outline in `ButtonText`.
