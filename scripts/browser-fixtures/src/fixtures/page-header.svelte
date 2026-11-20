<script lang="ts">
  import {
    Button,
    Breadcrumbs,
    Container,
    PageHeader,
    Segment,
    SegmentedControl,
  } from '@lostgradient/cinder';

  // COR-2327 B2: a narrow header's actions beside the status (`narrowActions="beside-status"`),
  // next to the default, drawn only behind a query parameter so the default fixture, its
  // baselines and its axe sweep stay as they are.
  const narrowActions =
    new URLSearchParams(globalThis.location.search).get('narrow-actions') === '1';
  // A caption under the actions (`actionsNote`), at a wide and a narrow header width, behind its
  // own query parameter for the same reason.
  const actionsNote = new URLSearchParams(globalThis.location.search).get('actions-note') === '1';
  const actionSizes = new URLSearchParams(globalThis.location.search).get('action-sizes') === '1';

  // The collapsed large title (COR-2445): the header sets `collapsed` from an IntersectionObserver
  // on its title, against the viewport, and a scroll container clips what the observer sees. So this
  // case is a short scroll container, scrolled on mount until the title has left it; the header then
  // reports itself collapsed and its sticky bar shows the title with Approve and Deny.
  let collapsedScroller: HTMLDivElement | undefined = $state();
  $effect(() => {
    collapsedScroller?.scrollTo({ top: 200 });
  });
</script>

{#snippet decisionButtons()}
  <Button variant="primary">Approve</Button>
  <Button>Deny</Button>
{/snippet}

<!-- First on the page, so the header sits above the viewport's middle, where the observer counts a
     title as scrolled away upward. -->
<div
  data-testid="large-title-collapsed"
  bind:this={collapsedScroller}
  style="block-size: 12rem; overflow: auto; border: 1px solid var(--cinder-border-muted);"
>
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
        labelVisible={false}
      >
        <Segment value="runs">Runs</Segment>
        <Segment value="calls">Calls</Segment>
      </SegmentedControl>
    {/snippet}
  </PageHeader>
  <div style="block-size: 40rem;"></div>
</div>

<div style="margin-top: var(--cinder-space-4);">
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

<!-- COR-2445 AC7: the large title at rest, and the hero on the accent and night tones, each with
     decision actions and a SegmentedControl, so the focus-ring hook of each is drawn. In a header's
     actions the control carries its label as its accessible name, not a visible "View". -->
<div data-testid="large-title-rest" style="margin-top: var(--cinder-space-4);">
  <PageHeader
    headingLevel={2}
    variant="large"
    title="Refund order 4471"
    description="Waiting on your approval."
    decisions={decisionButtons}
  >
    {#snippet actions()}
      <SegmentedControl
        id="large-rest-view"
        selectionMode="single"
        value="runs"
        label="View"
        labelVisible={false}
      >
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
        <SegmentedControl
          id={`hero-${tone}-view`}
          selectionMode="single"
          value="runs"
          label="View"
          labelVisible={false}
        >
          <Segment value="runs">Runs</Segment>
          <Segment value="calls">Calls</Segment>
        </SegmentedControl>
      {/snippet}
    </PageHeader>
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

{#if actionSizes}
  {#each [true, false] as compact (compact)}
    <Container
      data-testid={compact ? 'compact-actions' : 'regular-actions'}
      maxWidth="narrow"
      centered={false}
      padded={false}
    >
      <PageHeader
        title="Releases"
        compactActions={compact}
        createAction={{ label: 'New release' }}
        overflow={[{ label: 'Archive' }]}
      >
        {#snippet actions()}
          <Button variant="primary" size="lg" label="Publish" />
        {/snippet}
      </PageHeader>
    </Container>
  {/each}
{/if}
