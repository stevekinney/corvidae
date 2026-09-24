# DiffViewer · accessibility

## Pattern

DiffViewer packages a higher-level workflow. Confirm the composed controls, labels, states, and keyboard path match the domain task instead of treating the visual shell as the accessibility contract.

Purpose: Side-by-side or unified Markdown diff surface with hunk grouping, word-level inline changes, and size-based debounce gating.

## Use when

- Comparing two Markdown documents and wanting the bundled toolbar, view-mode toggle, front-matter handling, and large-payload safeguards.
- Building a review workflow that needs hunked, line-anchored Markdown diffs out of the box as a heavyweight suite.

## Avoid when

- Showing only a counts summary — use diff-statistics on its own for a lightweight presentation.
- Diffing non-Markdown source code where syntax-aware highlighting matters more than prose-aware rendering.

## Keyboard and focus

Keyboard behavior follows the rendered native elements and any ARIA pattern documented by the component. Avoid adding handlers that change focus order without a matching visible and programmatic state update.

Keep focus indicators visible. If you wrap or restyle DiffViewer, verify the focused element remains visually apparent in default and forced-colors modes.

`[` and `]` jump to the previous/next change when focus is anywhere inside this `DiffViewer` instance (not global — see the `handleKeydown` comment in `diff-viewer.svelte`). The toolbar's Previous/Next buttons carry that shortcut in their accessible name — `aria-label="Previous change ([)"` / `aria-label="Next change (])"` — rather than describing it through a separate element. The adjacent `Kbd` keycaps are purely visual (`aria-hidden="true"`); they annotate the button they sit next to and do not need their own description.

### Annotation hooks (COR-514)

Without `onAnnotationSelectionChange`, annotation is off and rendering is unchanged. Supplying it turns on one native `<button>` add-comment control per commentable row/side, each a real focus stop in source order — a `same` (unchanged) row exposes both an old- and a new-side control; a `modified` row exposes independent old- and new-side controls with distinct text; an `added`/`removed` row exposes only the side it exists on. On a focused control:

- **Enter** starts a selection at that row, or — while a selection is pending — commits it and calls `onAnnotationSelectionChange` with the final range.
- **Shift+ArrowDown** / **Shift+ArrowUp** extend the pending selection one row at a time on the same side, moving focus to the new endpoint's control.
- **Escape** cancels a pending selection without committing it and returns focus to the control where the selection started.

Shift-clicking a second control extends from the last selection origin and commits immediately. An attempted extension to the other side, or past the top/bottom of the document, is rejected without moving the origin; the reason is announced through a `role="status"` region rendered above the diff content (present whenever annotation hooks are supplied). While the diff is stale (large-document debounced/manual tiers awaiting recomputation), every add-comment control is disabled with a visible explanation next to it and in that same status region — saved comments rendered through `lineAnnotation`/`fileAnnotation` remain visible throughout.

Front matter is always "ambiguous" for line-level anchoring, so it offers a file-level comment hook (`fileAnnotation`) instead of per-line controls, with the changed field names as context. Unlike `lineAnnotation`, it renders whenever front matter is present, regardless of whether annotation is otherwise enabled.

Each control carries a stable, instance-scoped DOM id, so two `DiffViewer` instances on the same page never collide and never share keyboard state. The `ref` prop's `focusAnchor` method switches `viewMode` as needed to expose the requested side (a `final`-mode viewer switches to `unified` to expose an `old`-side anchor; an `original`-mode viewer switches to `unified` to expose a `new`-side anchor) and then moves focus to that control, returning `{ status: 'unavailable' }` rather than throwing when the target row cannot be found.

## Names, roles, and state

Use the public props and documented examples to provide accessible names, descriptions, current state, disabled state, selection state, or value text. Do not rely on color, icon shape, placeholder text, or layout position as the only way to communicate meaning.

When DiffViewer accepts snippets or arbitrary children, the caller owns the semantics inside those children. Prefer native elements first, and add ARIA only when it matches the rendered behavior.

The toolbar's copy button has the accessible name "Copy unified diff" (`aria-label` on the `Button`). Its result is announced through a `role="status"` live region: "Unified diff copied." on success, "Unable to copy unified diff." on failure. The copy is always a full-document unified diff, independent of the current `viewMode` — see `diff-viewer.svelte`'s `copyUnifiedDiff` and the README's "Copying the diff" section.

Each add-comment control has an accessible name naming its side and line number (e.g. "Add comment on added or unchanged line 4").

## Verification

- Render DiffViewer in the playground or a focused test fixture.
- Navigate the component with keyboard only.
- Inspect the accessible name, role, and state in browser accessibility tools.
- Check forced-colors mode when the component adds borders, focus rings, selected state, or status color.

Related components: `diff-statistics`, `code-block`.
