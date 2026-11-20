# Markdown design and accessibility review

Complete this record before merge. Automated checks can detect malformed APIs, missing semantics, and structural regressions. They cannot decide that a component is drab, bulbous, ugly, has a poor layout, or whether the interaction model is wrong. Those judgments require human review.

## Design review (required)

- Reviewer: Cinder maintainers
- Review outcome: Pending. The design-reviewer verdict has not been recorded yet.
- Nearest neighbours: CodeBlock, CopyableValue.
- Why this component exists: Chat and Interborough each rendered Markdown, one with a complete streaming renderer and one with a bare `{@html}`. The renderer lives in the design system so every surface shows code, tables, links and images the same way.
- Findings and resolutions: The component moved from Chat unchanged in behaviour, so its look is the look Chat already shipped. Each block's wrapper carries `data-cinder-markdown-node` and no layout of its own; a host that wants wide blocks styles that attribute.

## Novel interaction accessibility review

A novel interaction model includes a new disclosure or keyboard pattern, entering or leaving the top layer, or making previously static content interactive.

- Applies: No. Prose is static text. Code blocks use CodeBlock's copy control, and a table that overflows becomes one focusable scroll region.
- Reviewer: Not applicable.
- Review outcome: Pending. The design-reviewer verdict has not been recorded yet.

### Focus management

Not applicable. Nothing moves focus. Rendering replaces the DOM nodes, which collapses a text selection made before the render lands, so a caller that selects text waits for `data-state="rendered"`.

### Keyboard matrix

| Key or gesture | Context | Expected behavior |
| --- | --- | --- |
| Tab | Table wider than its place | Moves focus to the scroll region, which is named "Scrollable table". |
| Arrow keys | Focused scroll region | Scroll the table along its inline axis. |
| Tab, Enter, Space | Code block's copy control | Reach and activate CodeBlock's control, as a native button does. |

### Assistive-technology announcements

The formatted content reads as ordinary headings, paragraphs, lists and links. A table that overflows names its scroll region and describes it with a count of the hidden columns. A table that fits adds no landmark and no tab stop.

## Touch targets

The copy control keeps CodeBlock's hit region. Links are the renderer's plain anchors and keep the page's own link sizing.

## Forced colors

Prose uses system colours. The table's focus ring is an outline in forced-colors mode, and its fade is hidden.
