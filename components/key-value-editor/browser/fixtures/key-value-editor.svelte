<script lang="ts">
  import {
    default as KeyValueEditor,
    type KeyValueEntry,
  } from '@lostgradient/key-value-editor/components/key-value-editor/index.ts';

  let entries = $state<KeyValueEntry[]>([
    { id: 'host', key: 'HOST', value: 'localhost' },
    { id: 'port', key: 'PORT', value: '3000' },
  ]);
  let environment = $state<KeyValueEntry[]>([
    { id: 'github-token', key: 'GITHUB_TOKEN', value: 'ghp_example_token' },
  ]);
  let narrow = $state<KeyValueEntry[]>([{ id: 'region', key: 'REGION', value: 'eu-west-1' }]);
</script>

<div class="key-value-editor-fixture">
  <KeyValueEditor bind:entries />
  <KeyValueEditor
    bind:entries={environment}
    label="Environment"
    description="Values are masked and stored on this machine like an API key; they are never shown again."
    keyLabel="Name"
    addLabel="Add variable"
    removeLabel={(key) => `Remove ${key || 'variable'}`}
    secret={() => true}
    monospace
  />
  <div class="key-value-editor-fixture__narrow" data-testid="narrow-key-value-editor">
    <KeyValueEditor bind:entries={narrow} label="Narrow" />
  </div>
</div>

<style>
  .key-value-editor-fixture {
    display: grid;
    gap: var(--cinder-space-8);
  }

  /* Narrower than the editor's 20rem stacking width, so its row puts the key over the value. */
  .key-value-editor-fixture__narrow {
    max-inline-size: 16rem;
  }
</style>
