<script lang="ts">
  import { Button, Breadcrumbs, PageHeader } from '@lostgradient/cinder';

  // COR-2327 B2: a narrow header's actions beside the status (`narrowActions="beside-status"`),
  // next to the default, drawn only behind a query parameter so the default fixture, its
  // baselines and its axe sweep stay as they are.
  const narrowActions =
    new URLSearchParams(globalThis.location.search).get('narrow-actions') === '1';
  // A caption under the actions (`actionsNote`), at a wide and a narrow header width, behind its
  // own query parameter for the same reason.
  const actionsNote = new URLSearchParams(globalThis.location.search).get('actions-note') === '1';
</script>

<div>
  <PageHeader title="Approvals" description="3 pending, 12 resolved" />
</div>

<div style="margin-top: var(--cinder-space-4);">
  <PageHeader>
    {#snippet breadcrumbs()}
      <Breadcrumbs items={[{ label: 'Home', href: '/' }, { label: 'Schedules' }]} />
    {/snippet}
    {#snippet title()}Schedules{/snippet}
    {#snippet description()}Create and manage recurring automation schedules.{/snippet}
    {#snippet actions()}
      <Button variant="primary" size="sm" label="+ New schedule" />
    {/snippet}
  </PageHeader>
</div>

{#if narrowActions}
  {#each ['own-row', 'beside-status'] as const as placement (placement)}
    <div data-testid={`narrow-${placement}`} style="inline-size: 20rem;">
      <PageHeader
        title="Please refund order 4471, it arrived damaged."
        statusPlacement="inline"
        narrowActions={placement}
      >
        {#snippet status()}Waiting on you{/snippet}
        {#snippet actions()}
          <Button variant="secondary" size="sm" label="More" />
        {/snippet}
      </PageHeader>
    </div>
  {/each}
  <!-- With no status (a chat that has not started), the actions sit beside the title. -->
  <div data-testid="narrow-beside-status-no-status" style="inline-size: 20rem;">
    <PageHeader title="Hello" narrowActions="beside-status">
      {#snippet actions()}
        <Button variant="secondary" size="sm" label="More" />
      {/snippet}
    </PageHeader>
  </div>
{/if}

{#if actionsNote}
  {#each [['wide', '80rem'], ['narrow', '20rem']] as const as [width, inlineSize] (width)}
    <div data-testid={`actions-note-${width}`} style={`inline-size: ${inlineSize};`}>
      <PageHeader
        title="Release notes"
        actionsNote="Retry from this step runs on 1.2.0, like this run. Run again runs on 1.3.0, the current version."
      >
        {#snippet status()}Failed at step 2 of 4{/snippet}
        {#snippet actions()}
          <Button variant="primary" size="sm" label="Retry from this step" />
          <Button variant="secondary" size="sm" label="Run again" />
        {/snippet}
      </PageHeader>
    </div>
  {/each}
{/if}
