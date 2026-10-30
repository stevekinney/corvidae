<script lang="ts" module>
  export const title = 'Chats with a header, row menus, and keyboard selection';
  export const description =
    'The list header carries the title and the create action on one row and the filter below. Row menus stay visible, J and K move the cursor, Enter opens, the open chat is kept in the URL, and the divider width is remembered.';
</script>

<script lang="ts">
  import { Button, Dropdown, ListDetail, SearchField, SelectableRow } from '@lostgradient/cinder';

  type Chat = { id: string; title: string; summary: string };

  const chats: Chat[] = [
    {
      id: 'onboarding',
      title: 'Customer onboarding',
      summary: 'Walk through the first-run checklist.',
    },
    { id: 'billing', title: 'Billing question', summary: 'Why the March invoice doubled.' },
    { id: 'release', title: 'Release notes', summary: 'Draft the notes for the next release.' },
  ];

  let filter = $state('');
  const visible = $derived(
    chats.filter((chat) => chat.title.toLowerCase().includes(filter.trim().toLowerCase())),
  );
  let renamed = $state('');
</script>

<div class="chats">
  <ListDetail
    items={visible}
    key={(chat) => chat.id}
    label="Chats"
    selectionParameter="chat"
    storageKey="cinder-list-detail-example"
  >
    {#snippet header()}
      <div class="chats-title-row">
        <h2 class="chats-title">Chats <span class="chats-count">{visible.length}</span></h2>
        <Button size="sm" variant="primary">New chat</Button>
      </div>
      <SearchField aria-label="Filter chats" placeholder="Filter chats" bind:value={filter} />
    {/snippet}
    {#snippet list(chat, row)}
      <SelectableRow selected={row.selected} selectedState="current" onclick={row.open}>
        {#snippet title()}{chat.title}{/snippet}
        {#snippet description()}{chat.summary}{/snippet}
        {#snippet trailingActions()}
          <Dropdown id={`chat-actions-${chat.id}`}>
            <Dropdown.Trigger aria-label={`Actions for ${chat.title}`} caretVisible={false}>
              <span aria-hidden="true">⋯</span>
            </Dropdown.Trigger>
            <Dropdown.Menu>
              <Dropdown.Item onclick={() => (renamed = chat.title)}>Rename</Dropdown.Item>
              <Dropdown.Item variant="danger">Delete</Dropdown.Item>
            </Dropdown.Menu>
          </Dropdown>
        {/snippet}
      </SelectableRow>
    {/snippet}
    {#snippet listEmpty()}No chats match the filter.{/snippet}
    {#snippet detail(chat)}
      <article class="chats-detail">
        <h3>{chat.title}</h3>
        <p>{chat.summary}</p>
        {#if renamed === chat.title}<p>Rename requested.</p>{/if}
      </article>
    {/snippet}
  </ListDetail>
</div>

<style>
  .chats {
    block-size: 24rem;
    border: 1px solid var(--cinder-border-muted);
    border-radius: var(--cinder-radius-md);
    overflow: hidden;
  }

  .chats-title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--cinder-space-3);
  }

  .chats-title {
    margin: 0;
    font-size: var(--cinder-text-base);
  }

  .chats-count {
    color: var(--cinder-text-muted);
    font-weight: var(--cinder-font-normal);
  }

  .chats-detail {
    padding: var(--cinder-space-4);
  }
</style>
