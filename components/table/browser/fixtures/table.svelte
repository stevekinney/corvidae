<script lang="ts">
  import { default as Button } from '@lostgradient/button/components/button/index.ts';
  import { default as Card } from '@lostgradient/card/components/card/index.ts';
  import { default as TableBody } from '@lostgradient/table/components/table-body/index.ts';
  import { default as TableCell } from '@lostgradient/table/components/table-cell/index.ts';
  import { default as TableHeaderCell } from '@lostgradient/table/components/table-header-cell/index.ts';
  import { default as TableHeader } from '@lostgradient/table/components/table-header/index.ts';
  import { default as TableRow } from '@lostgradient/table/components/table-row/index.ts';
  import { default as Table } from '@lostgradient/table/components/table/index.ts';

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

  <Table caption="Build history" style="min-inline-size: 48rem">
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
  <div data-testid="table-in-card" class="table-in-card">
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

<style>
  .table-fixture {
    max-inline-size: 42rem;
  }

  .table-in-card {
    display: grid;
    gap: 1.5rem;
    margin-block-start: 1.5rem;
  }
</style>
