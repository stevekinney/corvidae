<script lang="ts">
  import { Button, Breadcrumbs, PageHeader, Segment, SegmentedControl } from '@lostgradient/cinder';

  // COR-2327 B2: a narrow header's actions beside the status (`narrowActions="beside-status"`),
  // next to the default, drawn only behind a query parameter so the default fixture, its
  // baselines and its axe sweep stay as they are.
  const narrowActions =
    new URLSearchParams(globalThis.location.search).get('narrow-actions') === '1';
  const collapsedCase = new URLSearchParams(globalThis.location.search).get('collapsed') === '1';

  $effect(() => {
    if (!collapsedCase) return;
    const host = document.querySelector('[data-testid="large-title-collapsed"]');
    if (host === null) return;
    // The title is the host's first heading; scroll until it has left the top of the viewport.
    const title = host.querySelector('h2');
    const top = (title ?? host).getBoundingClientRect().bottom + window.scrollY;
    window.scrollTo({ top: top + 80 });
  });
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

<div data-testid="large-title-rest" style="margin-top: var(--cinder-space-4);">
  <PageHeader
    headingLevel={2}
    variant="large"
    title="Refund order 4471"
    description="Waiting on your approval."
    decisions={decisionButtons}
  >
    {#snippet actions()}
      <SegmentedControl id="large-rest-view" selectionMode="single" value="runs" label="View">
        <Segment value="runs">Runs</Segment>
        <Segment value="calls">Calls</Segment>
      </SegmentedControl>
    {/snippet}
  </PageHeader>
</div>

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
    >
      {#snippet actions()}
        <SegmentedControl id={`hero-${tone}-view`} selectionMode="single" value="runs" label="View">
          <Segment value="runs">Runs</Segment>
          <Segment value="calls">Calls</Segment>
        </SegmentedControl>
      {/snippet}
    </PageHeader>
  </div>
{/each}

<!-- The collapsed bar needs the large title scrolled out of view, which the header reads from the
     page's scroll position and does not take as a prop. Behind `?collapsed=1` the page gains room
     to scroll and scrolls past the title, so the sticky bar is drawn. -->
{#if collapsedCase}
  <div data-testid="large-title-collapsed" style="margin-top: var(--cinder-space-4);">
    <PageHeader
      headingLevel={2}
      variant="large"
      title="Refund order 4471"
      description="Waiting on your approval."
      decisions={decisionButtons}
    >
      {#snippet actions()}
        <SegmentedControl
          id="large-collapsed-view"
          selectionMode="single"
          value="runs"
          label="View"
        >
          <Segment value="runs">Runs</Segment>
          <Segment value="calls">Calls</Segment>
        </SegmentedControl>
      {/snippet}
    </PageHeader>
    <div style="block-size: 150vh;"></div>
  </div>
{/if}

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
