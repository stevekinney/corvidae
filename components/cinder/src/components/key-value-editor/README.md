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
    { key: 'HOST', value: 'localhost' },
    { key: 'PORT', value: '3000' },
  ]);
</script>

<KeyValueEditor bind:entries />
```

`entries` is the editable list; `onValueChange` is the callback form when the parent does not use a binding. The editor adds and removes rows and reports the resulting array, but it does not validate key syntax, deduplicate names, or persist changes. Supply `secret={(key) => ...}` to route matching values through a password input; the predicate receives the key only, so that callback does not receive the secret value or a policy object.

Give `addLabel` and `removeLabel` concrete action wording when the surrounding page has more than one editor. If a value fails validation or saving, keep the row and its text in the list so the user can correct it instead of treating a rejected update as a deletion.
