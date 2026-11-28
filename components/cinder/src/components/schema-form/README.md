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

`schemaFormInitialDraft(schema, value?, variant?)` returns the draft the form shows at mount (a choice's first option, `false` for a switch, `value` merged over them) for a host that saves a form the person never edited, since `onDraftChange` reports nothing before the first edit. Pass the `variant` the form uses: the `setting-rows` variant starts an optional choice unset.

`schemaFormFieldLabel(key)` returns a property key in words in sentence case, as the `setting-rows` variant labels a property with no `title`: `baseURL` reads "Base URL". A host that names the same field elsewhere uses it so one function names it.

`schemaHoldsConcealedField(schema)` returns whether any schema under `schema`, however deeply nested, is a string marked `writeOnly` or `x-secret` or an array of such strings, and treats a schema nested deeper than 32 levels as concealed. `SchemaForm` uses it to withhold its Edit as JSON panel; a host that offers its own raw JSON editor beside the form applies the same rule.

Pass `issues` to show problems the host found with a submitted value, such as a server-side refusal: each `{ path, message }` appears on the field its `path` names (property names and array indexes; `[]` is the whole value) like a built-in validation message, and editing the field clears it. A string with `writeOnly: true` is a password field. A path that names no field shows on the form itself. A summary of a closed group prints a value as `••••` when its schema, or any schema under it, is `writeOnly` or `x-secret`, and the hidden output field is emptied once `onSubmit` settles, and a form whose schema has such a field offers no Edit as JSON panel, since the panel prints the whole value. An optional `date`, `time` or `date-time` field left blank (or cleared) is omitted from the value instead of sent as an empty string, which no RFC 3339 check accepts.

## Control shapes

Each shape below has exactly one schema rule. A schema that does not match a rule keeps the rendering it had before (a generic array editor, an object group, or the raw JSON textarea), so a rule never guesses.

| Schema | Control |
| --- | --- |
| `type: "array"` with `items.enum` listing primitives | Toggle chips, one per option. The value keeps the chosen options in schema order and leaves any value the schema does not list alone. |
| `type: "array"` with `items.type: "string"` and no `items.enum` | A tag input. Repeated tags are allowed unless the array sets `uniqueItems: true`, and a pending draft is committed on submit. |
| `type: "object"` with no `properties` and `additionalProperties: { "type": "string" }` | A key/value row list. A row with a value but no key, or two rows with one key, blocks submission with a message. |
| `anyOf` or `oneOf` of exactly two branches: one primitive (`const`, `enum`, or a `string`, `number`, `integer` or `boolean` type, so `false` is one) and one `type: "object"` with `properties` | A segmented choice, then the fields of the chosen branch. The branch is read from the value (an object is the object branch), never stored, and switching starts the new branch from its defaults. |
| A `string`, `number`, `integer` or `enum` that is also `null` (`type: ["integer", "null"]`, or an `anyOf` or `oneOf` of the field and `{ "type": "null" }`) | The field's own control, which starts as `null` unless the schema has a `default`, and emptying it (clearing the text or number, or choosing the empty option) sets `null`: a value of its own, never a missing property. An empty number says "Not set" in its placeholder, whatever its description is. A required field is not blocked by an empty control. |
| A `boolean` that is also `null` | Three segments, Not set, Yes and No. Not set is `null`, and it is where the field starts. |
| An object with `properties`, or a list of strings, of options or of numbers, that is also `null` | An object is a Not set and Set choice, with its fields below once it is set; a list is its own control, which says "Not set" in its empty input while it is `null`, with one Clear action once it holds a list. Each starts as `null`, and Not set and Clear set `null`. |
| A `number` or `integer` with `format: "duration-ms"` or `unit: "milliseconds"` (the unit sits on the field's own schema, whatever the field is called), or whose property name ends in `Ms`, `_ms`, `Milliseconds` or `_milliseconds` | A number plus a unit (ms, s, min, h). The value is always stored in milliseconds; the unit only changes how the number is shown. Like every numeric editor, text typed but not yet committed is reported and validated as typed, never converted. |

A choice reads each alternative the way a person says it, and never as a JSON type: its `title`; a literal in words (`keep-all` is "Keep all", `false` beside an object is "Off", `true` is "On"); a short `description`; an object with no title as the nested field's own title, or "Custom" at the root; and "Text", "Number" or "Yes or no" for a free primitive. Every choice control (a union, a yes or no that may be unset, an object that may be unset) sits where its form puts controls: in the control column, on the label line, in a `setting-rows` form (and in a host's own row), and under its label at the leading edge in a plain one. The chosen alternative's fields sit below it with no box around them, and a root choice draws no title of its own. A property with no title is labelled in sentence case ("Keep last"), and a duration without the unit its name ends in (`timeoutMilliseconds` is "Timeout"), because its control shows the unit.

A union with two primitives, with an object branch that has no `properties`, with more than two branches, or that holds both an `anyOf` and a `oneOf`, stays raw JSON, and so does a nullable shape no control above can edit honestly (a list of objects, a record, a union that is also `null`): it starts as `null` in the same JSON editor every raw field uses, in every variant, where `null` is typed and any value is checked against the schema. An object that declares `properties`, or whose `additionalProperties` is anything other than `{ "type": "string" }`, is not a record.

The form validates the schema it was given, never a rewrite of it, so the keyword decides what is valid: a value that matches both branches of an `anyOf` is valid and the same value under a `oneOf` is not, and `null`, `false` and a missing property are three different values. A host passes the schema its library published, an `anyOf` from Zod included, and changes none of it. `rootChoiceVisible={false}` leaves out the segmented control of a schema that is itself such a union, for a host that draws the choice itself (a settings row whose switch is the choice between `false` and the object); the form then draws the branch the `value` holds.

## A host's own settings row

A host that draws the row of a value itself (a `SettingRow` with the value's name, description, status and error, in a list of such rows) mounts the form in that row's body with `variant="setting-rows"` and `rootRowHosted`. The form then draws no row for its root. A root that is one short field or one choice (a group whose only field is a number, or a union of `false` and an object) hands its control to the host through `onRootControl`, once, at mount: render the snippet in the row's control column, so the control sits where its sibling rows' controls do. Everything else is drawn where the form is mounted, under the row: the fields of a group of several, and the fields a chosen alternative adds. With nothing to draw there the form says so (`data-cinder-root-body="none"`) and takes no room, so the row is as tall as a row with no body. A handed-over control is outside the `<form>`: it commits on blur, as the sibling scalar rows do, not on Enter, and a failed submit cannot move focus to it. Pass `disabled` to lock it.

## Setting rows variant

`variant="setting-rows"` draws a schema as Settings rows, the shape Settings pages use for a plugin's configuration. Each top-level property is one `SettingRow`: the schema's `title` (else the key as words in sentence case, "Blocked patterns") is the label, the key sits beside it as the row's identifier only when the schema supplies a non-blank `title` that is not the key in another case (a label made from the key shows no identifier), the description is under them, a required property carries the required mark, and the control sits at the inline end. A string is a text field, an `enum` a select, a boolean a switch, a number an input, (an optional `enum` with no default starts on an empty "Not set" choice, and clearing it leaves the key out of the draft), and a number with a unit (`format: "duration-ms"`, or a name ending in `Ms`) a number with its unit select. Text, select, number and duration controls fill the control column (`SettingRow`'s `controlAlign="stretch"`), so they share one leading edge and one width down the rows; a switch keeps the end. A property that cannot sit at the inline end is drawn under its row, as wide as the row and with no border, well or card: an array of strings (a tag input), an object's fields, an array of objects (one JSON editor, as in the `input` variant), a record, a list of choices.

A group that holds exactly one short field (text, select, number, duration or switch) is one row, not a row with a field under it: the group's title, key and description are the row's, and the field's control sits in the control column on the same edge as every other control (a switch stays at the inline end). The group's title is the row's visible label; the field's own label is kept for assistive technology, so the control's accessible name is the field's ("Owner") and the group, a `role="group"` named by its title, describes it by the group's description. A group of two or more fields, or whose one field is a list of strings, a nested group or an array of objects, is drawn under its row as above. The default and `input` variants are unchanged.

A host `issues` entry shows as the error of the row it names, `onDraftChange` reports the same draft as the default variant, and `submitVisible` and `disabled` work as in the other variants. The rows stack, label above control, when the form's container is narrower than `SettingRow`'s own breakpoint, and a form of any size keeps the rows: no Find a field, no Edit as JSON panel, no reordering. Each row's wrapper carries `data-cinder-field` with the key, so a host can find one.

```svelte
<SchemaForm
  variant="setting-rows"
  schema={{
    type: 'object',
    properties: {
      region: { type: 'string', enum: ['us', 'eu'], description: 'Where the work runs.' },
      cacheMs: { type: 'number', description: 'How long a result is kept.' },
    },
  }}
/>
```

## Input variant

`variant="input"` draws the Input block of a page that runs or schedules something. Short fields (strings, numbers, selects) share a row two at a time, and the row falls back to one column when the container is narrow. A boolean is a switch with its description beside it and takes the whole row, as does an array, a group or a JSON field. An array whose items are objects is one JSON editor, not a list of item groups: it starts as `[]`, its status line counts the items ("Valid JSON, array of 1 item"), and Format is in the editor's own toolbar. The default variant keeps checkboxes and item groups.

## Large schemas

A form with more than eight fields (an object group counts as the fields inside it, and an array, record or choice counts as one) is large. Large forms add:

- Required fields first, then optional ones, each in schema order, in every object.
- Two columns for short fields (strings, numbers, booleans, selects, durations). Arrays, groups, chips, tags, records, choices and raw JSON take the whole row. The grid falls back to one column when the container is narrow.
- Nested objects as collapsible groups. A required group starts open and an optional one closed. A closed group summarizes what is inside it: the values that differ from their defaults (`Damaged, whole order`), or else the first field names with `none set` or, when the schema supplies defaults, `defaults` (`Carrier, Tracking Number…, none set`). Groups come only from nested objects in the schema, never from guessing at field names.
- A Find a field filter that matches labels, keys and descriptions, and opens the groups that hold a match.
- Edit as JSON, a panel for pasting a whole input. Apply parses the text, requires an object when the schema is an object, fills in defaults for missing fields, and replaces every field and draft. Pass `jsonEditable={false}` when the host already offers its own JSON entry point for the payload.

A failed submit clears the filter and opens every group that holds an error, so focus always has a field to land on.

## Secret fields

A string marked `secret: true` (what a Zod schema's `.meta({ secret: true })` writes) is a reference to a saved secret, never a text value. SchemaForm draws it as a `Select` of the keys the host passes in `secrets.keys`, grouped by each key's `group` (a plugin's title, say), with the note "Set" or "Missing" on each option, and it draws no text or password input for it. Its value is `{ "$secret": key }` and nothing else: that object is what `onDraftChange` and `onSubmit` report, the validator accepts it where the schema says `string` (and refuses a plain string, or a reference with another member), and a plain value a host seeds in `value` is dropped, so it is never shown or sent. `writeOnly` still draws the password input it always did.

The Select holds one key at a time; an optional field also offers "None". A key longer than 32 characters is cut in the middle in the option and shown whole on the option's own line, and the field's trigger is monospace. A chosen key the host does not list reads as Missing. The field also says what is wrong around it:

- A chosen key that is Missing shows "&lt;key&gt; isn’t saved yet." under the Select, the key in monospace, with an "Add the key" button when `secrets.onAdd` is given. The host saves the key and passes the keys again, and the option's note reads Set with no reload.
- With no keys the Select is disabled and reads "No secrets to choose", and the line under it is `copy.emptyHelp`, then the `manage` link, then `copy.emptyHelpEnd`.
- With `status: "failed"` the Select is replaced by an `ErrorState variant="row"` under the field's label (its required dot kept): "Couldn’t load the saved secrets." and, when `onRetry` is given, its own "Try again". The rest of the form stays usable.
- The one action that ends the missing-key warning, "Add the key", is Button's `link` variant, so it reads as the Settings › Plugins link of the empty state does.

Every sentence is a member of `secrets.copy`, with a default, so a host words the field in its own terms.

```svelte
<script lang="ts">
  import { SchemaForm } from '@lostgradient/cinder';

  const schema = {
    type: 'object',
    properties: {
      channel: { type: 'string', title: 'Channel' },
      token: { type: 'string', title: 'Token', secret: true },
    },
    required: ['channel', 'token'],
  };
  const secrets = {
    keys: [
      { key: 'slack-bot-token', group: 'Slack', set: true },
      { key: 'slack-signing-key', group: 'Slack', set: false },
    ],
  };
</script>

<SchemaForm {schema} {secrets} hosted onDraftChange={(draft) => console.log(draft)} />
```

## Read only

`readOnly` draws the form as label and value pairs: no control, no submit button, no hidden output and no Edit as JSON, in a `div` with `role="group"`. A boolean reads "Yes" or "No", an option reads its label, a list of tags reads comma-separated, a duration reads in words, and a group nests its own pairs under a hairline. A value wraps anywhere and never widens its column. A secret field shows its key in monospace beside a Set or Missing dot (the dot of the key in `secrets.keys`, Missing when it is not listed) and "Not chosen" when it names none, and a `writeOnly` field shows only "Hidden". Use it for configuration the person may read and not change, never as a disabled form: a disabled input would still look like something to edit.

## Hosted in another surface

Set `hosted` when the form sits inside a card, a panel or a page's own `<form>`, as a workflow step's input does. The root is a `div` with `role="group"`, because a `<form>` inside a `<form>` is invalid; it never submits, draws no Submit button and no hidden output field, and offers no Edit as JSON panel, so the host reads the value through `onDraftChange`. A group is a legend line over its fields, indented one step with no border, and the items of an array are told apart by a hairline instead of a dashed box, so the host's own border is the only box. A large form keeps Find a field but draws its groups open.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Custom class merged with `.cinder-schema-form`. |
| `disabled` | `boolean` | no | — | Whether every control is disabled, such as a form the host locks. The form is also disabled while it validates a submit. Defaults to `false`. |
| `hosted` | `boolean` | no | — | Whether the form is drawn inside another surface, such as a card or a page's own form. A hosted form is a `div` with `role="group"` and no `<form>` of its own, which a `<form>` in a `<form>` would be, so it never submits, draws no submit button and offers no Edit as JSON panel. A group inside it is a legend line with its fields indented and no border, and the items of an array are told apart by a hairline instead of a dashed box, so the host's own border is the only box. Read the value through `onDraftChange`. Defaults to `false`. |
| `jsonEditable` | `boolean` | no | — | Whether a large form offers its own Edit as JSON panel. Defaults to `true`; set `false` when the host already provides a JSON entry point for the same payload, so the page does not show two. Find a field and the other large-form affordances are unaffected. |
| `name` | `string` | no | — | Name of the hidden serialized output field. Defaults to `value`. |
| `readOnly` | `boolean` | no | — | Draws every field as a label and its value, with no control, no submit button and no Edit as JSON: a form the person can read and not change, such as a default hook's configuration. A secret field shows its key in monospace beside a Set or Missing dot, and a `writeOnly` field shows "Hidden". Defaults to `false`. |
| `rootChoiceVisible` | `boolean` | no | — | Whether a schema that is itself a union of a literal and an object (an `anyOf` or `oneOf` of `"forever"` or `{ olderThan }`, or of `false` or an object) draws its own control for choosing between the two. Set `false` when the host draws that choice itself, such as a settings row whose switch is the choice between `false` and the object: the form then draws only the alternative the `value` holds. A union nested in a field always draws its control. The schema is validated as given either way. Defaults to `true`. |
| `rootRowHosted` | `boolean` | no | — | Whether the value the form edits is one row of a host's own settings list: a `SettingRow` the host draws, with the value's name, description, status and error. Read only with `variant="setting-rows"`. The form then draws no row for the root. A root that is one short field or one choice (a group whose only field is a number, or a union of `false` and an object) hands its one control to the host through `onRootControl`, for the row's control column, with the field's own label kept as the control's accessible name. Everything else is drawn where the form is mounted, which is the row's `disclosure`: the fields of a group with several, and the fields a chosen alternative adds. A form with nothing to draw there says so (`data-cinder-root-body="none"`) and takes no room. A control drawn in the host's row is outside the `<form>`, so pass `disabled` to lock it and expect no submit on Enter from it. Defaults to `false`. |
| `submitLabel` | `string` | no | — | Label for the built-in submit button. Defaults to `Submit`. |
| `submitVisible` | `boolean` | no | — | Whether the form draws its own submit button. Set `false` when the host submits the form from a button elsewhere on the page, such as a footer, whose `form` attribute names this form's `id`. Without the built-in button a form with several fields does not submit on Enter. Defaults to `true`. |
| `variant` | `"default"` \| `"input"` \| `"setting-rows"` | no | `"default"` | How the fields are drawn. `default` is the plain form. `input` is the Input block of a page that runs or schedules something: short fields share a row two at a time (a switch, an array, a group or a JSON field takes the whole row), a boolean is a switch with its description beside it, and an array of objects is one JSON editor whose status line counts the items. `setting-rows` draws each top-level property as one Settings row (`SettingRow`): the label, the key and the description at the start, the control at the inline end, and a hairline between rows. A property whose control does not fit a column (an object, an array of objects, a JSON field) is drawn under its row, full width and with no box of its own. The rows stack below a container width. A large form keeps the same rows: no Find a field, no Edit as JSON, no reordering. |
| `issues` | `(opaque)` | no | — | Problems the host found with a value this form submitted, such as a server-side validation refusal. Each one is shown on the field its `path` names, as a built-in validation message is, and cleared when that field is edited. Pass a new array to show a new set. Not expressible in JSON Schema; see the component types for the signature. |
| `onDraftChange` | `(opaque)` | no | — | Called after each edit with the complete current draft, before schema validation. The draft can be schema-invalid and does not change the seed-only `value` contract. In-progress numeric editors and temporarily unparseable JSON fields are reported as their current raw text until the value commits or parses successfully. Not expressible in JSON Schema; see the component types for the signature. |
| `onRootControl` | `(opaque)` | no | — | Called once when a `rootRowHosted` form mounts, with the snippet that draws the root's one control, or `undefined` when the root has none (a group of several fields, or a root union whose choice the host draws). Render it in the host row's `control` for as long as the form is mounted, and stop when the form is unmounted: the form does not call again when it is destroyed. Not expressible in JSON Schema; see the component types for the signature. |
| `onSubmit` | `(opaque)` | no | — | Called after validation passes with the schema-conformant output value. Not expressible in JSON Schema; see the component types for the signature. |
| `schema` | `(opaque)` | yes | — | JSON Schema object used to render and validate the form. Not expressible in JSON Schema; see the component types for the signature. |
| `secrets` | `(opaque)` | no | — | The saved secret keys a field marked `secret: true` offers, with the words and actions around it. A schema string marked `secret: true` is drawn as a Select of keys (never a text input) and its value is `{ "$secret": key }`. Without this prop such a field has no key to choose. Not expressible in JSON Schema; see the component types for the signature. |
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
