<script lang="ts" module>
  export const title = 'Move buttons';
  export const description =
    'reorderMode="buttons" gives each row Move up and Move down buttons in place of the drag handle, the single-pointer alternative to dragging. The row renders them beside its own controls; the first row has no Move up and the last no Move down.';
</script>

<script lang="ts">
  import { Button, SortableList } from '@lostgradient/cinder';

  type Step = { id: string; title: string };

  let steps = $state<Step[]>([
    { id: 'ask', title: 'Ask an agent' },
    { id: 'wait', title: 'Wait for a person' },
    { id: 'send', title: 'Send a message' },
  ]);
</script>

<SortableList
  items={steps}
  getKey={(step) => step.id}
  getItemLabel={(step) => step.title}
  onReorder={(next) => (steps = next)}
  reorderMode="buttons"
  label="Workflow steps"
>
  {#snippet children(step, context)}
    <div style="display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem 0.75rem;">
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
