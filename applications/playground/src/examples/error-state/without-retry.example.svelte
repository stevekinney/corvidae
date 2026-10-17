<script lang="ts" module>
  export const title = 'Without retry';
  export const description = 'Omit onRetry when the failure cannot be retried from this region.';
</script>

<script lang="ts">
  import { ErrorState } from '@lostgradient/cinder';
</script>

<ErrorState
  title="You do not have access"
  description="Ask a workspace owner to grant you access to this view."
  headingLevel={3}
/>
