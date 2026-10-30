<script lang="ts" module>
  export const title = 'Compact for tabs and panels';
  export const description =
    'size="compact" tightens the padding, disc, and type for a tab or a panel.';
</script>

<script lang="ts">
  import { EmptyState } from '@lostgradient/cinder';
</script>

<div style="border: 1px solid var(--cinder-border-muted); border-radius: var(--cinder-radius-md);">
  <EmptyState size="compact" title="No comments yet" description="Replies appear here.">
    {#snippet icon()}
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        aria-hidden="true"
      >
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
      </svg>
    {/snippet}
  </EmptyState>
</div>
