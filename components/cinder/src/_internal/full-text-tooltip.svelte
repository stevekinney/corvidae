<script lang="ts">
  /**
   * The tooltip of text that is cut with an ellipsis (Text `truncate="end"`, Badge `truncate`,
   * TableCell `truncate`): it opens with the whole value on hover and on keyboard focus, which a
   * tap gives too. The cut element keeps its place and takes the focus; this holds only the panel.
   * The panel lives in `document.body`, so the whole value is not read again as part of the text
   * around it (a cell's `textContent`, a row's text).
   */
  import { createPortalAttachment } from '../components/portal/index.ts';
  import Tooltip from '../components/tooltip/tooltip.svelte';

  let { text, triggerRef }: { text: string; triggerRef: HTMLElement | null } = $props();

  const moveToBody = createPortalAttachment({
    target: () => document.body,
    inheritAttributes: true,
  });
</script>

<span class="cinder-full-text-tooltip" {@attach moveToBody}>
  <Tooltip {text} {triggerRef} />
</span>
