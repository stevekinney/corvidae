<script lang="ts">
  import { Button, Breadcrumbs, PageHeader } from '@repo/cinder';
</script>

<div>
  <PageHeader title="Approvals" description="3 pending · 12 resolved" />
</div>

<div style="margin-top: var(--cinder-space-4);">
  <PageHeader>
    {#snippet breadcrumbs()}
      <Breadcrumbs items={[{ label: 'Home', href: '/' }, { label: 'Schedules' }]} />
    {/snippet}
    {#snippet title()}Schedules{/snippet}
    {#snippet description()}Create and manage recurring automation schedules.{/snippet}
    {#snippet actions()}
      <Button variant="primary" size="sm" label="+ New schedule" />
    {/snippet}
  </PageHeader>
</div>
