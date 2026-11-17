<script lang="ts" module>
  export type {
    StatisticGroupColumns,
    StatisticGroupProps,
    StatisticGroupVariant,
  } from './statistic-group.types.ts';
</script>

<script lang="ts">
  import type { StatisticGroupProps } from './statistic-group.types.ts';
  import { classNames } from '@lostgradient/foundation/utilities/class-names.ts';

  let {
    columns = 'auto',
    variant = 'default',
    edge = 'border',
    children,
    class: customClassName,
    label,
    role,
    'aria-label': ariaLabel,
    ...rest
  }: StatisticGroupProps = $props();

  const groupRole = $derived(label ? 'group' : role);
  const groupAriaLabel = $derived(label || ariaLabel);
</script>

<!--
  The root is the query container and the grid is its child. An element is
  never its own container -- a container query resolves against the nearest
  ANCESTOR container -- so with `container-type` on the grid itself the
  collapse rules could never fire for a standalone group (CIN-499). The
  container sits on the public root rather than on an extra wrapper around it
  so that `class`, `style`, and `...rest` land on the element the queries
  measure: a consumer that constrains the group's inline size constrains
  exactly what collapses.
-->
<div
  {...rest}
  role={groupRole}
  aria-label={groupAriaLabel}
  class={classNames('cinder-statistic-group', customClassName)}
  data-cinder-variant={variant}
  data-cinder-edge={variant === 'cards' && edge === 'shadow' ? 'shadow' : undefined}
  data-cinder-columns={String(columns)}
>
  <div class="cinder-statistic-group__grid">
    {@render children()}
  </div>
</div>
