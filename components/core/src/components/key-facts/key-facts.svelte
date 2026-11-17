<script lang="ts" module>
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
      {#if fact.label}<span class="cinder-sr-only">{`${fact.label}: `}</span>{/if}
      {#if fact.href}
        <Link href={fact.href} class="cinder-key-facts__value">{fact.value}</Link>
      {:else}
        <span class="cinder-key-facts__value">{fact.value}</span>
      {/if}
    </li>
  {/each}
</ul>
