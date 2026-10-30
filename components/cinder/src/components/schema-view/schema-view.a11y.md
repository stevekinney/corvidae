# SchemaView · accessibility

## Pattern

SchemaView is a labelled `region` that holds nested lists, one list item per field, followed by a disclosure for the raw document. Lists and list items are native, so a screen reader announces the count of fields and how deep a nested object sits.

Purpose: Read-only view of a JSON Schema: one line per field with a label, a red dot when required, a monospace type and a description, nested objects indented, and a disclosure for the raw document.

## Use when

- Showing the shape of a workflow input or output, a tool input, or a signal or update payload without a raw JSON dump.
- Telling the reader which fields are required and what type each one takes.

## Avoid when

- The schema must be edited — use json-schema-editor instead.
- You are showing a value rather than the shape it must have — use payload-inspector instead.

## Keyboard and focus

The only interactive element is the _View JSON Schema_ disclosure, a native button reachable with Tab and activated with Enter or Space. When it is open, the raw document is a `JsonViewer` tree with its own arrow-key navigation. SchemaView never moves focus.

## Names, roles, and state

The region takes its name from `label`, so name what the schema describes ("Refund input"), not the word "schema". A required field is marked by a dot that is exposed as an image named "Required", so the requirement is announced and never carried by colour alone. The disclosure button reports `aria-expanded`, and `aria-controls` points at the raw document while it is open.

The type is plain text in a `code` element, for example `string`, `array of number` or `string | null`.

## Verification

- Render SchemaView with required and optional fields and confirm a screen reader announces "Required" after each required label.
- Tab to _View JSON Schema_, open it with Enter and Space, and confirm the document appears.
- Check the contrast of the description, type and label in light and dark themes, and that the dot is visible in forced-colors mode.

Related components: `json-schema-editor`, `payload-inspector`, `json-viewer`, `description-list`.
