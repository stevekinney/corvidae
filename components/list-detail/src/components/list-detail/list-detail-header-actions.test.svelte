<script lang="ts">
  import { Button } from '@lostgradient/button/components/button/index.ts';
  import { SectionHeading } from '@lostgradient/section-heading/components/section-heading/index.ts';
  import ListDetail from './list-detail.svelte';

  let { withActions = false }: { withActions?: boolean } = $props();
  const items = [{ id: 'alpha', title: 'Alpha' }];
</script>

<ListDetail {items} key={(item) => item.id} label="Chats" selectionParameter={null}>
  {#snippet header()}
    <SectionHeading title="Chats" level={2}>
      {#snippet actions()}
        {#if withActions}
          <Button iconOnly aria-label="New chat" variant="ghost">
            {#snippet leadingIcon()}+{/snippet}
          </Button>
        {/if}
      {/snippet}
    </SectionHeading>
  {/snippet}
  {#snippet list(item)}{item.title}{/snippet}
  {#snippet detail(item)}{item.title}{/snippet}
</ListDetail>
