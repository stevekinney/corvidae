<script lang="ts" module>
  export const title = 'Top bar icon buttons';
  export const description =
    'Notifications and quick settings as 32px icon-only buttons. They rest as the bare glyph (quiet). Each has an aria-label, the notifications label carries the unread count, and hover, focus and pressed are distinct; focus uses the shared quiet ring.';
</script>

<script lang="ts">
  import { Badge, Button } from '@lostgradient/cinder';
  import Bell from '@lucide/svelte/icons/bell';
  import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';

  const unread = 3;
</script>

<div class="example-preview-row">
  <span style="position: relative; display: inline-flex">
    <Button iconOnly quiet variant="ghost" aria-label={`Notifications, ${unread} unread`}>
      {#snippet leadingIcon()}<Bell size={16} aria-hidden="true" />{/snippet}
    </Button>
    <span style="position: absolute; inset-block-start: -4px; inset-inline-end: -4px">
      <Badge variant="accent" size="xs">{unread}</Badge>
    </span>
  </span>
  <Button iconOnly quiet variant="ghost" aria-label="Quick settings">
    {#snippet leadingIcon()}<SlidersHorizontal size={16} aria-hidden="true" />{/snippet}
  </Button>
</div>
