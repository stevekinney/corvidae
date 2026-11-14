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

Pass `storageKey` and the divider width is remembered under that key in `localStorage` (or in `storage`, any object with `getItem` and `setItem`). The key is yours, so two lists on a page do not share a width. A storage that is missing or throws is ignored, and the list pane starts at `defaultListWidth`. Resizing the container does not rewrite the stored width, only moving the divider does. The list pane stops growing at 560 pixels; a list that is a table, which needs wider columns, raises that with `maximumListWidth`.

## Hiding the list

Set `listCollapsible` and, while an item is open, `header` is given `listToggle` to place, usually at the end of the title row, so the search and the filter keep the header's full width (a list with no `header` gets one holding the toggle alone). Pressing it hides the list pane: the detail takes the whole width, and a narrow rail at the start edge holds the toggle, so the way back is always on screen. The hidden list is not drawn, so nothing in it takes focus, and focus moves to the toggle each time it flips. With no item open the list shows and there is no toggle, since the list is then all there is to choose from. `listCollapsed` is bindable, and with `storageKey` the choice is remembered under `<storageKey>:list-collapsed`, beside the divider width; a remembered choice wins on mount. `collapseListLabel` and `expandListLabel` name the toggle in each state ("Hide chats", "Show chats"). Below `pushBelow`, where one pane shows at a time, there is nothing to hide and no toggle.

```svelte
<script lang="ts">
  import { ListDetail, SelectableRow } from '@lostgradient/cinder';

  const items = [
    { id: 'onboarding', title: 'Customer onboarding' },
    { id: 'billing', title: 'Billing question' },
  ];
</script>

<ListDetail
  {items}
  key={(chat) => chat.id}
  label="Chats"
  storageKey="chats"
  listCollapsible
  collapseListLabel="Hide chats"
  expandListLabel="Show chats"
>
  {#snippet header({ listToggle })}
    <div class="title-row">
      <h2>Chats</h2>
      {@render listToggle?.()}
    </div>
  {/snippet}
  {#snippet list(chat, row)}
    <SelectableRow selected={row.selected} selectedState="current" onclick={row.open}>
      {#snippet title()}{chat.title}{/snippet}
    </SelectableRow>
  {/snippet}
  {#snippet detail(chat)}
    <h2>{chat.title}</h2>
  {/snippet}
</ListDetail>
```

## Narrow layout

When the component is narrower than `pushBelow` (600 pixels by default, so a tablet shows both panes and a phone shows one), it shows one pane at a time: the list, then the detail with a Back button. The pane then follows the page instead of scrolling inside a box of its own. The width is the component's own, not the viewport's, so a ListDetail in a narrow column stacks inside a wide window. Back clears the selection and returns focus to the row that was open. A width that has not been measured yet counts as wide.

A list that is a table can need more than the room beside a detail pane. Set `stackBelow` (0 by default, which never stacks) and between `pushBelow` and that width both panes still show, one above the other, the detail under the list with a rule between them, and the layout flows with the page.

## Grouped lists

Pass `groupBy` to put consecutive rows under a header band, such as a source or a day. Each group is a nested list named by its header, and the filter and its count stay in the `header` above, so the list scrolls in its own column under them.

## A table in the list slot

Pass `listBody` instead of `list` when the list is a table. It receives the items, the open key and an `open` function, and replaces the rows; `groupBy` and `listEmpty` are then yours to draw. A `DataTable` fits it directly: give it `getRowId` equal to the list's `key`, `openRowId={body.selectedKey}` and `onRowOpen` calling `body.open`, and the open row stays highlighted beside the detail while the table scrolls. Rows carry `data-cinder-row-id`, so `J`, `K` and `Enter` work on them as they do on list rows.

## Loading

Set `loading` while the records load. Nothing shows for the first 300 milliseconds, so a fast load never flickers; after that the list pane shows five placeholder rows, the detail pane shows a placeholder block, and `loadingLabel` ("Loading memories") is announced politely. The header stays live. After ten seconds the placeholder adds its own "still loading" line.

## The detail pane

The detail pane has its own inset (`--cinder-space-4`). A detail view that bleeds to the edge sets `--cinder-list-detail-detail-padding: 0` on the root or an ancestor. The divider between the panes is a quiet 1px rule that shows its grip only on hover or focus.

## Row actions

