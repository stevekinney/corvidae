<script lang="ts" module>
  export type { TableBodyProps } from './table-body.types.ts';
</script>

<script lang="ts">
  import type { TableBodyProps } from './table-body.types.ts';

  import { setTableSectionContext, tryGetTableContext } from '../table/table.context.ts';
  import { classNames } from '../../utilities/class-names.ts';

  let { class: className, children, ...rest }: TableBodyProps = $props();

  setTableSectionContext('body');
  const table = tryGetTableContext();
</script>

<!-- A `fit` table's parts carry their table roles in the server's HTML (COR-2771). -->
<tbody
  {...rest}
  {...table?.fit === true ? { role: 'rowgroup' } : {}}
  class={classNames('cinder-table__body', className)}
>
  {@render children()}
</tbody>
