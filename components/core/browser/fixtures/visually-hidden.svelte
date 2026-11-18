<script lang="ts">
  import { Button, VisuallyHidden } from '@lostgradient/cinder';

  let element = $state<'span' | 'textarea'>('span');
</script>

<label>
  Hidden element
  <select aria-label="as" bind:value={element}>
    <option value="span">span</option>
    <option value="textarea">textarea</option>
  </select>
</label>

<Button>
  <VisuallyHidden as="span">Copy code to clipboard</VisuallyHidden>
  <span aria-hidden="true">⧉</span>
</Button>

<div data-testid="dynamic-visually-hidden">
  <VisuallyHidden as={element}>Copy code to clipboard</VisuallyHidden>
</div>
