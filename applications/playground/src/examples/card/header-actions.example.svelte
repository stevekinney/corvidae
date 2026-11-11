<script lang="ts" module>
  export const title = 'Header actions';
  export const description =
    "An actions snippet sits on the title's baseline. Buttons in it draw at the xs control height, so the header is the same height with or without them.";
</script>

<script lang="ts">
  import { Button, Card } from '@lostgradient/cinder';
</script>

{#snippet actions()}
  <Button>Edit</Button>
{/snippet}

<Card title="Billing" description="Plan and payment method." {actions}>
  <p>Team plan, billed monthly.</p>
</Card>
