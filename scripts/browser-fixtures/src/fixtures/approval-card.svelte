<script lang="ts">
  import { ApprovalCard } from '@lostgradient/cinder';

  // Keep the default assertion fixture stable; the canceled state is selected only for COR-2554's
  // design capture.
  const showCanceled = new URLSearchParams(globalThis.location.search).get('canceled') === '1';
</script>

<ApprovalCard
  tool={{ name: 'deploy-cloud', risk: 'medium' }}
  sandbox={{
    provider: 'codex',
    name: 'workspace-write',
    workingDir: '/workspace/project',
  }}
  operation={{
    kind: 'command',
    command: 'bun run --filter=@lostgradient/cinder validate',
    filesTouched: ['components/cinder/src/components/approval-card/approval-card.svelte'],
    argsPreview: {
      package: '@lostgradient/cinder',
      dryRun: false,
    },
  }}
  env={['DATABASE_URL', 'OPENAI_API_KEY']}
  snapshotId="snapshot-01JZ8"
  policyVersion="policy-2026-06"
  idempotencyKey="approval-command-01"
  state="pending"
  editableArgs={true}
  onResolve={() => undefined}
/>

{#if showCanceled}
  <ApprovalCard
    id="approval-card-canceled"
    layout="decision"
    headingLevel={4}
    question="Deploy the approved release?"
    tool={{ name: 'deploy-cloud', label: 'Deploy release', risk: 'medium' }}
    operation={{ kind: 'other' }}
    state="cancelled"
  />
{/if}

<!-- The chat's waiting approval (COR-2327): the row layout with three pairs of input, which show
     in the open at the content edge with no Show all. -->
<ApprovalCard
  id="approval-card-row-chat"
  layout="row"
  headingLevel={4}
  question="Refund order 4471 for $42.00?"
  tool={{ name: 'issue-refund', label: 'Issue refund', risk: 'high', irreversible: true }}
  source="Tool runner"
  operation={{
    kind: 'other',
    argsPreview: { orderId: 4471, cents: 4200, reason: 'Arrived damaged' },
  }}
  policyVersion="policy-2026-06"
  idempotencyKey="approval-row-chat-01"
  state="pending"
  onResolve={() => undefined}
/>

<!-- The decision layout with nine pairs: the first four show, then "Show all 9" under them; the long
     reference takes the whole row of the grid. -->
<ApprovalCard
  id="approval-card-decision-long"
  layout="decision"
  headingLevel={4}
  question="Create the shipping label for order 4471?"
  tool={{ name: 'create-label', label: 'Create label', risk: 'medium' }}
  operation={{
    kind: 'other',
    argsPreview: {
      orderId: 4471,
      carrier: 'Parcel Post',
      reference: 'Replacement for a damaged delivery, sent at no charge to the customer',
      service: 'Ground',
      weightGrams: 1250,
      lengthCentimetres: 30,
      widthCentimetres: 20,
      heightCentimetres: 12,
      insured: true,
    },
  }}
  policyVersion="policy-2026-06"
  idempotencyKey="approval-decision-long-01"
  state="pending"
  onResolve={() => undefined}
/>
