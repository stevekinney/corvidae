# SortableList

Drag-and-drop reorderable list that emits the new order on each change.

## Usage

```svelte
<script lang="ts">
  import { SortableList } from '@lostgradient/cinder';
  import type { SortableListProps } from '@lostgradient/cinder';

  type Task = { id: string; label: string };

  let items = $state<Task[]>([
    { id: 'task-1', label: 'Write release notes' },
    { id: 'task-2', label: 'Review pull requests' },
    { id: 'task-3', label: 'Update dependencies' },
    { id: 'task-4', label: 'Deploy to staging' },
  ]);

  function getKey(item: Task): string {
    return item.id;
  }

  function getItemLabel(item: Task, _originalIndex: number): string {
    return item.label;
  }

  // `onReorder` receives the reordered items AND a `change` descriptor (from/to
  // indices, moved key). This example only needs the new order, but the full
  // signature is shown so the canonical call shape is accurate.
  const handleReorder: SortableListProps<Task>['onReorder'] = (nextItems, _change) => {
    items = nextItems;
  };
</script>

<SortableList {items} {getKey} {getItemLabel} onReorder={handleReorder} label="Task priority">
  {#snippet children(item, _context)}
    <span style="padding: 0.5rem 0.75rem; display: block;">{item.label}</span>
  {/snippet}
</SortableList>
```

## Move buttons

Dragging needs a pointer that can hold and move, so a list that people reorder should offer a single-pointer alternative (WCAG 2.5.7). Set `reorderMode="buttons"` to give each row Move up and Move down buttons in place of the drag handle, or `reorderMode="both"` to keep the handle and add them. The row's context then carries a `moveButtons` snippet; render it where the buttons belong, beside the row's own controls. The first row has no Move up, the last no Move down, and a lone row has neither. Pressing a button reorders through `onReorder` with the same change descriptor a drop gives, announces the move, and keeps focus on the pressed button, or on the row's other button when the pressed one no longer applies. `formatMoveUpLabel` and `formatMoveDownLabel` rename the buttons ("Move Ask an agent up").

```svelte
<script lang="ts">
  import { Button, SortableList } from '@lostgradient/cinder';

  let steps = $state([
    { id: 'ask', title: 'Ask an agent' },
    { id: 'wait', title: 'Wait for a person' },
  ]);
</script>

<SortableList
  items={steps}
  getKey={(step) => step.id}
  getItemLabel={(step) => step.title}
  onReorder={(next) => (steps = next)}
  reorderMode="buttons"
  label="Steps"
>
  {#snippet children(step, context)}
    <div style="display: flex; align-items: center; gap: 0.5rem;">
      <span style="flex: 1;">{step.title}</span>
      {@render context.moveButtons?.()}
      <Button
        size="sm"
        variant="secondary"
        aria-label={`Delete ${step.title}`}
        onclick={() => (steps = steps.filter((existing) => existing.id !== step.id))}
      >
        Delete
      </Button>
    </div>
  {/snippet}
</SortableList>
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Additional class merged onto the `.cinder-sortable-list` root element. |
| `label` | `string` | no | — | Accessible name for the list (applied as aria-label on the list root). |
| `reorderMode` | `"handle"` \| `"buttons"` \| `"both"` | no | `"handle"` | How a row is reordered; see `SortableReorderMode`. With `buttons` or `both` the row's context carries a `moveButtons` snippet, which the row content renders where the buttons belong. |
| `announcements` | `(opaque)` | no | — | Optional overrides for announcement strings. Not expressible in JSON Schema; see the component types for the signature. |
| `children` | `(opaque)` | yes | — | Row content snippet. Receives the item and a per-row context. Not expressible in JSON Schema; see the component types for the signature. |
| `formatHandleLabel` | `(opaque)` | no | — | Optional formatter for the drag handle's accessible name. Default: "Reorder {itemLabel}". Not expressible in JSON Schema; see the component types for the signature. |
| `formatMoveDownLabel` | `(opaque)` | no | — | Optional formatter for the Move down button's accessible name. Default: "Move {itemLabel} down". Not expressible in JSON Schema; see the component types for the signature. |
| `formatMoveUpLabel` | `(opaque)` | no | — | Optional formatter for the Move up button's accessible name. Default: "Move {itemLabel} up". Not expressible in JSON Schema; see the component types for the signature. |
| `getItemLabel` | `(opaque)` | yes | — | Returns an accessible label for each item (e.g., "Buy milk"). The second argument is the item's original index in the `items` array (not its current visual position during a drag). Used in handle aria-label and announcements. Not expressible in JSON Schema; see the component types for the signature. |
| `getKey` | `(opaque)` | yes | — | Returns a stable key for each item. Must not change across reorders. Not expressible in JSON Schema; see the component types for the signature. |
| `handle` | `(opaque)` | no | — | Optional snippet rendered inside the drag-handle button. Receives { pressed, label }. Not expressible in JSON Schema; see the component types for the signature. |
| `items` | `(opaque)` | yes | — | The list of items to render. Not expressible in JSON Schema; see the component types for the signature. |
| `onReorder` | `(opaque)` | yes | — | Fires with the full reordered array and change metadata on drop. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
