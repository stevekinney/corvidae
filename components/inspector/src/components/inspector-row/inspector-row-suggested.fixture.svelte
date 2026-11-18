<script lang="ts">
  import { Inspector } from '../inspector/index.ts';
  import { InspectorRow } from './index.ts';
</script>

<div class="inspector-row-suggested-fixture">
  <Inspector header="Details">
    <InspectorRow label="Context" suggested>
      {#snippet value()}Phone{/snippet}
    </InspectorRow>
    <InspectorRow label="Context">
      {#snippet value()}Phone{/snippet}
    </InspectorRow>
  </Inspector>
</div>

<style>
  .inspector-row-suggested-fixture {
    max-inline-size: 28rem;
  }
</style>
