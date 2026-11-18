<script lang="ts" module>
  export const title = 'Tooltip over a popover';
  export const description =
    'A tooltip uses the inverse surface, so in dark mode it is the light chip and separates from the raised popover it opens over.';
</script>

<script lang="ts">
  import { Button, Popover, Tooltip } from '@lostgradient/cinder';

  let open = $state(true);
</script>

<div
  style="padding: 3rem 1rem 8rem; display: flex; flex-direction: column; align-items: flex-start;"
>
  <Popover bind:open ariaLabelledby="quick-settings-title" focusManagement="preserve">
    {#snippet trigger()}
      <Button label="Quick settings" onclick={() => (open = !open)} />
    {/snippet}
    <div
      style="display: flex; flex-direction: column; gap: var(--cinder-space-2); min-inline-size: 14rem;"
    >
      <h2
        id="quick-settings-title"
        style="margin: 0; font-size: var(--cinder-text-sm); font-weight: var(--cinder-font-semibold);"
      >
        Quick settings
      </h2>
      <Tooltip text="Theme and sidebar" placement="right">
        <Button variant="secondary" label="Sliders" />
      </Tooltip>
    </div>
  </Popover>
</div>
