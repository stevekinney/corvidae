<script lang="ts" module>
  import type { HTMLAttributes } from 'svelte/elements';

  export type ToolbarSeparatorProps = Omit<HTMLAttributes<HTMLDivElement>, 'class'> & {
    class?: string;
  };
</script>

<script lang="ts">
  import { classNames } from '../../../utilities/class-names.ts';

  let { class: className, ...rest }: ToolbarSeparatorProps = $props();
</script>

<div
  class={classNames('toolbar-separator', className)}
  role="separator"
  aria-orientation="vertical"
  aria-hidden="true"
  {...rest}
></div>

<style>
  .toolbar-separator {
    width: 1px;
    height: 1rem;
    /* Use --cinder-border (not --cinder-border-muted): a vertical separator
       between control clusters has no row context around it, and the 10%
       muted tier reads as nothing against the raised toolbar surface. */
    background: var(--cinder-border);
    margin-inline: var(--cinder-space-1);
    flex-shrink: 0;
  }
</style>
