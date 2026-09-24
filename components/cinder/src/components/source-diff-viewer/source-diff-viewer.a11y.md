# SourceDiffViewer · accessibility

## Pattern

SourceDiffViewer presents structured source diff output. Preserve file headers, hunk headers, line-state labels, and source order so assistive technology receives the same relationships that are visible on screen.

Purpose: Lightweight unified-patch viewer for source-code and operational diffs with file headers, hunk headers, line state styling, and bounded rendering.

## Use when

- Rendering source-code unified patches from agent output, Git operations, workspace changes, or review systems.
- Showing operational patch output where file and hunk structure matters more than Markdown front matter or word-level prose review.

## Avoid when

- Comparing two Markdown documents with normalization, front-matter, and revert affordances — use `DiffViewer` from `@lostgradient/editor`.
- Showing syntax-highlighted code samples rather than patch output — use code-block instead.

## Keyboard and focus

Without `onAnnotationSelectionChange`, the component is read-only and keyboard behavior follows the rendered native elements. The diff region has an accessible label through `ariaLabel`; provide a specific label when multiple diff viewers appear on the same page.

Supplying `onAnnotationSelectionChange` turns on one native `<button>` per commentable row/side, each a real focus stop in source order (addition and removal rows expose one control on their own side; context rows expose separate old- and new-side controls). On a focused control:

- **Enter** starts a selection at that row, or — while a selection is pending — commits it and calls `onAnnotationSelectionChange` with the final range.
- **Shift+ArrowDown** / **Shift+ArrowUp** extend the pending selection one row at a time on the same side, moving focus to the new endpoint's control.
- **Escape** cancels a pending selection without committing it and returns focus to the control where the selection started.

Shift-clicking a second control extends from the last selection origin and commits immediately; plain pointer dragging never starts a range. An attempted extension across a file, hunk, or side boundary is rejected without moving the origin, and the reason is announced through an instance-scoped `role="status"` region rendered above the diff (only present when annotation hooks are supplied). Metadata, binary-notice, and fully truncated rows never render a control, so they can never anchor a comment.

Each control and the file header carry stable, instance-scoped DOM ids, so two `SourceDiffViewer` instances on the same page never collide and never share keyboard state — a selection made in one instance has no visible or behavioral effect on another. The `ref` prop's `focusFile`/`focusAnchor` methods move focus programmatically within that same instance only, returning `{ status: 'unavailable' }` rather than throwing when the target row is not currently rendered (pruned by `maxLines`, or hidden by `activeFileOccurrence`).

## Names, roles, and state

Addition and removal rows include visually hidden labels such as "Added line 4" and "Removed line 2" so color is not the only state cue. Line-number gutters are decorative and hidden from assistive technology. Each add-comment control has an accessible name naming its side and line number (e.g. "Add comment on added or unchanged line 4").

When rendering bounded output, the truncation notice uses `role="status"` and includes both the rendered and total diff-line counts. A file selected through `activeFileOccurrence` whose content was entirely cut by `maxLines` still renders its header and an explicit "Lines unavailable at the current display limit." message rather than disappearing silently.

## Verification

- Render SourceDiffViewer in the playground or a focused test fixture.
- Inspect the region label, file labels, hunk labels, and row text in browser accessibility tools.
- Confirm additions and removals remain identifiable without relying on color.
- Check forced-colors mode because additions and removals use status-colored surfaces.
- With `onAnnotationSelectionChange` supplied, verify the full keyboard matrix above with a screen reader: focus reaches every add-comment control, Enter/Shift+Arrow/Escape behave as documented, and a rejected extension is announced once without moving focus away from the target control.

Related components: `diff-statistics`, `code-block`.
