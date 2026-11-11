<script lang="ts" module>
  export const title = 'An offline page with old data at full contrast';
  export const description =
    'The offline banner sits over the page, the old data keeps full text contrast (no opacity), and only the controls marked mutating go inert: the header +, Edit and the approval card’s Approve and Deny. Reading, Export and links stay live.';
</script>

<script lang="ts">
  import { ApprovalCard, Banner, Button, PageHeader, StaleRegion } from '@lostgradient/cinder';

  const loadedAt = new Date(Date.now() - 120_000);
  const card = {
    tool: { name: 'Issue refund', risk: 'medium' as const },
    sandbox: { provider: 'codex', name: 'workspace-write', workingDir: '/workspace' },
    operation: {
      kind: 'command' as const,
      command: 'Runs with, 3 fields',
      filesTouched: [],
      argsPreview: {},
    },
    env: [],
    snapshotId: 'snapshot-1',
    policyVersion: 'policy-1',
    idempotencyKey: 'key-1',
    state: 'pending' as const,
  };
</script>

<div class="example-preview-column" style="gap: var(--cinder-space-3)">
  <Banner
    preset="offline"
    dataUpdatedAt={loadedAt}
    timeZone="America/Chicago"
    onRetry={() => {}}
    consequence="Start run is off until you’re back."
  />
  <StaleRegion reason="Off until you’re back.">
    <div style="inline-size: 100%">
      <PageHeader
        headingLevel={2}
        title="Runs"
        description="Today, Monday, Nov 2"
        createAction={{ label: 'Start run' }}
      >
        {#snippet actions()}
          <Button variant="secondary" mutating label="Edit" />
          <Button variant="secondary" label="Export" />
        {/snippet}
      </PageHeader>
      <ul
        style="margin: 0; padding: 0; list-style: none; display: grid; gap: var(--cinder-space-2)"
      >
        <li>Waiting on you, Refund order 4471, 10:42 AM</li>
        <li>Done, Refund order 4472, 10:30 AM</li>
        <li>Waiting on you, Ship the release notes fix, 9:46 AM</li>
      </ul>
      <ApprovalCard {...card} onResolve={() => {}} />
    </div>
  </StaleRegion>
</div>
