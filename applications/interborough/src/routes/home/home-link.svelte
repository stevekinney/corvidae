<script lang="ts">
  /**
   * The link a Home card keeps to the page that holds the rest ("Open Reviews ›"): Cinder's `Link`
   * with a chevron after the words, semibold, and kept on one line however narrow the card is. It
   * opens its page inside the application, and leaves a modified click to the browser.
   */
  import { Link } from '@lostgradient/cinder';
  import { ChevronRight } from '@lucide/svelte';

  import { router } from '../../lib/router.svelte.ts';

  interface HomeLinkProps {
    /** The page it opens, as a path of the application. */
    path: string;
    /** What it says, such as "Open Reviews". */
    label: string;
  }

  let { path, label }: HomeLinkProps = $props();

  function open(event: MouseEvent): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }
</script>

<Link class="ib-home-link" href={router.href(path)} onclick={open}>
  {label}
  <ChevronRight size={14} aria-hidden="true" />
</Link>

<style>
  :global(.ib-home-link) {
    display: inline-flex;
    align-items: center;
    gap: var(--cinder-space-0-5);
    white-space: nowrap;
    font-weight: var(--cinder-font-semibold);
  }
</style>
