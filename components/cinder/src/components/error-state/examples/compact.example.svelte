<script lang="ts" module>
  export const title = 'Compact, in a list pane';
  export const description =
    'size="compact" shrinks the disc, quiets the type and makes the retry a small secondary button, so a list pane that failed to load says so without claiming the page’s one primary action.';
</script>

<script lang="ts">
  import { ErrorState } from '@lostgradient/cinder';
</script>

<div
  style="max-inline-size: 18rem; border: 1px solid var(--cinder-border-muted); border-radius: var(--cinder-radius-md)"
>
  <ErrorState
    size="compact"
    headingLevel={3}
    title="Couldn’t load chats"
    description="Interborough didn’t send them back."
    onRetry={() => undefined}
  />
</div>
