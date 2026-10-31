# SchemaForm

Render an accessible form from a JSON Schema object and submit one validated value.

## Usage

```svelte
<script lang="ts">
  import { SchemaForm, readSchemaFormData } from '@lostgradient/cinder';

  const schema = {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1 },
      count: { type: 'integer', minimum: 1 },
    },
    required: ['name', 'count'],
  };

  function save(value: unknown) {
    // Called only after validation passes.
  }

  function mirrorDraft(value: unknown) {
    // Called after every edit, even when the value is not schema-valid yet.
  }
</script>

<SchemaForm {schema} name="payload" onDraftChange={mirrorDraft} onSubmit={save} />
```

`SchemaForm` always renders a real `<form>` and a hidden serialized output field. After valid submission, `readSchemaFormData(new FormData(form), 'payload')` returns the same object delivered to `onSubmit`.

The three value channels have distinct ownership. `value` seeds internal state on mount and is not a live binding, so later `value` changes do not discard active edits. `onDraftChange` reports the complete current draft after each edit, before schema validation, so consumers can mirror nested or temporarily invalid values. In-progress numeric editors and temporarily unparseable JSON fields are reported as their current raw text until the value commits or parses successfully. `onSubmit` reports only schema-valid output after submission.

Pass `issues` to show problems the host found with a submitted value, such as a server-side refusal: each `{ path, message }` appears on the field its `path` names (property names and array indexes; `[]` is the whole value) like a built-in validation message, and editing the field clears it. A string with `writeOnly: true` is a password field. A path that names no field shows on the form itself. A summary of a closed group prints a `writeOnly` or `x-secret` value as `••••`, and a form whose schema has such a field offers no Edit as JSON panel, since the panel prints the whole value. An optional `date`, `time` or `date-time` field left blank (or cleared) is omitted from the value instead of sent as an empty string, which no RFC 3339 check accepts.

## Control shapes

Each shape below has exactly one schema rule. A schema that does not match a rule keeps the rendering it had before (a generic array editor, an object group, or the raw JSON textarea), so a rule never guesses.

| Schema | Control |
| --- | --- |
| `type: "array"` with `items.enum` listing primitives | Toggle chips, one per option. The value keeps the chosen options in schema order and leaves any value the schema does not list alone. |
| `type: "array"` with `items.type: "string"` and no `items.enum` | A tag input. Repeated tags are allowed unless the array sets `uniqueItems: true`, and a pending draft is committed on submit. |
| `type: "object"` with no `properties` and `additionalProperties: { "type": "string" }` | A key/value row list. A row with a value but no key, or two rows with one key, blocks submission with a message. |
| `oneOf` of exactly two branches: one primitive (`const`, `enum`, or a `string`, `number`, `integer` or `boolean` type) and one `type: "object"` with `properties` | A segmented choice, then the fields of the chosen branch. The branch is read from the value (an object is the object branch), never stored, and switching starts the new branch from its defaults. |
| A `number` or `integer` with `format: "duration-ms"`, or whose property name ends in `Ms`, `_ms`, `Milliseconds` or `_milliseconds` | A number plus a unit (ms, s, min, h). The value is always stored in milliseconds; the unit only changes how the number is shown. Like every numeric editor, text typed but not yet committed is reported and validated as typed, never converted. |

A `oneOf` with two primitives, with an object branch that has no `properties`, or with more than two branches stays raw JSON. An object that declares `properties`, or whose `additionalProperties` is anything other than `{ "type": "string" }`, is not a record.

## Large schemas

A form with more than eight fields (an object group counts as the fields inside it, and an array, record or choice counts as one) is large. Large forms add:

- Required fields first, then optional ones, each in schema order, in every object.
- Two columns for short fields (strings, numbers, booleans, selects, durations). Arrays, groups, chips, tags, records, choices and raw JSON take the whole row. The grid falls back to one column when the container is narrow.
- Nested objects as collapsible groups. A required group starts open and an optional one closed. A closed group summarizes what is inside it: the values that differ from their defaults (`Damaged · whole order`), or else the first field names with `none set` or, when the schema supplies defaults, `defaults` (`Carrier, Tracking Number… · none set`). Groups come only from nested objects in the schema, never from guessing at field names.
- A Find a field filter that matches labels, keys and descriptions, and opens the groups that hold a match.
- Edit as JSON, a panel for pasting a whole input. Apply parses the text, requires an object when the schema is an object, fills in defaults for missing fields, and replaces every field and draft. Pass `jsonEditable={false}` when the host already offers its own JSON entry point for the payload.

A failed submit clears the filter and opens every group that holds an error, so focus always has a field to land on.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Custom class merged with `.cinder-schema-form`. |
| `jsonEditable` | `boolean` | no | — | Whether a large form offers its own Edit as JSON panel. Defaults to `true`; set `false` when the host already provides a JSON entry point for the same payload, so the page does not show two. Find a field and the other large-form affordances are unaffected. |
| `name` | `string` | no | — | Name of the hidden serialized output field. Defaults to `value`. |
| `submitLabel` | `string` | no | — | Label for the built-in submit button. Defaults to `Submit`. |
| `issues` | `(opaque)` | no | — | Problems the host found with a value this form submitted, such as a server-side validation refusal. Each one is shown on the field its `path` names, as a built-in validation message is, and cleared when that field is edited. Pass a new array to show a new set. Not expressible in JSON Schema; see the component types for the signature. |
| `onDraftChange` | `(opaque)` | no | — | Called after each edit with the complete current draft, before schema validation. The draft can be schema-invalid and does not change the seed-only `value` contract. In-progress numeric editors and temporarily unparseable JSON fields are reported as their current raw text until the value commits or parses successfully. Not expressible in JSON Schema; see the component types for the signature. |
| `onSubmit` | `(opaque)` | no | — | Called after validation passes with the schema-conformant output value. Not expressible in JSON Schema; see the component types for the signature. |
| `schema` | `(opaque)` | yes | — | JSON Schema object used to render and validate the form. Not expressible in JSON Schema; see the component types for the signature. |
| `value` | `(opaque)` | no | — | Initial form value. Missing fields are seeded from the schema where possible. **Seed-only — value changes do not reset form state.** After mount the consumer owns the form state. Changing `value` with the same `schema` does NOT reset the form (formValue, errors, rawDrafts). Only changing `schema` causes a remount and resets form state. This is intentional: the form is an editing surface and resetting it on every external value change would silently discard in-progress user edits. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
