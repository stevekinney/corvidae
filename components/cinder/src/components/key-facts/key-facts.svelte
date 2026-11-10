<script lang="ts" module>
  /**
   * @cinder
   * @category data-display
   * @status beta
   * @purpose Row of typed facts, each an icon plus a value with an optional link, separated by space rather than a glyph, wrapping only between facts.
   * @tag facts
   * @tag metadata
   * @tag icons
   * @useWhen Showing a few short facts about one item, such as a category, a neighbourhood and a price band, on a detail header or a card.
   * @useWhen Replacing a line of facts joined by a separator glyph with facts that wrap as whole units.
   * @avoidWhen Showing labelled key and value pairs in a grid — use description-list.
   * @avoidWhen Showing a status word — use status-dot.
   * @rationale Nearest alternative: DescriptionList — KeyFacts is a wrapping row of icon and value tokens with no visible labels.
   */
  export type { KeyFact, KeyFactsProps } from './key-facts.types.ts';
</script>

<script lang="ts">
  import { classNames } from '../../utilities/class-names.ts';
  import Link from '../link/link.svelte';
  import type { KeyFactsProps } from './key-facts.types.ts';

  let { items, label, class: className, ...rest }: KeyFactsProps = $props();
</script>

<ul {...rest} class={classNames('cinder-key-facts', className)} aria-label={label}>
  {#each items as fact, index (index)}
    <li class="cinder-key-facts__item">
      {#if fact.icon}
        <span class="cinder-key-facts__icon" aria-hidden="true">{@render fact.icon()}</span>
      {/if}
      {#if fact.label}<span class="cinder-sr-only">{fact.label}: </span>{/if}
      {#if fact.href}
        <Link href={fact.href} class="cinder-key-facts__value">{fact.value}</Link>
      {:else}
        <span class="cinder-key-facts__value">{fact.value}</span>
      {/if}
    </li>
  {/each}
</ul>
