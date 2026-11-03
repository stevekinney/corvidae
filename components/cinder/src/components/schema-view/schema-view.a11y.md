# SchemaView · accessibility

## Pattern

SchemaView is a labelled `region` that holds one `table` with the columns Field, Type and Description, followed by a disclosure for the raw document. Every field is a row, nested fields included, so the three columns line up and a screen reader announces the column header of each cell. A nested row's label is preceded by its parents' labels in text only a screen reader reads, for example "Steps › Name", because the indent is visual.

Purpose: Read-only view of a JSON Schema as one aligned grid of Field, Type and Description: required fields first with a red dot, nested fields indented, plain-word types, a raw-document disclosure.

## Use when

- Showing the shape of a workflow input or output, a tool input, or a signal or update payload without a raw JSON dump.
- Telling the reader which fields are required and what type each one takes.

## Avoid when

- The schema must be edited — use json-schema-editor instead.
- You are showing a value rather than the shape it must have — use payload-inspector instead.

## Keyboard and focus

The interactive elements are the _More_ and _Less_ buttons beside a description and the _JSON schema_ disclosure, all native buttons reachable with Tab and activated with Enter or Space. When the disclosure is open, the raw document is a `JsonViewer` tree with its own arrow-key navigation. SchemaView never moves focus.

## Names, roles, and state

The region takes its name from `label`, so name what the schema describes ("Refund input"), not the word "schema". A required field is marked by a dot that is exposed as an image named "Required", so the requirement is announced and never carried by colour alone. The disclosure button reports `aria-expanded`, and `aria-controls` points at the raw document while it is open. A _More_ button reports `aria-expanded`, points `aria-controls` at the description it extends, and carries the name "More about Steps" (or "Less about Steps"), so a list of buttons is not a list of identical "More"s. The text is revealed in place, in the same cell.

The type is plain words in text, for example `text`, `yes or no`, `list of steps` or `one of: email, slack`. A long label truncates visually and carries its whole text as a tooltip and in the accessibility tree.

## Verification

- Render SchemaView with required and optional fields and confirm a screen reader announces "Required" after each required label.
- Tab to _More_ beside a description, open it with Enter and Space, and confirm the extra text reads in place and the button turns into _Less_.
- Tab to _JSON schema_, open it with Enter and Space, and confirm the document appears.
- Narrow the view below 30rem and confirm the label and type stay on one line with the description below.
- Check the contrast of the description, type and label in light and dark themes, and that the dot is visible in forced-colors mode.

Related components: `json-schema-editor`, `payload-inspector`, `json-viewer`, `description-list`.
