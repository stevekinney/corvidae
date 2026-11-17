<script lang="ts" module>
  export const title = 'Grouped list loading';
  export const description =
    "The grouped variant draws a grouped list's rows on its rounded surface, separators inset at the text. With action, each row keeps a block where its button goes, and on a phone the block drops under the text at its own width.";
</script>

<script lang="ts">
  import { Skeleton } from '@lostgradient/cinder';
</script>

<div class="example-preview-column" style="gap: var(--cinder-space-6)">
  <Skeleton variant="grouped" rows={2} action label="Loading reviews" />
  <Skeleton variant="grouped" rows={3} label="Loading chats" />
</div>
