<script lang="ts" module>
  export const title = 'Not found';
  export const description =
    'The neutral tone for a thing that doesn’t exist: nothing failed, so it is not announced as an alert.';
</script>

<script lang="ts">
  import { Button, ErrorState } from '@lostgradient/cinder';
</script>

<ErrorState
  tone="neutral"
  title="This run doesn’t exist"
  description="It may have been deleted. The address might also be mistyped."
>
  {#snippet secondaryAction()}
    <Button variant="secondary" label="Back to Runs" />
  {/snippet}
</ErrorState>
