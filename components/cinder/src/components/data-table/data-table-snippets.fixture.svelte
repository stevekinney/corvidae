<script lang="ts">
  import DataTable from './data-table.svelte';
  import type { DataTableCellContext, DataTableProps, DataTableRow } from './data-table.types.ts';

  type FixtureProps = Omit<
    DataTableProps<DataTableRow>,
    'cell' | 'rowMessage' | 'footer' | 'hasRowMessage'
  > & {
    /** Draws every cell through the `cell` snippet, with a checkbox in the `on` column. */
    withCell?: boolean;
    /** Draws a message under the rows whose `failed` is true. */
    withMessage?: boolean;
    /** Draws a footer line. */
    withFooter?: boolean;
  };

  let {
    withCell = false,
    withMessage = false,
    withFooter = false,
    ...rest
  }: FixtureProps = $props();
</script>

{#snippet cell(context: DataTableCellContext<DataTableRow>)}
  {#if context.column.key === 'on'}
    <input type="checkbox" aria-label={`Allow ${context.row['name']}`} checked={!!context.value} />
  {:else}
    {context.value}
  {/if}
{/snippet}

{#snippet rowMessage(context: { row: DataTableRow; index: number })}
  <span role="alert">Couldn’t save {context.row['name']}.</span>
{/snippet}

{#snippet footer()}
  Showing {rest.rows.length} events.
{/snippet}

<DataTable
  {...rest}
  {...withCell ? { cell } : {}}
  {...withMessage
    ? { rowMessage, hasRowMessage: (row: DataTableRow) => row['failed'] === true }
    : {}}
  {...withFooter ? { footer } : {}}
/>
