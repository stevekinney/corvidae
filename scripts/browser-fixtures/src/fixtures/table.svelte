<script lang="ts">
  import {
    Button,
    Table,
    TableBody,
    TableCell,
    TableHeader,
    TableHeaderCell,
    TableRow,
  } from '@lostgradient/cinder';

  const contributors = [
    { name: 'Ada Lovelace', role: 'Mathematician', commits: 142 },
    { name: 'Grace Hopper', role: 'Computer Scientist', commits: 98 },
    { name: 'Alan Turing', role: 'Cryptanalyst', commits: 76 },
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
</div>

<style>
  .table-fixture {
    max-inline-size: 42rem;
  }
</style>
