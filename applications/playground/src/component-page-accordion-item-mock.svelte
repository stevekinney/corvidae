<script lang="ts">
  import { getContext, type Snippet } from 'svelte';

  let { id, title, children }: { id?: string; title?: string; children?: Snippet } = $props();

  const accordion = getContext<{ toggle(id: string): void } | undefined>(
    'component-page-accordion-mock',
  );
</script>

<section>
  {#if title !== undefined}
    <h3>{title}</h3>
    {#if id !== undefined && accordion !== undefined}
      <button type="button" data-accordion-toggle={id} onclick={() => accordion.toggle(id)}>
        Toggle {id}
      </button>
    {/if}
  {/if}
  {#if children !== undefined}
    {@render children()}
  {/if}
</section>
