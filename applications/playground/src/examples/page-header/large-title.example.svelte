<script lang="ts" module>
  export const title = 'Large title and decisions that are never hidden';
  export const description =
    'A large title that collapses into a sticky bar once it scrolls away. The approval decisions stay visible beside it, and the overflow menu holds only secondary actions; an overflow action marked as a decision is drawn as a button instead.';
</script>

<script lang="ts">
  import { Button, PageHeader } from '@lostgradient/cinder';
</script>

<PageHeader
  headingLevel={2}
  variant="large"
  title="Refund order 4471"
  description="Waiting on your approval."
  overflow={[
    { label: 'Copy link', onclick: () => {} },
    { label: 'Cancel run', decision: true, onclick: () => {} },
  ]}
>
  {#snippet decisions()}
    <Button variant="primary">Approve</Button>
    <Button>Deny</Button>
  {/snippet}
</PageHeader>
