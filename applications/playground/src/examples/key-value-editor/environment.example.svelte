<script lang="ts" module>
  export const title = 'Environment variables';
  export const description =
    'A labelled list of masked variables: a name field and a masked value field per row with a text Remove button, an "Add variable" button, and help under it. Every value is masked, so the help says they are never shown again.';
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