Row actions stay visible. A `SelectableRow` never hides its trailing actions until hover, so give each row a `⋯` menu trigger, as the example does, when there are more actions than fit.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `backLabel` | `string` | no | `"Back"` | Label of the Back button shown above the detail below `pushBelow`. |
| `backVisible` | `boolean` | no | `true` | Whether the Back button shows above the detail below `pushBelow`. A host whose own chrome already carries the way back to the list (a top bar's back link) turns it off, so the screen has one Back and not two. Back is also how a person returns to the list by keyboard, so the host's way back must be a link or a button, and opening an item focuses the detail region when there is no Back button to focus. |
| `class` | `string` | no | — | Additional class merged onto the `.cinder-list-detail` root element. |
| `collapseListLabel` | `string` | no | `"Hide list"` | Accessible name and tooltip of the toggle while the list shows: what pressing it does. |
| `defaultListWidth` | `number` | no | `280` | Width in pixels of the list pane before the divider is moved. |
| `detailLabel` | `string` | no | `"Details"` | Accessible name of the detail region. |
| `emptyDescription` | `string` | no | `"Choose an item from the list to see it here."` | Description of the default empty detail, used when `empty` is omitted. |
| `emptyTitle` | `string` | no | `"Nothing selected"` | Title of the default empty detail, used when `empty` is omitted. |
| `expandListLabel` | `string` | no | `"Show list"` | Accessible name and tooltip of the toggle while the list is hidden. |
| `flushDetail` | `boolean` | no | `false` | Removes the detail pane's inner padding, for a detail view that lays out its own header, body and footer edge to edge (an open chat, a table, a code frame). In the stacked layout the open detail also fills the height the component is given, so what it docks at its bottom edge, such as a composer, sits at the bottom of the screen instead of after its content. |
| `label` | `string` | yes | — | Accessible name of the list region, for example "Chats". |
| `listCollapsed` | `boolean` | no | `false` | Whether the list pane is hidden, with `listCollapsible`. Bindable. With `storageKey`, the choice is remembered beside the divider width, and a remembered choice wins on mount. |
| `listCollapsible` | `boolean` | no | `false` | Offers a toggle that hides the list pane while an item is open and the panes sit side by side or one above the other, so the detail takes the whole width. While the list shows, `header` is given the toggle to place (a list with no `header` gets a header holding it alone); while the list is hidden, the toggle is the only control of a narrow rail at the start edge, so it is always on screen, and focus moves to it each time it flips. With no item open the list shows and there is no toggle, and below `pushBelow`, where one pane shows at a time, there is nothing to hide. |
| `loading` | `boolean` | no | `false` | Shows a placeholder in place of the rows and the open item while the records load: five list rows in the list pane and a block in the detail pane. Nothing shows for the first 300 milliseconds, so a fast load never flickers, and a slow one adds a "still loading" line after ten seconds. |
| `loadingLabel` | `string` | no | `"Loading"` | What the loading region announces, politely, once the placeholder appears: "Loading memories". |
| `maximumListWidth` | `number` | no | `560` | Widest width in pixels the divider can give the list pane, and the most a remembered or default width can be. Raise it for a list that is a table, whose columns need more than a list of rows. |
| `openFirst` | `boolean` | no | `false` | Opens the first item when none is open and the panes sit side by side, so the detail beside the list is never empty. An item named by the URL, or by `selectedKey`, wins. Nothing opens while the component shows one pane at a time (below `pushBelow`): there the list is where it starts. |
| `pushBelow` | `number` | no | `600` | Width in pixels of the component below which it shows one pane at a time: the list, then the detail with a Back button. It is measured on the component, not the viewport. |
| `selectedKey` | `string` \| `null` | no | `null` | Key of the open item, or `null` when none is open. Bindable. When it is `null` on mount, the item named by the URL's search parameter opens. |
| `selectionParameter` | `string` \| `null` | no | `"selected"` | Name of the search parameter that holds the open item's key. Pass `null` to keep the selection out of the URL. |
| `stackBelow` | `number` | no | `0` | Width in pixels of the component below which, down to `pushBelow`, the two panes are shown one above the other, the detail under the list, instead of side by side. The default `0` never stacks them: the panes sit side by side until `pushBelow` and show one at a time under it. |
| `storageKey` | `string` | no | — | Storage key under which the divider width is remembered. Omit to not remember it. The key is the caller's, so two ListDetails on one page do not share a width. |
| `detail` | `(opaque)` | yes | — | Detail renderer for the open item. Not expressible in JSON Schema; see the component types for the signature. |
| `empty` | `(opaque)` | no | — | Rendered in the detail pane while no item is open. A default message is shown when omitted. Not expressible in JSON Schema; see the component types for the signature. |
| `groupBy` | `(opaque)` | no | — | Groups consecutive items under a header band, such as a source or a day. Passed to the list's `DataList`, so a group is a nested list named by its header. Not expressible in JSON Schema; see the component types for the signature. |
| `header` | `(opaque)` | no | — | List header, above the rows: the title, the count, the create action, the search and the filter. Put the title and the create action on their own row and the filter below at full width, so the action never reads as the filter's submit button. With `listCollapsible`, it is given the toggle that hides the list to place, usually at the end of the title row. Not expressible in JSON Schema; see the component types for the signature. |
| `items` | `(opaque)` | yes | — | The records to list. Each is passed to `list` and, when selected, to `detail`. Not expressible in JSON Schema; see the component types for the signature. |
| `key` | `(opaque)` | yes | — | Key extractor. The key identifies an item in the keyboard cursor, the selection, and the URL. Not expressible in JSON Schema; see the component types for the signature. |
| `list` | `(opaque)` | no | — | Row renderer, called once per item inside an `<li>` that ListDetail provides. Render a `SelectableRow` with `selected={row.selected}` and `selectedState="current"`; activating its primary action opens the item. Omit it when `listBody` draws the rows. Not expressible in JSON Schema; see the component types for the signature. |
| `listBody` | `(opaque)` | no | — | Draws the whole list pane body itself, in place of the `<li>` rows, for a list that is a table. Give each row a `data-cinder-row-id` equal to its `key` (a `DataTable` does) so the J and K cursor finds it, and call `open` when a row is chosen. `list`, `groupBy` and `listEmpty` are ignored while it is set. Not expressible in JSON Schema; see the component types for the signature. |
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
