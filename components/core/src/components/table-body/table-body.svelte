<script lang="ts" module>
  export type { TableBodyProps } from './table-body.types.ts';
</script>

<script lang="ts">
  import type { TableBodyProps } from './table-body.types.ts';

  import { setTableSectionContext } from '../table/table.context.ts';
  import { classNames } from '@lostgradient/foundation/utilities/class-names.ts';

  let { class: className, children, ...rest }: TableBodyProps = $props();

  setTableSectionContext('body');
</script>

<tbody {...rest} class={classNames('cinder-table__body', className)}>
  {@render children()}
</tbody>
