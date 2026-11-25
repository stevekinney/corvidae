<script lang="ts">
  import { InlineConfirm } from '@lostgradient/cinder';

  // COR-2683: a destructive two-press action, drawn only behind a query parameter so the default
  // fixture and its baselines stay as they are.
  const twoPress = new URLSearchParams(globalThis.location.search).get('two-press') === '1';
</script>

{#if twoPress}
  <div id="example-mount-two-press">
    <InlineConfirm
      presentation="two-press"
      confirmLabel="Delete namespace"
      armedHint="Reverts in 3 seconds."
      destructive
    />
  </div>
{/if}

<InlineConfirm prompt="Remove this workspace?" confirmLabel="Remove workspace" open destructive />
