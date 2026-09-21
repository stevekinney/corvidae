<script lang="ts">
  import { ApprovalCard, Card } from '@lostgradient/cinder';

  const tool = { name: 'Shell', risk: 'low' as const };
  const sandbox = { provider: 'Local', name: 'Default', workingDir: '/workspace' };
  const operation = { kind: 'command' as const, command: 'bun test' };
</script>

<div class="card-fixture">
  <section id="example-mount-flush-body">
    <Card title="Flush body" padding="none">
      Body content
      {#snippet footer()}Footer content{/snippet}
    </Card>
  </section>
  <section id="example-mount-approval-card">
    <ApprovalCard
      {tool}
      {sandbox}
      {operation}
      state="pending"
      idempotencyKey="fixture-key"
      policyVersion="v1"
    />
  </section>
</div>

<style>
  .card-fixture {
    display: grid;
    gap: 2rem;
    max-inline-size: 42rem;
  }
</style>
