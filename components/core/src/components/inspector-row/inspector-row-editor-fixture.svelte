<script lang="ts">
  import type { InspectorRowValue } from './inspector-row.types.ts';
  import InspectorRow from './inspector-row.svelte';

  // The defaults keep `undefined` out of the two bindings, which `exactOptionalPropertyTypes`
  // refuses to pass to an optional prop.
  let {
    onCommit = () => undefined,
    onCancel = () => undefined,
  }: {
    onCommit?: (next: InspectorRowValue | undefined) => void;
    onCancel?: () => void;
  } = $props();
</script>

<InspectorRow label="Owner" {onCommit} {onCancel}>
  {#snippet value()}Ada{/snippet}
  {#snippet editor({ commit, cancel })}
    <button type="button" data-testid="pick" onclick={() => commit('Grace')}>Grace</button>
    <button type="button" data-testid="drop" onclick={() => cancel()}>Drop</button>
  {/snippet}
</InspectorRow>
