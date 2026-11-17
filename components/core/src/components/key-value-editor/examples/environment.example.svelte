<script lang="ts" module>
  export const title = 'Environment variables';
  export const description =
    'A labelled list of masked variables: one line per row with a name box, a masked value box and an icon Remove at the end, Name and Value headings once above the rows, an empty last row that adds a variable when typed into, and help under it. Every value is masked, so the help says they are never shown again.';
</script>

<script lang="ts">
  import { KeyValueEditor } from '@lostgradient/cinder';

  let entries = $state([{ id: 'github-token', key: 'GITHUB_TOKEN', value: 'ghp_example_token' }]);
</script>

<KeyValueEditor
  bind:entries
  label="Environment"
  description="Values are masked and stored on this machine like an API key; they are never shown again."
  keyLabel="Name"
  valueLabel="Value"
  addLabel="Add variable"
  removeLabel={(key) => `Remove ${key || 'variable'}`}
  secret={() => true}
  monospace
/>
