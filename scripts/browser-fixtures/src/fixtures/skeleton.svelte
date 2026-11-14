<script lang="ts">
  import { Skeleton } from '@lostgradient/cinder';
</script>

<div style="display: flex; flex-direction: column; gap: 0.75rem;">
  <Skeleton height="1rem" width="60%" />
  <Skeleton height="1rem" width="80%" />
  <Skeleton height="1rem" width="40%" />
  <div style="display: flex; align-items: center; gap: 1rem; margin-top: 0.5rem;">
    <Skeleton width="3rem" height="3rem" radius="50%" />
    <div style="flex: 1; display: flex; flex-direction: column; gap: 0.5rem;">
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
  <!-- A page's own placeholder whose first block holds the line, beside the same page before the
       line appears: the real text and the blocks after it are in the same places. -->
  <div style="display: flex; gap: 1rem;">
    <div data-testid="skeleton-page-waiting" style="flex: 1;">
      <Skeleton
        stillLoadingAfter={600_000}
        stillLoadingLabel="Still loading Home."
        onCancel={() => {}}
      >
        <p style="margin: 0;">Monday, Nov 2.</p>
        <Skeleton width="11rem" height="2.2rem" holdsStatusLine />
        <p style="margin: 0;" data-testid="after-place">Failed in 24 hours</p>
      </Skeleton>
    </div>
    <div data-testid="skeleton-page-slow" style="flex: 1;">
      <Skeleton stillLoadingAfter={0} stillLoadingLabel="Still loading Home." onCancel={() => {}}>
        <p style="margin: 0;">Monday, Nov 2.</p>
        <Skeleton width="11rem" height="2.2rem" holdsStatusLine />
        <p style="margin: 0;" data-testid="after-place">Failed in 24 hours</p>
      </Skeleton>
    </div>
  </div>
</div>
