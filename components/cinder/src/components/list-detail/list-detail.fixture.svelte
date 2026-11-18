<script lang="ts">
  import { SelectableRow } from '../selectable-row/index.ts';
  import ListDetail from './list-detail.svelte';
  import type { ListDetailProps } from './list-detail.types.ts';

  type Chat = { id: string; title: string };

  type FixtureProps = Partial<
    Omit<ListDetailProps<Chat>, 'items' | 'key' | 'list' | 'detail' | 'listFooter'>
  > & {
    items?: Chat[];
    /** Draws a link to the archived chats as the list's footer. */
    withFooter?: boolean;
  };

  const defaultItems: Chat[] = [
    { id: 'alpha', title: 'Alpha chat' },
    { id: 'beta', title: 'Beta chat' },
    { id: 'gamma', title: 'Gamma chat' },
  ];

  let {
    items = defaultItems,
    selectedKey = $bindable(null),
    withFooter = false,
    ...rest
  }: FixtureProps = $props();
</script>

{#snippet archivedLink()}<a href="#archived">Archived chats</a>{/snippet}

<ListDetail
  {items}
  key={(chat) => chat.id}
  label="Chats"
  bind:selectedKey
  {...withFooter ? { listFooter: archivedLink } : {}}
  {...rest}
>
  {#snippet header()}
    <div class="list-detail-fixture-title-row">
      <h2>Chats</h2>
    </div>
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

<style>
  .list-detail-fixture-title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--cinder-space-2);
  }
</style>
