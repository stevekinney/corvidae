<script lang="ts">
  import { Button } from '../button/index.ts';
  import { SectionHeading } from '../section-heading/index.ts';
  import ListDetail from './list-detail.svelte';

  let {
    withActions = false,
    collapsible = false,
  }: { withActions?: boolean; collapsible?: boolean } = $props();
  const items = [{ id: 'alpha', title: 'Alpha' }];
</script>

<ListDetail
  {items}
  key={(item) => item.id}
  label="Chats"
  selectionParameter={null}
  listCollapsible={collapsible}
>
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
