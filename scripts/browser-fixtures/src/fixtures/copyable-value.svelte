<script lang="ts">
  import { CopyableValue } from '@lostgradient/cinder';

  const showHints = new URLSearchParams(globalThis.location.search).has('hints');
</script>

<!-- A place narrow enough that the address must break, so the control's place on its last line shows. -->
<p data-testid="narrow" class="narrow-layout">
  Deliveries go to
  <CopyableValue
    data-testid="address"
    value="https://example.com/triggers/nightly-digest"
    label="Copy the address"
    copiedLabel="Address copied"
  />
</p>

{#if showHints}
  <p class="hints-layout" data-testid="hinted-address-wrapper">
    <CopyableValue data-testid="hinted-address" value="temporal.staging.internal:7233" breakHints />
  </p>
{/if}

<style>
  .hints-layout {
    font-size: var(--cinder-text-lg);
    line-height: 1.5;
  }
  .narrow-layout {
    inline-size: 11rem;
    margin: 0;
  }
</style>
