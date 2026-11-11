<script lang="ts">
  /**
   * One of Home's sections: a title, and at the right of it the link to the page that holds the rest
   * ("Open Reviews ›"), over its rows. It is Cinder's `Section`, so it draws no box, band or rule of
   * its own: space separates one section from the next, and the rows under the title carry their
   * own dividers. `data-home-card` names it by its title for the tests and the design captures.
   */
  import type { Snippet } from 'svelte';

  import { Section } from '@lostgradient/cinder';

  import HomeLink from './home-link.svelte';

  interface HomeCardProps {
    /** The section's title, a level-two heading. */
    title: string;
    /** The link at the right of the title; a section without one has none. */
    link?: { readonly label: string; readonly href: string } | undefined;
    class?: string;
    /** The section's content. */
    children: Snippet;
  }

  let { title, link, class: className, children }: HomeCardProps = $props();
</script>

<Section
  {...className === undefined ? {} : { class: className }}
  data-home-card={title}
  {title}
  {...link === undefined ? {} : { actions }}
  {children}
/>

{#snippet actions()}
  {#if link !== undefined}
    <HomeLink path={link.href} label={link.label} />
  {/if}
{/snippet}
