<script lang="ts" module>
  export const title = 'A decision bar with equal actions';
  export const description =
    'equalActions gives Deny and Approve the same width. Below 32rem of bar width the pair takes its own row under the consequence line and shares it.';
</script>

<script lang="ts">
  import { Button, DockedActionBar } from '@lostgradient/cinder';
</script>

<DockedActionBar label="Decision" equalActions>
  <span>Refunds $42.00 to the original card. This can’t be undone.</span>
  {#snippet actions()}
    <Button variant="secondary">Deny</Button>
    <Button variant="primary">Approve</Button>
  {/snippet}
</DockedActionBar>
