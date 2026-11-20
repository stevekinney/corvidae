<script lang="ts">
  import { CopyableValue } from '@lostgradient/cinder';
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

<style>
  .narrow-layout {
    inline-size: 11rem;
    margin: 0;
  }
</style>
