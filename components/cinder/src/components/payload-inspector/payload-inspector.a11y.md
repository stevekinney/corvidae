# PayloadInspector · accessibility

## Pattern

Labeled read-only data panel. The root is a plain `<div>` — not a landmark — so a dashboard rendering many inspectors adds nothing to the screen-reader landmark list. The visible heading-row label names the panel, the Fields view is a description list, the JSON view is cinder's `JsonViewer` (a WAI-ARIA tree composite), and the copy action is a native `CopyButton`.

## Roles names states

- The header label is visible text; the copy button's accessible name incorporates it (e.g. "Copy Arguments") so the action is unambiguous when several inspectors share a page.
- The byte size `<span>` carries an `aria-label` (e.g. "13 B payload size") so screen readers have context without relying on visual proximity.
- The Fields / JSON switch is a `SegmentedControl` radio group named "<label> view"; it renders only for an object or array payload. The Fields view is a `<dl>`: each property label is a `<dt>`, its value a `<dd>`, and a nested object or array is a `<dl>` inside the `<dd>`.
- The JSON tree from `JsonViewer` carries `role="tree"` with `treeitem` nodes, `aria-expanded`, and level/position attributes.
- Parse error notices carry `role="alert"` — announced immediately when parsing fails. The raw string renders below the alert so the reader can see what failed.
- Empty-state placeholders carry `role="status"` — announced politely.
- The copy button from `CopyButton` carries its own `aria-live="polite"` announcement for the "Copied" confirmation state.

## Keyboard

| Key | Action |
| --- | --- |
| Tab | Move focus to the view switch, the copy button, then into the JSON tree (JSON view) |
| Arrow keys (switch) | Move between Fields and JSON |
| Arrow keys (tree) | Navigate and expand/collapse nodes per the `JsonViewer` pattern |
| Enter/Space (tree) | Toggle the focused expandable node |

## Mouse / pointer

Clicking the copy button copies the payload to the clipboard and briefly announces the confirmation state.

## Hard scope caps

- Search, filtering, and virtualization over the JSON tree are not in scope. The built-in `JsonViewer` has a hard byte cap (default 1 MB) after which it shows an oversize placeholder.
- Payload text never enters a syntax-highlighting call chain; primitives and unparseable strings render as escaped plain text.
- The inspector does not annotate individual JSON keys or values with ARIA descriptions. Consumers who need richer key-level semantics should compose a custom viewer.
