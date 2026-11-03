<script lang="ts" module>
  export const title = 'Not found';
  export const description =
    'The neutral tone for a thing that doesn’t exist: nothing failed, so it is not announced as an alert. A page that offers a way forward gives the primary button its own label and glyph with retryLabel and retryIcon, then a secondary action beside it.';
</script>

<script lang="ts">
  import { Button, ErrorState } from '@lostgradient/cinder';
  import SquarePen from '@lucide/svelte/icons/square-pen';
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

<ErrorState
  tone="neutral"
  title="Chat not found"
  description="It may have been deleted. The address might also be mistyped."
  retryLabel="New chat"
  onRetry={() => {}}
>
  {#snippet retryIcon()}
    <SquarePen />
  {/snippet}
  {#snippet secondaryAction()}
    <Button variant="secondary" label="Back to chats" />
  {/snippet}
</ErrorState>
