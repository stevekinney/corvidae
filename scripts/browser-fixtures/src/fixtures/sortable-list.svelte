<script lang="ts">
  import { SortableList } from '@corvidae/cinder';
  import type { SortableListProps } from '@corvidae/cinder';
  type Task = { id: string; label: string };
  let items = $state<Task[]>([
    { id: 'task-1', label: 'Write release notes' },
    { id: 'task-2', label: 'Review pull requests' },
    { id: 'task-3', label: 'Update dependencies' },
  ]);
  const getKey = (item: Task) => item.id;
  const getItemLabel = (item: Task) => item.label;
  const handleReorder: SortableListProps<Task>['onReorder'] = (nextItems) => {
    items = nextItems;
  };
</script>

<div id="example-mount-basic">
  <SortableList {items} {getKey} {getItemLabel} onReorder={handleReorder} label="Task priority">
    {#snippet children(item)}<span style="padding: 0.5rem 0.75rem; display: block;"
        >{item.label}</span
      >{/snippet}
  </SortableList>
  <div class="cinder-kanban-board__card">Kanban</div>
</div>

<style>
  .cinder-kanban-board__card {
    display: flex;
    align-items: start;
  }
</style>
