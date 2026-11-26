<script lang="ts">
  /**
   * COR-2760: a page heading above a stacked `fit` Table (one current row, one linked row) and a
   * default DescriptionList (one linked row). The rows of both lists start on the heading's edge.
   * `stackBelow` is set past any viewport, so the table draws its cards at every width.
   */
  import {
    DescriptionList,
    Table,
    TableBody,
    TableCell,
    TableHeader,
    TableHeaderCell,
    TableRow,
  } from '@lostgradient/cinder';

  const runs = [
    {
      name: 'Nightly import',
      status: 'Running',
      started: '2m ago',
      current: true,
      href: undefined,
    },
    {
      name: 'Refund order 4471',
      status: 'Waiting',
      started: '9m ago',
      current: false,
      href: '#run-4471',
    },
    { name: 'Daily summary', status: 'Done', started: '1h ago', current: false, href: undefined },
  ];

  const facts = [
    { term: 'Workflow', definition: 'Refund order 4471', href: '#workflow' },
    { term: 'Owner', definition: 'Ada Lovelace' },
    { term: 'Started', definition: '9 minutes ago' },
  ];
</script>

<main data-testid="page" style="padding: 24px; display: grid; gap: 24px;">
  <h1 data-testid="heading" style="margin: 0;">Runs</h1>
  <div data-testid="table">
    <Table caption="Runs" fit stackBelow="4000px">
      <TableHeader>
        <TableRow>
          <TableHeaderCell>Run</TableHeaderCell>
          <TableHeaderCell>Status</TableHeaderCell>
          <TableHeaderCell>Started</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {#each runs as run (run.name)}
          <TableRow current={run.current}>
            <TableCell as="th">
              {#if run.href}<a href={run.href}>{run.name}</a>{:else}{run.name}{/if}
            </TableCell>
            <TableCell stack="status">{run.status}</TableCell>
            <TableCell stack="end">{run.started}</TableCell>
          </TableRow>
        {/each}
      </TableBody>
    </Table>
  </div>
  <div data-testid="description-list">
    <DescriptionList items={facts} />
  </div>
</main>
