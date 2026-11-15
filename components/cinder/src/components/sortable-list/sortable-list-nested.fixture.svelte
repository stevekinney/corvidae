<script lang="ts">
  import SortableList from './sortable-list.svelte';

  type Step = { id: string; title: string; children: Step[] };

  // The outer list's last row holds a list of its own: its rows have move buttons too.
  // svelte-ignore state_referenced_locally
  let steps = $state<Step[]>([
    { id: 'first', title: 'First', children: [] },
    {
      id: 'second',
      title: 'Second',
      children: [
        { id: 'inner-a', title: 'Inner A', children: [] },
        { id: 'inner-b', title: 'Inner B', children: [] },
      ],
    },
  ]);
</script>

{#snippet list(items: Step[], onChange: (next: Step[]) => void, label: string)}
  <SortableList
    {items}
    getKey={(step) => step.id}
    getItemLabel={(step) => step.title}
    onReorder={onChange}
    reorderMode="buttons"
    {label}
  >
    {#snippet children(step, context)}
      <div>
        <span data-step-title>{step.title}</span>
        {@render context.moveButtons?.()}
        {#if step.children.length > 0}
          {@render list(
            step.children,
            (next) => (step.children = next),
            `Steps inside ${step.title}`,
          )}
        {/if}
      </div>
    {/snippet}
  </SortableList>
{/snippet}

{@render list(steps, (next) => (steps = next), 'Steps')}
