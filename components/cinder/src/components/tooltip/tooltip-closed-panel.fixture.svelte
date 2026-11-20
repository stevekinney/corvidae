<script lang="ts">
  import Button from '../button/button.svelte';
  import { Tooltip } from './index.ts';
</script>

<!-- A box with a transform, as a floating control or an animated card has, that clips its overflow.
     A closed tooltip panel is `position: fixed` inside it, so the transform is its containing
     block. The browser test narrows the box and reads whether it scrolls. -->
<div class="tooltip-closed-panel" data-testid="transformed">
  <Tooltip text="Copy the Claude Code command for Cursor.">
    <Button label="Copy" />
  </Tooltip>
</div>

<style>
  .tooltip-closed-panel {
    position: relative;
    margin: var(--cinder-space-8);
    overflow: auto;
    transform: translateY(-50%);
  }
</style>
