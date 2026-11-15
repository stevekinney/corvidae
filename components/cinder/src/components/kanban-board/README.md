# KanbanBoard

Controlled multi-column board for reordering cards within and across workflow columns with keyboard, pointer, and live-region feedback.

## Usage

```svelte
<script lang="ts">
  import { Avatar, Badge, KanbanBoard, type KanbanBoardColumn } from '@lostgradient/cinder';

  type WorkItem = {
    id: string;
    title: string;
    assignee: string;
    priority: 'Low' | 'Medium' | 'High';
  };

  let columns = $state<KanbanBoardColumn<WorkItem>[]>([
    {
      id: 'backlog',
      title: 'Backlog',
      cards: [
        {
          id: 'inventory-alerts',
          title: 'Inventory alerts',
          assignee: 'Mina Okafor',
          priority: 'High',
        },
        {
          id: 'weekly-report',
          title: 'Weekly report export',
          assignee: 'Dev Patel',
          priority: 'Medium',
        },
      ],
    },
    {
      id: 'active',
      title: 'Active',
      cards: [
        {
          id: 'shipment-map',
          title: 'Shipment map filters',
          assignee: 'Rae Lindqvist',
          priority: 'High',
        },
        {
          id: 'cycle-count',
          title: 'Cycle count cleanup',
          assignee: 'Alex Moreno',
          priority: 'Low',
        },
      ],
    },
    {
      id: 'done',
      title: 'Done',
      cards: [
        {
          id: 'store-pulse',
          title: 'Store pulse summary',
          assignee: 'Nia Brooks',
          priority: 'Medium',
        },
      ],
    },
  ]);
</script>

<KanbanBoard
  label="Project work board"
  {columns}
  getCardKey={(item) => item.id}
  getCardLabel={(item) => item.title}
  collapsible
  onColumnsChange={(nextColumns) => {
    columns = nextColumns;
  }}
>
  {#snippet cardMeta(item)}
    <Avatar name={item.assignee} size="xs" aria-hidden="true" />
    <span>{item.assignee}</span>
  {/snippet}

  {#snippet cardTrailing(item)}
    <Badge
      variant={item.priority === 'High'
        ? 'danger'
        : item.priority === 'Medium'
          ? 'warning'
          : 'success'}
    >
      {item.priority}
    </Badge>
  {/snippet}

  {#snippet emptyColumn(column)}
    Drop cards into {column.title}
  {/snippet}
</KanbanBoard>
```

Leave `card` out and the board lays the card out itself: the title (the `getCardLabel` text) on top, then one quiet row with `cardMeta` at its start, in muted text, and `cardTrailing` at its inline end. Give a person's full name beside their avatar, and hide the avatar from assistive technology (`aria-hidden="true"`) so the name is read once. Pass `card` instead only when a card needs a body of its own; it then replaces the built-in layout, and `cardMeta` and `cardTrailing` are not drawn.

## Guidance

### Use When

- Presenting a workflow board where users move cards between ordered columns.
- Consumers own card rendering and need cinder to manage reorder affordances and change metadata.

### Avoid When

- Showing a single ordered list — use sortable-list instead.
- Sorting by computed fields rather than direct manual placement.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Additional class merged onto the `.cinder-kanban-board` root element. |
| `collapsible` | `boolean` | no | `false` | When true, each column renders a collapse/expand button that toggles its card list. |
| `label` | `string` | no | — | Accessible label applied to the board's `<section>` root via `aria-label`. |
| `reorderColumns` | `boolean` | no | `true` | When true (default), columns can be reordered by dragging or keyboard. Set to false to make column order fixed. |
| `card` | `(opaque)` | no | — | Replaces the card's whole body. Leave it out to use the built-in layout: the card's title (its `getCardLabel` text) on top, then one quiet row of `cardMeta` with `cardTrailing` at its inline end. When `card` is set, `cardMeta` and `cardTrailing` are not drawn. Not expressible in JSON Schema; see the component types for the signature. |
| `cardMeta` | `(opaque)` | no | — | The built-in card's quiet row under the title, such as an assignee's avatar and full name. It draws in muted text at the inline start of the row. Not expressible in JSON Schema; see the component types for the signature. |
| `cardTrailing` | `(opaque)` | no | — | The built-in card's inline-end item on the meta row, such as a priority badge. Not expressible in JSON Schema; see the component types for the signature. |
| `columnActions` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `columnHeader` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `columns` | `(opaque)` | yes | — | A prop whose shape is not captured by the JSON schema; see the component types for the exact signature. |
| `emptyColumn` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `getCardKey` | `(opaque)` | yes | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `getCardLabel` | `(opaque)` | yes | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onColumnsChange` | `(opaque)` | yes | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

- `--cinder-kanban-board-scroll-edge`
- `--cinder-kanban-card-background`
- `--cinder-kanban-column-background`
- `--cinder-kanban-column-gap`
- `--cinder-kanban-column-width`

<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
