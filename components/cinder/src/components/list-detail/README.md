# ListDetail

A list on one side, the open item on the other, with a draggable divider between them. Built from `ResizablePanels`, `DataList` and `SelectableRow`, it adds a list header, keyboard selection, the open item kept in the URL, a remembered divider width, and a layout that shows one pane at a time when the component is narrow.

Use it to browse a collection where choosing a record shows it beside the list: chats, runs, memories. Choose `ResizablePanels` alone when you need the layout without a list, and `StackedListItem` when every record has its own page and the list only navigates there.

## Usage

```svelte
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
```

`items`, `key`, `label`, `list` and `detail` are required. ListDetail owns the iteration, so it wraps each row in the `<li>` that `DataList` needs; your `list` snippet renders the row itself, usually a `SelectableRow` with `selected={row.selected}`, `selectedState="current"` and `onclick={row.open}`. Activating a `SelectableRow` primary action opens its item even without `onclick`, and `row.open` opens it from any other control.

## Header

The `header` snippet sits above the rows. Put the title and the create action on their own row and the filter below at full width, so the action never reads as the filter's submit button. The count, search and filter are whatever you render there.

## Keyboard

`J` moves the keyboard cursor to the next row and `K` to the previous one, moving focus with it. `Enter` opens the row the cursor is on. The cursor is separate from the open item: moving it never changes the detail. `J` and `K` are ignored while focus is in a text field, a menu, a listbox, a combobox or a dialog, and while Control, Meta or Alt is held.

`LIST_DETAIL_SHORTCUTS` describes these keys, each with its `keys` and a `label`, so an application can list them in its own shortcut map without handling them. The list region's `aria-keyshortcuts` is built from the same list.

```ts
import { LIST_DETAIL_SHORTCUTS } from '@lostgradient/cinder';

const labels: string[] = LIST_DETAIL_SHORTCUTS.map((shortcut) => shortcut.label);
```

## Selection in the URL

The open item's key is kept in the `selected` search parameter (`selectionParameter`; pass `null` to keep it out of the URL). On mount, an empty `selectedKey` is filled from the URL, so a reload or a shared link lands on the same item. The URL is updated with `history.replaceState`, so selecting does not add history entries, and other search parameters are kept. Pass `selectionLocation` with `read` and `write` to route differently or to test. An explicit `selectedKey` wins over the URL and is written to it. A key that names no row shows the empty detail when the layout is split, and the list when it is stacked.

`selectedKey` is bindable, and `onSelectedKeyChange` reports each change.

## Divider width

Pass `storageKey` and the divider width is remembered under that key in `localStorage` (or in `storage`, any object with `getItem` and `setItem`). The key is yours, so two lists on a page do not share a width. A storage that is missing or throws is ignored, and the list pane starts at `defaultListWidth`. Resizing the container does not rewrite the stored width, only moving the divider does.

## Narrow layout

When the component is narrower than `pushBelow` (900 pixels by default), it shows one pane at a time: the list, then the detail with a Back button. The width is the component's own, not the viewport's, so a ListDetail in a narrow column stacks inside a wide window. Back clears the selection and returns focus to the row that was open. A width that has not been measured yet counts as wide.

## Row actions

Row actions stay visible. A `SelectableRow` never hides its trailing actions until hover, so give each row a `⋯` menu trigger, as the example does, when there are more actions than fit.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `backLabel` | `string` | no | `"Back"` | Label of the Back button shown above the detail below `pushBelow`. |
| `class` | `string` | no | — | Additional class merged onto the `.cinder-list-detail` root element. |
| `defaultListWidth` | `number` | no | `320` | Width in pixels of the list pane before the divider is moved. |
| `detailLabel` | `string` | no | `"Details"` | Accessible name of the detail region. |
| `emptyDescription` | `string` | no | `"Choose an item from the list to see it here."` | Description of the default empty detail, used when `empty` is omitted. |
| `emptyTitle` | `string` | no | `"Nothing selected"` | Title of the default empty detail, used when `empty` is omitted. |
| `label` | `string` | yes | — | Accessible name of the list region, for example "Chats". |
| `pushBelow` | `number` | no | `900` | Width in pixels of the component below which it shows one pane at a time: the list, then the detail with a Back button. It is measured on the component, not the viewport. |
| `selectedKey` | `string` \| `null` | no | `null` | Key of the open item, or `null` when none is open. Bindable. When it is `null` on mount, the item named by the URL's search parameter opens. |
| `selectionParameter` | `string` \| `null` | no | `"selected"` | Name of the search parameter that holds the open item's key. Pass `null` to keep the selection out of the URL. |
| `storageKey` | `string` | no | — | Storage key under which the divider width is remembered. Omit to not remember it. The key is the caller's, so two ListDetails on one page do not share a width. |
| `detail` | `(opaque)` | yes | — | Detail renderer for the open item. Not expressible in JSON Schema; see the component types for the signature. |
| `empty` | `(opaque)` | no | — | Rendered in the detail pane while no item is open. A default message is shown when omitted. Not expressible in JSON Schema; see the component types for the signature. |
| `header` | `(opaque)` | no | — | List header, above the rows: the title, the count, the create action, the search and the filter. Put the title and the create action on their own row and the filter below at full width, so the action never reads as the filter's submit button. Not expressible in JSON Schema; see the component types for the signature. |
| `items` | `(opaque)` | yes | — | The records to list. Each is passed to `list` and, when selected, to `detail`. Not expressible in JSON Schema; see the component types for the signature. |
| `key` | `(opaque)` | yes | — | Key extractor. The key identifies an item in the keyboard cursor, the selection, and the URL. Not expressible in JSON Schema; see the component types for the signature. |
| `list` | `(opaque)` | yes | — | Row renderer, called once per item inside an `<li>` that ListDetail provides. Render a `SelectableRow` with `selected={row.selected}` and `selectedState="current"`; activating its primary action opens the item. Not expressible in JSON Schema; see the component types for the signature. |
| `listEmpty` | `(opaque)` | no | — | Rendered in the list when `items` is empty. Not expressible in JSON Schema; see the component types for the signature. |
| `onSelectedKeyChange` | `(opaque)` | no | — | Called with the new key when an item opens, and with `null` when the selection is cleared. Not expressible in JSON Schema; see the component types for the signature. |
| `selectionLocation` | `(opaque)` | no | — | Where the selection is read and written. Defaults to the address bar. Not expressible in JSON Schema; see the component types for the signature. |
| `storage` | `(opaque)` | no | — | Where the divider width is remembered. Defaults to `localStorage`. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->
<!-- generated:subcomponents:end -->
