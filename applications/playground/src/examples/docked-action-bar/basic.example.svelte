<script lang="ts" module>
  export const title = 'A live run keeps its actions in reach';
  export const description =
    'The bar sticks to the bottom of the scrolling area while the page scrolls behind it. It clears the home indicator and rides above the on-screen keyboard, and on touch every control is 44px.';
</script>

<script lang="ts">
  import { Button, DockedActionBar, Input } from '@lostgradient/cinder';

  let message = $state('');
</script>

<div style="max-block-size: 16rem; overflow: auto;">
  <p style="margin: 0; padding-block-end: 12rem;">
    The run is working on step 3. Scroll this panel: the bar stays at the bottom edge.
  </p>
  <DockedActionBar label="Run actions">
    <Input
      id="run-context"
      label="Add context"
      labelVisible={false}
      placeholder="Add context the agent will see on its next step"
      bind:value={message}
    />
    {#snippet actions()}
      <Button variant="secondary">Send a message</Button>
      <Button variant="secondary">Cancel run</Button>
    {/snippet}
  </DockedActionBar>
</div>
