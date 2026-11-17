<script lang="ts">
  import Button from '@lostgradient/button/components/button/button.svelte';
  import Card from '@lostgradient/card/components/card/card.svelte';
  import SectionHeading from '@lostgradient/section-heading/components/section-heading/section-heading.svelte';

  import ErrorScope from '@lostgradient/foundation/_internal/error-scope.test.svelte';

  let {
    kind,
    withActions,
    underError = false,
  }: { kind: 'card' | 'section-heading'; withActions: boolean; underError?: boolean } = $props();
</script>

{#snippet headerButton()}
  <Button variant="primary" data-testid="header-button">Edit</Button>
{/snippet}

{#snippet bodyButton()}
  <Button data-testid="body-button">Body</Button>
{/snippet}

{#snippet content()}
  {#if kind === 'card'}
    <Card title="Title" {...withActions ? { actions: headerButton } : {}}>
      {#snippet children()}{@render bodyButton()}{/snippet}
    </Card>
  {:else}
    <SectionHeading title="Title" {...withActions ? { actions: headerButton } : {}} />
    {@render bodyButton()}
  {/if}
{/snippet}

{#if underError}
  <ErrorScope>{@render content()}</ErrorScope>
{:else}
  {@render content()}
{/if}
