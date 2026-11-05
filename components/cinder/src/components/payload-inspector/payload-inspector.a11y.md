# PayloadInspector · accessibility

## Pattern

A named, read-only data card. The root is a `<div role="group">` — not a landmark — so a dashboard rendering many inspectors adds nothing to the screen-reader landmark list. The `label` (or "Payload" when none is given) names it. The header holds the Fields / JSON switch (a `SegmentedControl` radio group), the count and size, and a native `CopyButton`. The Fields view is a description list or, for one payload, a table; the JSON view is cinder's `JsonViewer` (a WAI-ARIA tree composite).

## Roles names states

- The copy button's accessible name incorporates the label (e.g. "Copy Input"), or reads "Copy text" for text that is not valid JSON, so the action is unambiguous when several inspectors share a page. It stays in place but disabled while a payload streams or after a failed load.
- The copy confirmation (a check and the word "Copied", for two seconds) is announced by the button's own polite live region, not by moving focus and not by a toast.
- The Fields / JSON switch is a `SegmentedControl` radio group named "<label> view". It shows disabled, not hidden, for text that is not valid JSON, and is absent when there is nothing to switch (no payload, a failed load, a payload over the size limit).
- The Fields view is a `<dl>`: each property label is a `<dt>`, its value a `<dd>`. A nested value is a block whose label is a button with `aria-expanded` (in a tree) or plain text; its content sits in the `<dd>`. An array of objects that share keys is a real `<table>` whose caption names it ("Parts, 3 items") and whose scroll box is focusable; one that does not is a set of blocks headed "Item 1 of 3".
- A key too long for its column is a focusable label (`tabindex="0"`) carrying a tooltip with the whole key and its length, so the full key is reachable by keyboard.
- A hidden value shows bullets that are `aria-hidden` and the word "Hidden", so the screen reader hears "Hidden" and never the value.
- Text clamped to two lines has a Show all / Show less button with `aria-expanded` and `aria-controls`.
- A payload still arriving shows "Receiving…" through `InlineLoading`, which announces it politely.
- A failed load is announced immediately (`role="alert"`). The invalid-JSON warning is plain text with a decorative icon.
- The JSON tree from `JsonViewer` carries `role="tree"` with `treeitem` nodes, `aria-expanded`, and level/position attributes.

## Keyboard

| Key | Action |
| --- | --- |
| Tab | Move focus to the view switch, the copy button, then into the Fields view (disclosure buttons, Show all, Load more, long keys, the table scroll box) or the JSON tree |
| Arrow keys (switch) | Move between Fields and JSON |
| Enter/Space (disclosure) | Open or close a nested value |
| Arrow keys (tree) | Navigate and expand/collapse nodes per the `JsonViewer` pattern |
| Enter/Space (tree) | Toggle the focused expandable node |

## Mouse / pointer

Clicking the copy button copies the payload to the clipboard. Download JSON saves a payload that is over the size limit as a file.

## Hard scope caps

- Search, filtering, and virtualization are not in scope. A payload over `maxBytes` (1 MB by default) is not rendered at all; a table shows eight rows and loads more on request; a list shows its first hundred entries.
- Payload text never enters a syntax-highlighting call chain; primitives and unparseable strings render as escaped plain text.
- Secrets are hidden only where the payload parses. Text that is not valid JSON is shown as written, because nothing in it can be told apart.
- The inspector does not annotate individual JSON keys or values with ARIA descriptions. Consumers who need richer key-level semantics should compose a custom viewer.
