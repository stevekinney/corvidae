<script lang="ts" module>
  import type { Snippet } from 'svelte';
  import type { HTMLAttributes } from 'svelte/elements';

  export type SortableListEditorRowProps = Omit<HTMLAttributes<HTMLDivElement>, 'children'> & {
    position: number;
    label: string;
    layout?: 'card' | 'row';
    invalid?: boolean;
    actions?: Snippet | undefined;
    children: Snippet;
  };
</script>

<script lang="ts">
  let {
    position,
    label,
    layout = 'card',
    invalid = false,
    actions,
    children,
    class: className,
    ...attributes
  }: SortableListEditorRowProps = $props();
</script>

<div
  {...attributes}
  class={['cinder-sortable-list-editor-row', className]}
  data-cinder-layout={layout}
  data-problem={invalid ? '' : undefined}
>
  <div class="cinder-sortable-list-editor-row__header">
    <span class="cinder-sortable-list-editor-row__position">{position}</span>
    <span class="cinder-sortable-list-editor-row__label">{label}</span>
    {#if actions}
      <span class="cinder-sortable-list-editor-row__actions">{@render actions()}</span>
    {/if}
  </div>
  {@render children()}
</div>
