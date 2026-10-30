<script lang="ts">
  import { SelectableRow } from '../selectable-row/index.ts';
  import ListDetail from './list-detail.svelte';
  import type { ListDetailProps } from './list-detail.types.ts';

  type Chat = { id: string; title: string };

  type FixtureProps = Partial<Omit<ListDetailProps<Chat>, 'items' | 'key' | 'list' | 'detail'>> & {
    items?: Chat[];
  };

  const defaultItems: Chat[] = [
    { id: 'alpha', title: 'Alpha chat' },
    { id: 'beta', title: 'Beta chat' },
    { id: 'gamma', title: 'Gamma chat' },
  ];

  let { items = defaultItems, selectedKey = $bindable(null), ...rest }: FixtureProps = $props();
</script>

<ListDetail {items} key={(chat) => chat.id} label="Chats" bind:selectedKey {...rest}>
  {#snippet header()}
    <h2>Chats</h2>
    <input type="search" aria-label="Search chats" />
  {/snippet}
  {#snippet list(chat, row)}
    <SelectableRow selected={row.selected} selectedState="current" onclick={row.open}>
      {#snippet title()}{chat.title}{/snippet}
      {#snippet trailingActions()}
        <button type="button" aria-label={`More actions for ${chat.title}`}>⋯</button>
      {/snippet}
    </SelectableRow>
  {/snippet}
  {#snippet listEmpty()}No chats yet{/snippet}
  {#snippet detail(chat)}
    <h3>{chat.title} detail</h3>
  {/snippet}
</ListDetail>
