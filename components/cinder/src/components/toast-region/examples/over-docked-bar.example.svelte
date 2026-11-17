<script lang="ts" module>
  export const title = 'Toasts above a docked bar';
  export const description =
    'The region lifts above a docked action bar by its height and the safe area, so a toast never covers Send or Cancel run. Pin the bar to the screen to see it at the bottom edge, as it sits on a page. The Undo toast has no timer; the success toast dismisses itself.';
</script>

<script lang="ts">
  import { Button, DockedActionBar, ToastRegion, useToast } from '@lostgradient/cinder';

  let pinned = $state(false);
</script>

<ToastRegion>
  {#snippet children()}
    {@const toast = useToast()}
    <div class="example-preview-row">
      <Button
        label="Forget a memory"
        onclick={() => toast.show('Memory forgotten.', { undo: () => {} })}
      />
      <Button
        variant="ghost"
        label={pinned ? 'Release the bar' : 'Pin the bar to the screen'}
        onclick={() => (pinned = !pinned)}
      />
      <Button
        variant="secondary"
        label="Come back online"
        onclick={() => toast.show('Back online. Updated just now.', { variant: 'success' })}
      />
    </div>
    <DockedActionBar
      label="Run actions"
      style={pinned
        ? 'position: fixed; inset-inline: var(--cinder-space-3); inset-block-end: 0; margin: 0'
        : undefined}
    >
      {#snippet actions()}
        <Button variant="secondary">Send a message</Button>
        <Button variant="secondary">Cancel run</Button>
      {/snippet}
    </DockedActionBar>
  {/snippet}
</ToastRegion>
