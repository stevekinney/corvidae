<script lang="ts">
  /**
   * One of Home's cards: a title at the left of its top row, and at the right the link to the page
   * that holds the rest ("Open Reviews ›"). The title row is a tinted band over the rows, which sit
   * flush under it, so a list reaches the card's edges and its dividers run across. A card that
   * shows no rows (the composer) has a plain title row and takes the default padding.
   */
  import type { Snippet } from 'svelte';

  import { Card } from '@lostgradient/cinder';

  import HomeLink from './home-link.svelte';

  interface HomeCardProps {
    /** The card's title, a level-two heading. */
    title: string;
    /** The link at the right of the title row; a card without one has none. */
    link?: { readonly label: string; readonly href: string } | undefined;
    /**
     * Whether the content is rows that reach the card's edges, under a title row drawn as a tinted
     * band with a divider. Default `true`; `false` is a padded card with a plain title row.
     */
    flush?: boolean;
    class?: string;
    /** The card's content. */
    children: Snippet;
  }

  let { title, link, flush = true, class: className, children }: HomeCardProps = $props();
</script>

<Card
  {...className === undefined ? {} : { class: className }}
  data-home-card={title}
  {header}
  padding={flush ? 'none' : 'default'}
  headerDivider={flush}
  headerTone={flush ? 'muted' : 'default'}
  {children}
/>

{#snippet header()}
  <div class="ib-home-card__title-row">
    <h2 class="ib-home-card__title">{title}</h2>
    {#if link !== undefined}
      <HomeLink path={link.href} label={link.label} />
    {/if}
  </div>
{/snippet}

<style>
  .ib-home-card__title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--cinder-space-3);
  }

  .ib-home-card__title {
    margin: 0;
    font-size: var(--cinder-text-base);
    font-weight: var(--cinder-font-semibold);
  }
</style>
