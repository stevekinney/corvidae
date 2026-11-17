<script lang="ts">
  import Button from '../button/button.svelte';
  import SortableList from './sortable-list.svelte';
  import type { SortableListProps, SortableReorderChange } from './sortable-list.types.ts';

  type Step = { id: string; title: string };

  let {
    reorderMode = 'buttons',
    formatMoveUpLabel,
    initial = ['Ask an agent', 'Wait for a person', 'Send a message'],
    onChange,
    applyAfterTick = false,
  }: {
    reorderMode?: SortableListProps<Step>['reorderMode'];
    formatMoveUpLabel?: SortableListProps<Step>['formatMoveUpLabel'];
    initial?: string[];
    onChange?: (change: SortableReorderChange, titles: string[]) => void;
    /** Apply the new order a tick after `onReorder` returns, as a consumer that saves first would. */
    applyAfterTick?: boolean;
  } = $props();

  // The initial titles seed the list once; the list then owns its order.
  // svelte-ignore state_referenced_locally
  let steps = $state<Step[]>(initial.map((title, index) => ({ id: `step-${index}`, title })));
  let removed = $state<string[]>([]);

  function handleReorder(next: Step[], change: SortableReorderChange): void {
    onChange?.(
      change,
      next.map((step) => step.title),
    );
    if (applyAfterTick) void Promise.resolve().then(() => (steps = next));
    else steps = next;
  }
</script>

<SortableList
  items={steps}
  getKey={(step) => step.id}
  getItemLabel={(step) => step.title}
  onReorder={handleReorder}
  {reorderMode}
  {...formatMoveUpLabel ? { formatMoveUpLabel } : {}}
  label="Steps"
>
  {#snippet children(step, context)}
    <div class="fixture-step">
      <span data-step-title>{step.title}</span>
      {@render context.moveButtons?.()}
      <Button
        iconOnly
        size="sm"
        variant="secondary"
        aria-label={`Delete ${step.title}`}
        onclick={() => {
          removed = [...removed, step.title];
          steps = steps.filter((existing) => existing.id !== step.id);
        }}>x</Button
      >
    </div>
  {/snippet}
</SortableList>
<output data-testid="removed">{removed.join(',')}</output>
