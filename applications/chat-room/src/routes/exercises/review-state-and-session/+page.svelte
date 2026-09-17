<script lang="ts">
  import SessionReducerFixture from './session-reducer-fixture.svelte';
  import SessionStorageFixture from './session-storage-fixture.svelte';
  import StateEditorFixture from './state-editor-fixture.svelte';
</script>

<div style="max-width: 72rem; margin: 0 auto; padding: 1rem; display: grid; gap: 2rem;">
  <StateEditorFixture />
  <SessionReducerFixture />
  <SessionStorageFixture />
</div>
