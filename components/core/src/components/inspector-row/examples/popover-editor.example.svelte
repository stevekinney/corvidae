<script lang="ts" module>
  export const title = 'A custom editor in a popover';
  export const description =
    'An editor snippet opens in a popover anchored to the value and ends the edit with commit or cancel. A disabled row is read-only.';
</script>

<script lang="ts">
  import { Button, Inspector, InspectorRow } from '@lostgradient/cinder';

  let owner = $state('Ada Lovelace');
</script>

<div style="max-inline-size: 22rem;">
  <Inspector header="Details">
    <InspectorRow
      label="Owner"
      editLabel="Choose an owner"
      onCommit={(next) => {
        if (typeof next === 'string') owner = next;
      }}
    >
      {#snippet value()}{owner}{/snippet}
      {#snippet editor({ commit, cancel })}
        <div style="display: flex; gap: 0.5rem; padding: 0.5rem;">
          <Button size="sm" onclick={() => commit('Ada Lovelace')}>Ada</Button>
          <Button size="sm" onclick={() => commit('Grace Hopper')}>Grace</Button>
          <Button size="sm" variant="ghost" onclick={() => cancel()}>Cancel</Button>
        </div>
      {/snippet}
    </InspectorRow>
    <InspectorRow label="Created" disabled>
      {#snippet value()}Nov 10, 2026{/snippet}
    </InspectorRow>
  </Inspector>
</div>
