<script lang="ts">
  /**
   * COR-2771: Table's first paint. Rendered twice by `table-first-paint.playwright.ts`: on the server
   * with JavaScript off, and by the fixture host after hydration. It reads no browser global, so
   * the server can render it.
   *
   * - A `fit` table in the shape of the Temporal UI's Namespaces table.
   * - A loading table of Skeleton cells under the same header (the Temporal UI's StateGate shape).
   * - A table whose cells hold a control.
   * - A sortable `fit` table, hand-composed and as a DataTable: the stacked sort control.
   * - The same `fit` table in a 320px column and in a 900px column: the container decides, not the
   *   window.
   */
  import {
    DataTable,
    type DataTableColumn,
    type TableSort,
    Skeleton,
    Table,
    TableBody,
    TableCell,
    TableHeader,
    TableHeaderCell,
    TableRow,
  } from '@lostgradient/cinder';

  import './table-first-paint.css';

  const namespaces = [
    { name: 'default', state: 'Registered', retention: '3 days', owner: 'Platform team' },
    { name: 'orders', state: 'Registered', retention: '30 days', owner: 'Checkout' },
    { name: 'billing-archive', state: 'Deprecated', retention: '90 days', owner: '' },
  ];
  let sort = $state<TableSort | undefined>(undefined);
  const namespaceRows = namespaces.map((namespace) => ({ id: namespace.name, ...namespace }));
  const dataColumns: DataTableColumn<(typeof namespaceRows)[number]>[] = [
    { key: 'name', label: 'Namespace', sortable: true },
    { key: 'state', label: 'State' },
    { key: 'retention', label: 'Retention', sortable: true },
  ];
  const tools = [
    { name: 'Read files', risk: 'Low' },
    { name: 'Run shell commands', risk: 'High' },
  ];
</script>

{#snippet namespaceTable(caption: string)}
  <Table {caption} fit>
    <TableHeader>
      <TableRow>
        <TableHeaderCell label="Namespace">Namespace</TableHeaderCell>
        <TableHeaderCell label="State">State</TableHeaderCell>
        <TableHeaderCell label="Retention">Retention</TableHeaderCell>
        <TableHeaderCell label="Owner">Owner</TableHeaderCell>
      </TableRow>
    </TableHeader>
    <TableBody>
      {#each namespaces as namespace (namespace.name)}
        <TableRow>
          <TableCell as="th">{namespace.name}</TableCell>
          <TableCell stack="status">{namespace.state}</TableCell>
          <TableCell>{namespace.retention}</TableCell>
          <TableCell>
            {#if namespace.owner}{namespace.owner}{/if}
          </TableCell>
        </TableRow>
      {/each}
    </TableBody>
  </Table>
{/snippet}

<main class="first-paint-page">
  <section data-testid="namespaces">
    {@render namespaceTable('Namespaces')}
  </section>

  <section data-testid="loading">
    <Table caption="Namespaces, loading" fit>
      <TableHeader>
        <TableRow>
          <TableHeaderCell label="Namespace">Namespace</TableHeaderCell>
          <TableHeaderCell label="State">State</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {#each [1, 2, 3] as row (row)}
          <TableRow>
            <TableCell as="th"><Skeleton width="8rem" height="1rem" /></TableCell>
            <!-- A skeleton row takes the loaded row's `stack` roles, so its lines match. -->
            <TableCell stack="status"><Skeleton width="5rem" height="1rem" /></TableCell>
          </TableRow>
        {/each}
      </TableBody>
    </Table>
  </section>

  <section data-testid="controls">
    <Table caption="Tool access">
      <TableHeader>
        <TableRow>
          <TableHeaderCell label="Tool">Tool</TableHeaderCell>
          <TableHeaderCell label="Risk">Risk</TableHeaderCell>
          <TableHeaderCell label="On">On</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {#each tools as tool (tool.name)}
          <TableRow>
            <TableCell>{tool.name}</TableCell>
            <TableCell>{tool.risk}</TableCell>
            <TableCell controls="fit"
              ><input type="checkbox" aria-label={`Allow ${tool.name}`} /></TableCell
            >
          </TableRow>
        {/each}
      </TableBody>
    </Table>
  </section>

  <section data-testid="sortable">
    <Table caption="Namespaces, sortable" fit sortable bind:sort>
      <TableHeader>
        <TableRow>
          <TableHeaderCell label="Namespace" column="name" sortable>Namespace</TableHeaderCell>
          <TableHeaderCell label="Retention" column="retention" sortable>Retention</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {#each namespaces as namespace (namespace.name)}
          <TableRow>
            <TableCell as="th">{namespace.name}</TableCell>
            <TableCell>{namespace.retention}</TableCell>
          </TableRow>
        {/each}
      </TableBody>
    </Table>
  </section>

  <section data-testid="data-table">
    <DataTable
      caption="Namespaces, as a DataTable"
      columns={dataColumns}
      rows={namespaceRows}
      fit
    />
  </section>

  <div class="first-paint-columns">
    <section class="first-paint-narrow" data-testid="narrow-column">
      {@render namespaceTable('Namespaces in a narrow column')}
    </section>
    <section class="first-paint-wide" data-testid="wide-column">
      {@render namespaceTable('Namespaces in a wide column')}
    </section>
  </div>
</main>
