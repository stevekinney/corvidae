<script lang="ts">
  import { ApprovalCard } from '@lostgradient/cinder';
</script>

<!-- The decision layout's states come first, so the screenshot, which is one viewport tall, holds
     them at every width. -->

<!-- A decision card with a command and a far deadline (COR-2288, COR-2440 AC12): on a narrow card
     its status sits above the title, and the command panel is inset to the card's text column. -->
<ApprovalCard
  id="approval-card-decision-command"
  layout="decision"
  headingLevel={4}
  question="Run the release script?"
  tool={{ name: 'release', label: 'Release', risk: 'high', irreversible: true }}
  operation={{ kind: 'command', command: 'bun run release --channel stable --tag 2026.11.17' }}
  expiresAt="2099-06-30T14:30:00.000Z"
  policyVersion="policy-2026-06"
  idempotencyKey="approval-decision-command-01"
  state="pending"
  onResolve={() => undefined}
/>

<!-- An approval that expired before a decision (COR-2280 A7): a quiet dashed neutral row with Ask
     again. -->
<ApprovalCard
  id="approval-card-decision-expired"
  layout="decision"
  headingLevel={4}
  question="Refund order 4398 for $18.50?"
  tool={{ name: 'issue-refund', label: 'Issue refund', risk: 'high' }}
  operation={{ kind: 'other', argsPreview: { orderId: 4398 } }}
  expiresAt="2026-11-02T10:15:00.000Z"
  policyVersion="policy-2026-06"
  idempotencyKey="approval-decision-expired-01"
  state="expired"
  onAskAgain={() => undefined}
/>

<!-- A settled receipt (COR-2440 A4): one row at 30rem and wider, its note, result and command one
     definition list a disclosure away. -->
<ApprovalCard
  id="approval-card-decision-receipt"
  layout="decision"
  headingLevel={4}
  question="Refund order 4471 for $42.00?"
  tool={{ name: 'issue-refund', label: 'Issue refund', risk: 'high' }}
  approveLabel="Refund $42.00"
  operation={{ kind: 'command', command: 'refund --order 4471 --amount 42.00' }}
  policyVersion="policy-2026-06"
  idempotencyKey="approval-decision-receipt-01"
  state="approved"
  decidedBy="Priya Raman"
  decidedAt="2026-11-02T10:46:00.000Z"
  decidedIn="Reviews"
  decidedInHref="#reviews"
  decisionNote="Checked the order first."
  result="Refunded $42.00 to the original card."
/>

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
