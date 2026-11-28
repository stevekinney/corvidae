<script lang="ts">
  /**
   * One of Home's sections: a title, and at the right of it the link to the page that holds the rest
   * ("Open Reviews ›", Cinder's `Link` in its `more` form, which opens the page inside the
   * application and leaves a modified click to the browser), over its rows. It is Cinder's `Section`, so it draws no box, band or rule of
   * its own: space separates one section from the next, and the rows under the title carry their
   * own dividers. `data-home-card` names it by its title for the tests and the design captures.
   *
   * A section that holds nothing is `bare`: its empty state stands alone, with no title above it
   * saying the same thing (owner report, 2026-11-19), and the title names the region instead.
   */
  import type { Snippet } from 'svelte';

  import { Link, Section } from '@lostgradient/cinder';

  import { router } from '../../lib/router.svelte.ts';

  interface HomeCardProps {
    /** The section's title, a level-two heading. */
    title: string;
    /** The link at the right of the title; a section without one has none. */
    link?: { readonly label: string; readonly href: string } | undefined;
    /** The section holds only its empty state: no title or link is drawn above it. */
    bare?: boolean;
    class?: string;
    /** The section's content. */
    children: Snippet;
  }

  let { title, link, bare = false, class: className, children }: HomeCardProps = $props();
</script>

{#if bare}
  <section class={className} data-home-card={title} aria-label={title}>
    {@render children()}
  </section>
{:else}
  <Section
    {...className === undefined ? {} : { class: className }}
    data-home-card={title}
    {title}
    {...link === undefined ? {} : { actions }}
    {children}
  />
{/if}

{#snippet actions()}
  {#if link !== undefined}
    {@const path = link.href}
    <Link variant="more" href={router.href(path)}>{link.label}</Link>
  {/if}
{/snippet}
