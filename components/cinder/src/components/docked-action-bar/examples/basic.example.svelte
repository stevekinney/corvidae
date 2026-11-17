<script lang="ts" module>
  export const title = 'A live run keeps its actions in reach';
  export const description =
    'The bar docks to the bottom of the page, flush, with a top border. On a short page it sits at the bottom edge rather than under the text (its parent is a flex column as tall as the page); on a long one the page scrolls behind it. It clears the home indicator and rides above the on-screen keyboard, and on touch every control is 44px.';
</script>

<script lang="ts">
  import { Button, DockedActionBar, Input } from '@lostgradient/cinder';

  let message = $state('');
  let longMessage = $state('');
</script>

<div style="display: grid; gap: 1.5rem;">
  <div
    style="display: flex; flex-direction: column; block-size: 14rem; overflow: auto; border: 1px solid var(--cinder-border); border-radius: var(--cinder-radius-lg);"
  >
    <p style="margin: 0; padding: var(--cinder-space-3);">
      The run is working on step 3. This page is short, and the bar still sits at its bottom edge.
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

  <div
    style="display: flex; flex-direction: column; block-size: 14rem; overflow: auto; border: 1px solid var(--cinder-border); border-radius: var(--cinder-radius-lg);"
  >
    <p style="margin: 0; padding: var(--cinder-space-3);">
      The run is working on step 3. Scroll this panel: the bar stays at the bottom edge while the
      text moves behind it.
    </p>
    <p style="margin: 0; padding: var(--cinder-space-3); padding-block-start: 0;">
      Step 4 waits for approval. The page keeps its place, and the actions never scroll away.
    </p>
    <p style="margin: 0; padding: var(--cinder-space-3); padding-block-start: 0;">
      Step 5 drafts the notes once the approval comes back, then the run ends.
    </p>
    <p style="margin: 0; padding: var(--cinder-space-3); padding-block-start: 0;">
      A step that fails shows its reason here, above the bar, until you answer it.
    </p>
    <DockedActionBar label="Run actions">
      <Input
        id="run-context-long"
        label="Add context"
        labelVisible={false}
        placeholder="Add context the agent will see on its next step"
        bind:value={longMessage}
      />
      {#snippet actions()}
        <Button variant="secondary">Send a message</Button>
        <Button variant="secondary">Cancel run</Button>
      {/snippet}
    </DockedActionBar>
  </div>
</div>
