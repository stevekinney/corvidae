<script lang="ts">
  /*
   * The landing page (`/`).
   *
   * A thin wrapper around the SAME component every documentation page renders, in landing
   * mode, so `/` and `/page/<name>` are one layout with different content. The only thing it
   * adds is the color-token entry point, which is a plain link into the theme builder's
   * catalogue editor filtered to colors. The documentation routes always show shipped
   * Cinder: no color override is ever applied to them, and the builder's draft never styles
   * this page.
   */
  import { Button } from '@lostgradient/cinder';
  import Palette from 'lucide-svelte/icons/palette';

  import ComponentPage from '../component-page.svelte';

  type Props = {
    components: string[];
    readmeHtml: string;
  };

  let { components, readmeHtml }: Props = $props();

  /** The color-token entry point: the theme builder's catalogue editor, filtered to colors. */
  const COLOR_TOKEN_ENTRY_HREF = '/theme-builder?filter=color';
</script>

<ComponentPage {readmeHtml} sidebarComponents={components}>
  {#snippet toolbarActions()}
    <Button
      variant="ghost"
      size="sm"
      iconOnly
      href={COLOR_TOKEN_ENTRY_HREF}
      aria-label="Edit color tokens in the theme builder"
      data-testid="color-token-panel-link"
    >
      <Palette size={17} strokeWidth={1.5} aria-hidden="true" />
    </Button>
  {/snippet}
</ComponentPage>
