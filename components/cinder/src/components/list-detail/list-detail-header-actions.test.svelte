<script lang="ts">
  import { Button } from '../button/index.ts';
  import ListDetail from './list-detail.svelte';

  let { withActions = false }: { withActions?: boolean } = $props();
  const items = [{ id: 'alpha', title: 'Alpha' }];
</script>

<ListDetail {items} key={(item) => item.id} label="Chats" selectionParameter={null}>
  {#snippet header()}
    <div class="title-row">
      <h2>Chats</h2>
      {#if withActions}
        <Button iconOnly aria-label="New chat" variant="ghost">
          {#snippet leadingIcon()}+{/snippet}
        </Button>
      {/if}
    </div>
  {/snippet}
  {#snippet list(item)}{item.title}{/snippet}
  {#snippet detail(item)}{item.title}{/snippet}
</ListDetail>
