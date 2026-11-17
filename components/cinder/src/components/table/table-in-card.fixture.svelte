<script lang="ts" module>
  /** Test-only fixture: a Table inside a Card body, to prove the card's frame is the only one. */
  export type TableInCardFixtureProps = {
    framed?: boolean;
    frameless?: boolean;
    inCard?: boolean;
  };
</script>

<script lang="ts">
  import Card from '../card/card.svelte';
  import TableBody from '../table-body/table-body.svelte';
  import TableCell from '../table-cell/table-cell.svelte';
  import TableHeaderCell from '../table-header-cell/table-header-cell.svelte';
  import TableHeader from '../table-header/table-header.svelte';
  import TableRow from '../table-row/table-row.svelte';
  import Table from './table.svelte';

  let { framed, frameless, inCard = true }: TableInCardFixtureProps = $props();
</script>

{#snippet table()}
  <Table
    caption="Models"
    {...framed === undefined ? {} : { framed }}
    {...frameless === undefined ? {} : { frameless }}
  >
    <TableHeader>
      <TableRow>
        <TableHeaderCell>Name</TableHeaderCell>
      </TableRow>
    </TableHeader>
    <TableBody>
      <TableRow>
        <TableCell>Ada</TableCell>
      </TableRow>
    </TableBody>
  </Table>
{/snippet}

{#if inCard}
  <Card title="Models">
    {@render table()}
  </Card>
{:else}
  {@render table()}
{/if}
