<script lang="ts" module>
  export const title = 'Create action, status and a full-page error';
  export const description =
    'A list page’s create action is a secondary icon-only "+" with a tooltip and an accessible name, in the same place in every state. status sits beside the title or under it, a long title wraps to two lines and then ends in an ellipsis with the full title in its tooltip, and error draws the header’s primary buttons as secondary so Try again is the only primary.';
</script>

<script lang="ts">
  import { Button, PageHeader } from '@lostgradient/cinder';

  let failed = $state(false);
</script>

<div style="display: grid; gap: 1.5rem;">
  <PageHeader
    headingLevel={2}
    title="Agents"
    description="Agents run your chats, goals and schedules."
    createAction={{ label: 'New agent', onclick: () => {} }}
  />

  <PageHeader
    headingLevel={2}
    title="Please refund order 4471, it arrived damaged, and also check whether the Parcelly damage claims batch from last week was filed for the same carrier"
    statusPlacement="inline"
  >
    {#snippet status()}Waiting on you{/snippet}
  </PageHeader>

  <PageHeader headingLevel={2} title="Look up order 4468">
    {#snippet status()}Done · Fri, Oct 30 · took 23 s{/snippet}
  </PageHeader>

  <div>
    <PageHeader
      headingLevel={2}
      title="Memory"
      error={failed}
      createAction={{ label: 'Add a memory' }}
    >
      {#snippet actions()}
        <Button variant="primary">Export</Button>
      {/snippet}
    </PageHeader>
    <Button variant="ghost" onclick={() => (failed = !failed)}>
      {failed ? 'Clear the error' : 'Show a full-page error'}
    </Button>
  </div>
</div>
