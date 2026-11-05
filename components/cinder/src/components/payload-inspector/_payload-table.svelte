<script lang="ts" module>
  /** Props of the internal table writer. Not part of the public API. */
  export type PayloadTableProps = {
    /** The rows: objects that all hold the same keys and only scalar values. */
    rows: Record<string, unknown>[];
    /** Property names from the payload root down to the array. */
    path: string[];
    /** The array's label, which names the table for assistive technology. */
    caption: string;
    /** What the card passes down to every part of the Fields view. */
    options: FieldsOptions;
  };
</script>

<script lang="ts">
  import type { FieldsOptions } from './payload-inspector-model.ts';

  import Button from '../button/button.svelte';
  import { Table } from '../table/index.ts';
  import { formatNumber } from '../../utilities/format-number.ts';
  import { humanizeIdentifier } from '../../utilities/humanize-identifier.ts';
  import { isNumberColumn, isTokenColumn, TABLE_ROW_LIMIT } from './payload-inspector-model.ts';
  import PayloadScalar from './_payload-scalar.svelte';

  let { rows, path, caption, options }: PayloadTableProps = $props();

  /** How many more rows Load more adds once the first page is shown. */
  const LOAD_MORE_STEP = 50;

  let limit = $state(TABLE_ROW_LIMIT);
  const shown = $derived(Math.min(limit, rows.length));

  const columns = $derived(
    Object.keys(rows[0] ?? {}).map((key) => {
      const values = rows.map((row) => row[key]);
      return {
        key,
        label: humanizeIdentifier(key, { casing: 'sentence' }),
        token: isTokenColumn(values),
        numeric: isNumberColumn(values),
      };
    }),
  );
</script>

<div class="cinder-payload-inspector__table">
  <Table {caption} density="condensed" class="cinder-payload-inspector__table-element">
    <Table.Header>
      <Table.Row>
        {#each columns as column (column.key)}
          <Table.HeaderCell align={column.numeric ? 'right' : 'left'}
            >{column.label}</Table.HeaderCell
          >
        {/each}
      </Table.Row>
    </Table.Header>
    <Table.Body>
      {#each rows.slice(0, shown) as row, index (index)}
        <Table.Row>
          {#each columns as column (column.key)}
            <Table.Cell align={column.numeric ? 'right' : 'left'}>
              <span
                class="cinder-payload-inspector__cell"
                data-cinder-token={column.token || undefined}
              >
                <PayloadScalar
                  fieldKey={column.key}
                  value={row[column.key]}
                  path={[...path, String(index + 1), column.key]}
                  {options}
                  compact
                />
              </span>
            </Table.Cell>
          {/each}
        </Table.Row>
      {/each}
    </Table.Body>
  </Table>
  {#if rows.length > shown}
    <p class="cinder-payload-inspector__table-footer">
      <span>Showing {formatNumber(shown)} of {formatNumber(rows.length)}</span>
      <Button variant="secondary" size="sm" onclick={() => (limit = shown + LOAD_MORE_STEP)}
        >Load more</Button
      >
    </p>
  {/if}
</div>
