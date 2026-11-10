<script lang="ts">
  import Button from '../components/button/button.svelte';
  import Card from '../components/card/card.svelte';
  import SectionHeading from '../components/section-heading/section-heading.svelte';

  import ErrorScope from './error-scope.test.svelte';

  let {
    kind,
    withActions,
    underError = false,
  }: { kind: 'card' | 'section-heading'; withActions: boolean; underError?: boolean } = $props();
</script>

{#snippet headerButton()}
  <Button data-testid="header-button">Edit</Button>
{/snippet}

{#snippet bodyButton()}
  <Button data-testid="body-button">Body</Button>
{/snippet}

{#snippet content()}
  {#if kind === 'card'}
    <Card title="Title" actions={withActions ? headerButton : undefined}>
      {#snippet children()}{@render bodyButton()}{/snippet}
    </Card>
  {:else}
    <SectionHeading title="Title" actions={withActions ? headerButton : undefined} />
    {@render bodyButton()}
  {/if}
{/snippet}

{#if underError}
  <ErrorScope>{@render content()}</ErrorScope>
{:else}
  {@render content()}
{/if}
