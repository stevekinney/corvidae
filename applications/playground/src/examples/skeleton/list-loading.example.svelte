<script lang="ts" module>
  export const title = 'List loading and slow loading';
  export const description =
    'The list variant keeps each row’s status column reserved, then draws two text bars and a time bar, with no circle, so nothing shifts when the data arrives. The region is announced as "Loading agents" with no spinner. After the slow-loading time its own status line and a ghost Cancel take the first row's place; it is not a banner.';
</script>

<script lang="ts">
  import { Skeleton } from '@lostgradient/cinder';
</script>

<div class="example-preview-column" style="gap: var(--cinder-space-6)">
  <Skeleton variant="list" rows={3} dayBand label="Loading agents" />
  <Skeleton
    variant="list"
    rows={3}
    label="Loading agents"
    stillLoadingAfter={0}
    stillLoadingLabel="Still loading agents. This is taking longer than usual."
    onCancel={() => {}}
  />
</div>
