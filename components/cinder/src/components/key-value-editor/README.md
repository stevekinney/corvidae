# KeyValueEditor

`KeyValueEditor` edits repeatable string key/value pairs. Pass `secret(key)` to render sensitive values in an editable password `Input`.

```svelte
<KeyValueEditor bind:entries secret={(key) => key.toLowerCase().includes('token')} />
```

The component owns row addition, removal, and change reporting. The consumer owns key validation and the policy that determines which keys are secret.

## Usage

```svelte
<script lang="ts">
  import { KeyValueEditor } from '@lostgradient/cinder';
  let entries = $state([
    { id: 'host', key: 'HOST', value: 'localhost' },
    { id: 'port', key: 'PORT', value: '3000' },
  ]);
</script>

<KeyValueEditor bind:entries />
```

`entries` is the editable list; `onValueChange` is the callback form when the parent does not use a binding. The editor adds and removes rows and reports the resulting array, but it does not validate key syntax, deduplicate names, or persist changes. Supply `secret={(key) => ...}` to route matching values through a password input; the predicate receives the key only, so that callback does not receive the secret value or a policy object.

Each row's `id` is an immutable identity, independent of its editable `key`/`value` text — it must be unique within one editor's `entries`, but two rows may otherwise share equal key/value text. Consumers own minting `id` for the rows they supply (e.g. `crypto.randomUUID()`); the editor mints its own `id` for a row added by typing into its empty last row. Keying rows by `id` (not position) lets a parent reorder, insert, or remove other rows without disturbing a row's focused input.

Each row is one line: the key box, the value box, and an icon-only Remove control at the inline end, all the same height. `keyLabel` and `valueLabel` are drawn once, as quiet column headings above the rows, and name every row's two inputs for assistive technology (the inputs have no visible label of their own). A very narrow container stacks a row's key over its value, with Remove beside the key.

To add a pair, type into the empty row after the last one: the first keystroke makes it a real row, in place and without moving focus, and a new empty row appears under it. The empty row is not part of `entries` until then, and `addLabel` is its accessible description.

Give the list a name and a help line with `label` and `description`: the editor then becomes a labelled group, the label draws above the rows, and the description draws under them and is linked with `aria-describedby`. `monospace` draws both inputs in the code face, as environment variable names and secrets read best.

```svelte
<KeyValueEditor
  bind:entries
  label="Environment"
  description="Values are masked and stored on this machine like an API key; they are never shown again."
  keyLabel="Name"
  addLabel="Add variable"
  secret={() => true}
  monospace
/>
```

Give `addLabel` and `removeLabel` concrete action wording when the surrounding page has more than one editor. If a value fails validation or saving, keep the row and its text in the list so the user can correct it instead of treating a rejected update as a deletion.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `addLabel` | `string` | no | `"Add pair"` | Accessible description of the empty last row, whose key and value boxes add a pair when typed into. Give it concrete wording when more than one editor is on the page. Defaults to `'Add pair'`. |
| `class` | `string` | no | — | Additional class merged with the component's root class. |
| `description` | `string` | no | — | Help under the rows, linked to the group with `aria-describedby`. State what the values are, such as that they are masked and never shown again. |
| `keyLabel` | `string` | no | `"Key"` | Accessible name of every row's key input, also drawn once as the column heading above the rows (the inputs have no visible label of their own). Give it the noun the rows use, such as `'Name'` for environment variables. |
| `label` | `string` | no | — | Visible name for the whole list, shown above the rows ("Environment"). The editor becomes a labelled group, so a screen reader announces it when focus enters the list. |
| `monospace` | `boolean` | no | `false` | Draws the key and value inputs in the monospace face, for identifiers and secrets such as environment variable names. |
| `valueLabel` | `string` | no | `"Value"` | Accessible name of every row's value input, also drawn once as the column heading above the rows. |
| `entries` | `(opaque)` | no | — | The editable list of key/value rows. Bindable. Defaults to `[]`. (`KeyValueEntry` is not expressible in JSON Schema, so this default only appears here in prose.) Not expressible in JSON Schema; see the component types for the signature. |
| `onValueChange` | `(opaque)` | no | — | Callback form of the resulting array, for when the parent does not use `bind:entries`. Not expressible in JSON Schema; see the component types for the signature. |
| `removeLabel` | `(opaque)` | no | — | Label for a row's remove action, given that row's key. Give it concrete wording when more than one editor is on the page. Defaults to `` (key) => `Remove ${key \|\| 'pair'}` ``—an empty key (a newly added, not-yet-named row) falls back to `'Remove pair'`. Not expressible in JSON Schema; see the component types for the signature. |
| `secret` | `(opaque)` | no | — | Predicate receiving a row's key; routes that row's value through a password input when it returns `true`. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->
