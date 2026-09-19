<script lang="ts">
  import {
    Alert,
    Button,
    Callout,
    Card,
    Input,
    Surface,
    Table,
    TableBody,
    TableCell,
    TableHeader,
    TableHeaderCell,
    TableRow,
  } from '@corvidae/cinder';
</script>

<main class="theme-surfaces-fixture">
  <section aria-label="Theme controls">
    <Button label="Primary action" variant="primary" data-testid="primary-button" />
    <Button label="Secondary action" variant="secondary" data-testid="secondary-button" />
    <Card title="Theme card">Card content</Card>
    <Input id="theme-input" label="Theme input" value="Theme border" />
  </section>
  <Surface data-testid="surface">Surface content</Surface>
  <Alert variant="danger">Danger alert</Alert>
  <Alert variant="success">Success alert</Alert>
  <Callout variant="danger" title="Danger callout">Danger content</Callout>
  <Callout variant="info" title="Info callout">Info content</Callout>
  <Table caption="Theme table">
    <TableHeader>
      <TableRow>
        <TableHeaderCell>Name</TableHeaderCell>
        <TableHeaderCell>Value</TableHeaderCell>
      </TableRow>
    </TableHeader>
    <TableBody>
      <TableRow>
        <TableCell>Surface</TableCell>
        <TableCell>Layered</TableCell>
      </TableRow>
    </TableBody>
  </Table>
</main>

<style>
  .theme-surfaces-fixture {
    display: grid;
    gap: 1rem;
    max-inline-size: 48rem;
    margin-inline: auto;
  }

  section {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    align-items: center;
  }
</style>
