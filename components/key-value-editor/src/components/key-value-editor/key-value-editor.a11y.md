# KeyValueEditor Accessibility

## Pattern

KeyValueEditor is a compact editor for an ordered list of string key/value pairs. It owns row mutation, stable per-row control ids, and the policy that selected keys render through an editable password `Input`.

Purpose: Edit request headers, environment variables, and other configuration pairs while keeping secret values masked.

## Design review

Nearest neighbours: `Input`, `SecretValueField`, and `DataTable`. DataTable is appropriate for read-only structured data; KeyValueEditor is admitted because it owns pair editing, add/remove behavior, and secret-cell routing that a Table composition does not provide.

Visual outcome: one line per row (key box, value box, and an icon-only Remove control at the inline end, all one height), "Key" and "Value" drawn once as column headings, and an empty last row that adds a pair when typed into. The component composes the existing Input and Button primitives rather than recreating their form and button behavior.

## Keyboard and focus

Rows use `role="list"` and `role="listitem"`; the key and value inputs and the remove Button remain in native document tab order, and the empty last row's two inputs follow the last Remove control. Enter and Space retain native button behavior for Remove. No arrow-key or roving-focus model is introduced, so users can move through fields with Tab and Shift+Tab predictably.

Typing into the empty row adds the pair in place: the input keeps its DOM node and focus, the row gains its Remove control, and a new empty row follows it.

## Names, roles, and state

Each Input has a programmatic label (`Key` or `Value`) and a unique id derived from the editor instance and the row's immutable `id` (not its position), so a row keeps the same control ids — and its focused input keeps its DOM node and focus — when a parent reorders, inserts, or removes other rows. The visible column headings are `aria-hidden`, so they never name an input twice. The empty row's inputs keep the same names and are described by `addLabel` ("Add pair"). Remove Buttons are icon-only and use `removeLabel(key)` as their accessible name, so the action identifies its row. When `secret(key)` returns true, the value Input uses `type="password"` while remaining editable. Consumers should provide meaningful keys for row action labels.

When a parent-driven `entries` update removes the row that currently holds focus, focus moves to the previous row's Remove control, else the next row's Remove control, else the empty row's key input — the same fallback the Remove button already used for user-triggered removal.

## Verification

- Render empty, single-row, and multi-row states in a focused fixture.
- Navigate all controls with keyboard only and verify add/remove actions preserve focus order.
- Inspect labels, list semantics, button names, and masked secret output in browser accessibility tools.
- Check forced-colors mode and narrow layouts for visible focus indicators and usable row controls.

Related components: `input`, `secret-value-field`, `data-table`, `table`.
