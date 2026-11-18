<script lang="ts" module>
  export const title = 'One row inside a card';
  export const description =
    'layout="row" puts the disc and the words at the start and the action at the end of one line, for a state that sits in a card in place of its rows.';
</script>

<script lang="ts">
  import { Card } from '@lostgradient/card';
  import { EmptyState } from '@lostgradient/empty-state';
  import { Link } from '@lostgradient/link';
</script>

<Card title="Needs you" headingLevel={2} padding="none" headerDivider>
  <EmptyState
    kind="done"
    layout="row"
    headingLevel={3}
    title="Nothing is waiting on you"
    description="Approvals and questions from your agents show up here."
  >
    {#snippet action()}
      <Link href="/reviews">Open Reviews</Link>
    {/snippet}
  </EmptyState>
</Card>
