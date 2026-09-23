# DataGrid · accessibility

## Pattern

DataGrid presents structured data. Preserve the component's semantic roles, row or item labels, and ordering so assistive technology can announce the same relationships that are visible on screen.

Purpose: ARIA data grid foundation for spreadsheet-like datasets with explicit row identity, column sizing, keyboard navigation, range selection, and pinning metadata.

## Use when

- Rendering interactive tabular data that will need grid behavior such as selection, virtualization, resizing, or editing.
- You need role=grid semantics instead of native table semantics.

## Avoid when

- You only need a semantic read-only table — use DataTable or the Table family instead.
- You need resize handles or drag-to-reorder controls — DataGrid does not provide them yet.

## Keyboard and focus

The grid owns the root tab stop and moves the active cell with keyboard commands. Do not put body cells directly in the tab order unless the component documents that behavior.

Keep focus indicators visible. If you wrap or restyle DataGrid, verify the focused element remains visually apparent in default and forced-colors modes.

## Editing

Only columns marked `editable: true` accept edit mode. DataGrid renders its own Input in place of the read-only value while a cell is editing, so the edit surface always carries the same text-field semantics as every other Cinder Input.

| Key | While focused, not editing | While editing |
| --- | --- | --- |
| `Enter` | Enters edit mode on an editable cell. | Commits the draft and moves the active cell to the same column in the next row. |
| Double-click | Enters edit mode on an editable cell. | — |
| A single printable character (no Ctrl/Meta/Alt) | Enters edit mode with that character as the initial draft. | Ordinary text input — reaches the Input's cursor. |
| `Escape` | Existing behavior (collapses selection to the active cell). | Cancels: restores the original value without calling `onCellEdit`. |
| `Tab` / `Shift+Tab` | Existing grid cell-to-cell navigation. | Commits and moves to the next cell (`Shift+Tab` moves to the previous cell). |
| Arrow keys, `Home`, `End`, `PageUp`, `PageDown` | Existing grid navigation. | Not intercepted by the grid — they reach the Input's text cursor. |
| Blurring the Input (e.g. clicking elsewhere) | — | Commits. |

Focus management: entering edit mode moves real DOM focus into the Input. Committing (Enter, Tab) or canceling (Escape) moves real DOM focus back to the grid root, which keeps `aria-activedescendant` pointing at the resulting active cell — the same focus model the grid already uses for click- and arrow-driven navigation. A blur-triggered commit (clicking elsewhere) does not force focus back into the grid, since focus has already moved to wherever the user clicked.

Editing identity is tracked by stable row key plus column key, not by visual row or column index, so a sort or a virtualization re-render while a cell is being edited does not lose or relocate the edit. If the edited row or column is removed from the grid (filtered out, deleted, or hidden) the edit is canceled automatically.

A column that supplies a custom `cell` snippet keeps using that snippet while editing — it receives `editing: true` in its `DataGridCellContext` and is responsible for its own edit UI (built from Cinder's own Input, not a bespoke `<input>`) if it wants one.

## Row headers

Set `rowHeader: true` on the column that identifies each row. Body cells in that column render with `role="rowheader"` instead of `role="gridcell"`, while still preserving `aria-colindex`, selection state, and active-cell behavior.

Use the same row identity users see on screen whenever possible. A first pinned identifier column is a good default because screen readers can announce the row context before the remaining grid cells.

## Virtualized columns

Column virtualization keeps off-screen columns out of the DOM. The grid preserves `aria-colindex` for the full column set and adds edge shadows plus a stable scrollbar gutter so sighted users have a visible horizontal-overflow cue and the vertical scrollbar does not cover the last visible column.

## Names, roles, and state

Use the public props and documented examples to provide accessible names, descriptions, current state, disabled state, selection state, or value text. Do not rely on color, icon shape, placeholder text, or layout position as the only way to communicate meaning.

When DataGrid accepts snippets or arbitrary children, the caller owns the semantics inside those children. Prefer native elements first, and add ARIA only when it matches the rendered behavior.

## Verification

- Render DataGrid in the playground or a focused test fixture.
- Navigate the component with keyboard only.
- Inspect the accessible name, role, and state in browser accessibility tools.
- Check forced-colors mode when the component adds borders, focus rings, selected state, or status color.

Related components: `data-table`, `table`.
