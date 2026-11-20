<script lang="ts">
  import { DataList, Skeleton, StackedListItem, StatusDot } from '@lostgradient/cinder';

  const schedules = [
    { id: 'daily-summary', title: 'Daily summary', next: 'Next Tue 3:00 AM' },
    { id: 'weekly-refund-audit', title: 'Weekly refund audit', next: 'Next Mon 11:00 AM' },
  ];
</script>

<div class="example-layout gap-3">
  <Skeleton height="1rem" width="60%" />
  <Skeleton height="1rem" width="80%" />
  <Skeleton height="1rem" width="40%" />
  <div class="profile-placeholder gap-4 margin-block-start-2">
    <Skeleton width="3rem" height="3rem" radius="50%" />
    <div class="profile-text gap-2">
      <Skeleton height="0.875rem" width="50%" />
      <Skeleton height="0.875rem" width="30%" />
    </div>
  </div>
  <!-- The grouped variant (COR-2329): a grouped list's rows, each with a button block. -->
  <div data-testid="skeleton-grouped">
    <Skeleton variant="grouped" rows={2} action label="Loading reviews" />
  </div>
  <!-- A slow load (COR-2329): the status line takes the first row's place, so no row moves. -->
  <div data-testid="skeleton-still-loading">
    <Skeleton
      variant="grouped"
      rows={2}
      action
      label="Loading reviews"
      stillLoadingAfter={0}
      stillLoadingLabel="Still loading reviews. This is taking longer than usual."
      onCancel={() => {}}
    />
  </div>
  <!-- The list variant slow: on a phone the line wraps, and still fits the first row. -->
  <div data-testid="skeleton-list-slow">
    <Skeleton
      variant="list"
      rows={3}
      label="Loading runs"
      stillLoadingAfter={0}
      stillLoadingLabel="Still loading runs. This is taking longer than usual."
      onCancel={() => {}}
    />
  </div>
  <!-- The list placeholder beside the list it stands for (COR-2449): a two-line pair and a
       three-line pair, each as tall as the rows that load, and flat on the canvas. -->
  <div class="example-layout gap-4" data-testid="skeleton-footprint">
    {#each [{ name: 'two', detail: false }, { name: 'three', detail: true }] as pair (pair.name)}
      <div data-testid={`skeleton-footprint-${pair.name}`}>
        <div data-testid="footprint-placeholder">
          <Skeleton variant="list" rows={2} statusMarker="dot" detailLine={pair.detail} />
        </div>
        <div data-testid="footprint-loaded">
          <DataList items={schedules} key={(schedule) => schedule.id} statusColumn>
            {#snippet children(schedule)}
              {#if pair.detail}
                <StackedListItem href={`#${schedule.id}`}>
                  {#snippet status()}<StatusDot word="Active" size="sm" />{/snippet}
                  {#snippet title()}{schedule.title}{/snippet}
                  {#snippet time()}{schedule.next}{/snippet}
                  {#snippet meta()}Workflow, Order refund, Every day at 3:00 AM{/snippet}
                  {#snippet detail()}Won't start{/snippet}
                </StackedListItem>
              {:else}
                <StackedListItem href={`#${schedule.id}`}>
                  {#snippet status()}<StatusDot word="Active" size="sm" />{/snippet}
                  {#snippet title()}{schedule.title}{/snippet}
                  {#snippet time()}{schedule.next}{/snippet}
                  {#snippet meta()}Workflow, Order refund, Every day at 3:00 AM{/snippet}
                </StackedListItem>
              {/if}
            {/snippet}
          </DataList>
        </div>
      </div>
    {/each}
  </div>
  <!-- A page's own placeholder whose first block holds the line, beside the same page before the
       line appears: the real text and the blocks after it are in the same places. -->
  <div class="page-comparison gap-4">
    <div data-testid="skeleton-page-waiting" class="page-placeholder">
      <Skeleton
        stillLoadingAfter={600_000}
        stillLoadingLabel="Still loading Home."
        onCancel={() => {}}
      >
        <p class="paragraph">Monday, Nov 2.</p>
        <Skeleton width="11rem" height="2.2rem" holdsStatusLine />
        <p class="paragraph" data-testid="after-place">Failed in 24 hours</p>
      </Skeleton>
    </div>
    <div data-testid="skeleton-page-slow" class="page-placeholder">
      <Skeleton stillLoadingAfter={0} stillLoadingLabel="Still loading Home." onCancel={() => {}}>
        <p class="paragraph">Monday, Nov 2.</p>
        <Skeleton width="11rem" height="2.2rem" holdsStatusLine />
        <p class="paragraph" data-testid="after-place">Failed in 24 hours</p>
      </Skeleton>
    </div>
  </div>
</div>

<style>
  .example-layout {
    display: flex;
    flex-direction: column;
  }

  .profile-placeholder {
    display: flex;
    align-items: center;
  }

  .profile-text {
    flex: 1;
    display: flex;
    flex-direction: column;
  }

  .page-comparison {
    display: flex;
  }

  .page-placeholder {
    flex: 1;
  }

  .paragraph {
    margin: 0;
  }
</style>
