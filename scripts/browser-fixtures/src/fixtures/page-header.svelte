<script lang="ts">
  import { Button, Breadcrumbs, PageHeader, Segment, SegmentedControl } from '@lostgradient/cinder';

  // COR-2327 B2: a narrow header's actions beside the status (`narrowActions="beside-status"`),
  // next to the default, drawn only behind a query parameter so the default fixture, its
  // baselines and its axe sweep stay as they are.
  const narrowActions =
    new URLSearchParams(globalThis.location.search).get('narrow-actions') === '1';
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

<!-- COR-2445 AC7: the large title at rest and collapsed, and the hero on the accent and night tones,
     each with decision actions and a SegmentedControl, so the focus-ring hook of each is drawn. -->
{#snippet decisionButtons()}
  <Button variant="primary">Approve</Button>
  <Button>Deny</Button>
{/snippet}
{#snippet viewSwitch()}
  <SegmentedControl id="page-header-view" selectionMode="single" value="runs" label="View">
    <Segment value="runs">Runs</Segment>
    <Segment value="calls">Calls</Segment>
  </SegmentedControl>
{/snippet}

{#each [false, true] as collapsed (collapsed)}
  <div
    data-testid={collapsed ? 'large-title-collapsed' : 'large-title-rest'}
    style="margin-top: var(--cinder-space-4);"
  >
    <PageHeader
      headingLevel={2}
      variant="large"
      {collapsed}
      title="Refund order 4471"
      description="Waiting on your approval."
      decisions={decisionButtons}
      actions={viewSwitch}
    />
  </div>
{/each}

{#each ['accent', 'night'] as const as tone (tone)}
  <div data-testid={`hero-${tone}`} style="margin-top: var(--cinder-space-4);">
    <PageHeader
      headingLevel={2}
      variant="hero"
      {tone}
      eyebrow="Denver"
      title="Poor Decisions"
      titleSoft=", made easier"
      description="Happy hours near you, open right now."
      decisions={decisionButtons}
      actions={viewSwitch}
    />
  </div>
{/each}

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
