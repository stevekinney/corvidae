<script lang="ts">
  import {
    Button,
    Card,
    DataTable,
    Table,
    TableBody,
    TableCell,
    TableHeader,
    TableHeaderCell,
    TableRow,
    type TableDensity,
  } from '@lostgradient/cinder';

  const showCurrent = new URLSearchParams(globalThis.location.search).has('current');
  let openContributor = $state('ada');
  const headerTokens = new URLSearchParams(globalThis.location.search).get('header-tokens') === '1';
  const densities = ['comfortable', 'condensed', 'spacious'] as const satisfies TableDensity[];

  const contributors = [
    { name: 'Ada Lovelace', role: 'Mathematician', commits: 142 },
    { name: 'Grace Hopper', role: 'Computer Scientist', commits: 98 },
    { name: 'Alan Turing', role: 'Cryptanalyst', commits: 76 },
  ];

  /** One unbroken 2,000-character value, the length of the longest storage key Interborough shows. */
  const longKey = `storage-key-${'k'.repeat(1988)}`;
  const storedValues = [
    { key: longKey, size: '4 KB' },
    { key: 'settings', size: '1 KB' },
  ];
</script>

{#if headerTokens}
  {#each densities as density (density)}
    <Table caption={`Contributors (${density})`} {density} stickyHeader>
      <TableHeader>
        <TableRow>
          <TableHeaderCell column="name" sortable>Name</TableHeaderCell>
          <TableHeaderCell>Role</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {#each contributors as contributor (contributor.name)}
          <TableRow>
            <TableCell>{contributor.name}</TableCell>
            <TableCell>{contributor.role}</TableCell>
          </TableRow>
        {/each}
        <TableRow>
          <TableCell>Automation</TableCell>
          <TableCell>{longKey}</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  {/each}
{/if}

<div class="table-fixture">
  <Table caption="Recent contributors">
    <TableHeader>
      <TableRow>
        <TableHeaderCell>Name</TableHeaderCell>
        <TableHeaderCell>Role</TableHeaderCell>
        <TableHeaderCell align="right">Commits</TableHeaderCell>
        <TableHeaderCell><span class="cinder-sr-only">Actions</span></TableHeaderCell>
      </TableRow>
    </TableHeader>
    <TableBody>
      {#each contributors as contributor (contributor.name)}
        <TableRow>
          <TableCell>{contributor.name}</TableCell>
          <TableCell>{contributor.role}</TableCell>
          <TableCell align="right">{contributor.commits}</TableCell>
          <TableCell controls="fit">
            <Button aria-label={`View ${contributor.name}`}>View</Button>
          </TableCell>
        </TableRow>
      {/each}
    </TableBody>
  </Table>

  <Table caption="Build history" class="table-fixture-table">
    <TableHeader>
      <TableRow>
        <TableHeaderCell>Name</TableHeaderCell>
        <TableHeaderCell>Role</TableHeaderCell>
        <TableHeaderCell align="right">Commits</TableHeaderCell>
      </TableRow>
    </TableHeader>
    <TableBody>
      {#each contributors as contributor (contributor.name)}
        <TableRow>
          <TableCell>{contributor.name}</TableCell>
          <TableCell>{contributor.role}</TableCell>
          <TableCell align="right">{contributor.commits}</TableCell>
        </TableRow>
      {/each}
    </TableBody>
  </Table>

  <Table caption="Stored values" fit>
    <TableHeader>
      <TableRow>
        <TableHeaderCell>Key</TableHeaderCell>
        <TableHeaderCell align="right">Size</TableHeaderCell>
      </TableRow>
    </TableHeader>
    <TableBody>
      {#each storedValues as stored (stored.key)}
        <TableRow>
          <TableCell truncate>{stored.key}</TableCell>
          <TableCell align="right">{stored.size}</TableCell>
        </TableRow>
      {/each}
    </TableBody>
  </Table>

  <!-- A Table inside a Card (COR-2449): frameless by default, since the card is the frame, and
       beside it the `framed` opt-in that draws the table's own frame within the card. -->
  <div data-testid="table-in-card" class="table-in-card gap-6 margin-block-start-6">
    <div data-testid="table-in-card-flat">
      <Card title="Contributors">
        <Table caption="Contributors in a card">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Name</TableHeaderCell>
              <TableHeaderCell align="right">Commits</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each contributors as contributor (contributor.name)}
              <TableRow>
                <TableCell>{contributor.name}</TableCell>
                <TableCell align="right">{contributor.commits}</TableCell>
              </TableRow>
            {/each}
          </TableBody>
        </Table>
      </Card>
    </div>
    <div data-testid="table-in-card-framed">
      <Card title="Contributors">
        <Table caption="Contributors in a card, framed" framed>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Name</TableHeaderCell>
              <TableHeaderCell align="right">Commits</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each contributors as contributor (contributor.name)}
              <TableRow>
                <TableCell>{contributor.name}</TableCell>
                <TableCell align="right">{contributor.commits}</TableCell>
              </TableRow>
            {/each}
          </TableBody>
        </Table>
      </Card>
    </div>
  </div>
</div>

{#if showCurrent}
  <div data-testid="plain-current">
    <Table aria-label="Current contributor">
      <TableHeader><TableRow><TableHeaderCell>Name</TableHeaderCell></TableRow></TableHeader>
      <TableBody>
        <TableRow current><TableCell>Ada Lovelace</TableCell></TableRow>
        <TableRow><TableCell>Grace Hopper</TableCell></TableRow>
      </TableBody>
    </Table>
  </div>
  <div data-testid="data-open">
    <DataTable
      columns={[{ key: 'name', label: 'Name' }]}
      rows={[{ id: 'ada', name: 'Ada Lovelace' }]}
      openRowId={openContributor}
      onRowOpen={(row) => (openContributor = row.id)}
    />
  </div>
  <div data-testid="stacked-current">
    <Table aria-label="Current contributor at narrow width" fit>
      <TableHeader><TableRow><TableHeaderCell>Name</TableHeaderCell></TableRow></TableHeader>
      <TableBody><TableRow current><TableCell>Ada Lovelace</TableCell></TableRow></TableBody>
    </Table>
  </div>
{/if}

<style>
  .table-fixture {
    max-inline-size: 42rem;
  }

  .table-in-card {
    display: grid;
  }

  :global(.table-fixture-table) {
    min-inline-size: 48rem;
  }
</style>
