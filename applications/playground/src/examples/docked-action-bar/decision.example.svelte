<script lang="ts" module>
  export const title = 'A decision bar with equal actions';
  export const description =
    'equalActions gives Deny and Approve the same width. The bar is a flush strip with a top border, docked to the bottom of the screen; below 32rem of bar width the pair takes its own row under the consequence line and shares it.';
</script>

<script lang="ts">
  import { Button, DockedActionBar } from '@lostgradient/cinder';
</script>

<div
  style="display: flex; flex-direction: column; block-size: 14rem; overflow: auto; border: 1px solid var(--cinder-border); border-radius: var(--cinder-radius-lg);"
>
  <p style="margin: 0; padding: var(--cinder-space-3);">
    Tool runner asks to run Issue refund. Order 4471, $42.00, arrived damaged.
  </p>
  <DockedActionBar label="Decision" equalActions>
    <span>Refunds $42.00 to the original card. This can’t be undone.</span>
    {#snippet actions()}
      <Button variant="secondary">Deny</Button>
      <Button variant="primary">Approve</Button>
    {/snippet}
  </DockedActionBar>
</div>
