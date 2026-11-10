<script lang="ts">
  import Button from '../components/button/button.svelte';
  import Card from '../components/card/card.svelte';
  import SectionHeading from '../components/section-heading/section-heading.svelte';

  let { kind, withActions }: { kind: 'card' | 'section-heading'; withActions: boolean } = $props();
</script>

{#snippet headerButton()}
  <Button data-testid="header-button">Edit</Button>
{/snippet}

{#snippet bodyButton()}
  <Button data-testid="body-button">Body</Button>
{/snippet}

{#if kind === 'card'}
  <Card title="Title" actions={withActions ? headerButton : undefined}>
    {#snippet children()}{@render bodyButton()}{/snippet}
  </Card>
{:else}
  <SectionHeading title="Title" actions={withActions ? headerButton : undefined} />
  {@render bodyButton()}
{/if}
