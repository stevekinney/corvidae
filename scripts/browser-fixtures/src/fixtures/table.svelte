<script lang="ts">
  import {
    Badge,
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

  // COR-2769: the Connection checks shape, a Result badge and a sentence of about 120 characters.
  const fitColumns = new URLSearchParams(globalThis.location.search).has('fitColumns');
  const connectionChecks = [
    {
      check: 'Frontend',
      result: 'Passed',
      tone: 'success',
      found:
        'The frontend answered on port 7233 within a second and listed every namespace the worker is configured to poll.',
    },
    {
      check: 'Namespace access',
      result: 'Not reached',
      tone: 'warning',
      found:
        'The namespace list call timed out after thirty seconds, so the remaining checks for this connection were not run.',
    },
    {
      check: 'TLS',
      result: 'Passed',
      tone: 'success',
      found:
        'The certificate is valid until March and its name matches the address the worker uses.',
    },
  ] as const;
  /** A name longer than half of any viewport the test uses, which its column must cut at half. */
  const longName = `Workflow ${'very-long-segment-'.repeat(12)}name`;
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

{#if fitColumns}
  <!-- COR-2769: a fit table shaped like the Temporal UI's Connection checks: two short columns
       sized to their content and a prose column that takes the rest. -->
  <div data-testid="fit-columns">
    <Table caption="Connection checks" fit>
      <TableHeader>
        <TableRow>
          <TableHeaderCell sizing="content">Check</TableHeaderCell>
          <TableHeaderCell sizing="content">Result</TableHeaderCell>
          <TableHeaderCell sizing="fill">What it found</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {#each connectionChecks as check (check.check)}
          <TableRow>
            <TableCell as="th">{check.check}</TableCell>
            <TableCell><Badge variant={check.tone}>{check.result}</Badge></TableCell>
            <TableCell>{check.found}</TableCell>
          </TableRow>
        {/each}
      </TableBody>
    </Table>
  </div>
  <!-- A content value longer than half the table, and a truncating value in the fill column. -->
  <div data-testid="fit-columns-long">
    <Table caption="Long values" fit>
      <TableHeader>
        <TableRow>
          <TableHeaderCell sizing="content">Name</TableHeaderCell>
          <TableHeaderCell sizing="fill">Key</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell>{longName}</TableCell>
          <TableCell truncate>{longKey}</TableCell>
        </TableRow>
      </TableBody>
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
