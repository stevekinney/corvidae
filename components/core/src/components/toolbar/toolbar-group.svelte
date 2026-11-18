<script lang="ts" module>
  export type { ToolbarGroupProps } from './toolbar.types.ts';
</script>

<script lang="ts">
  import type { ToolbarGroupProps } from './toolbar.types.ts';

  import { classNames } from '../../utilities/class-names.ts';

  let { class: className, orientation, children, role, ...rest }: ToolbarGroupProps = $props();

  const normalizedAriaLabel = $derived(
    typeof rest['aria-label'] === 'string' && rest['aria-label'].trim().length > 0
      ? rest['aria-label'].trim()
      : undefined,
  );
  const normalizedAriaLabelledBy = $derived(
    typeof rest['aria-labelledby'] === 'string' && rest['aria-labelledby'].trim().length > 0
      ? rest['aria-labelledby'].trim()
      : undefined,
  );
  const hasAccessibleName = $derived(Boolean(normalizedAriaLabel || normalizedAriaLabelledBy));
</script>

<div
  {...rest}
  aria-label={normalizedAriaLabel}
  aria-labelledby={normalizedAriaLabelledBy}
  role={role ?? (hasAccessibleName ? 'group' : undefined)}
  class={classNames('cinder-toolbar__group', className)}
  data-cinder-toolbar-group=""
  data-cinder-orientation={orientation}
>
  {@render children()}
</div>
