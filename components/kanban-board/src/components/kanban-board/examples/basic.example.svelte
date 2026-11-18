<script lang="ts" module>
  export const title = 'Project board';
  export const description =
    'Move work items between columns, reorder columns, and collapse quiet lanes. Each card shows its title, then its assignee and priority on one quiet row.';
  export const component = 'kanban-board';
</script>

<script lang="ts">
  import { Avatar } from '@lostgradient/avatar';
  import { Badge } from '@lostgradient/badge';
  import { KanbanBoard, type KanbanBoardColumn } from '@lostgradient/kanban-board';

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
