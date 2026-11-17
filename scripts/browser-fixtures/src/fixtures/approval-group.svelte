<script lang="ts">
  import { ApprovalCard, ApprovalGroup } from '@lostgradient/cinder';
</script>

<!-- A batch of approvals (board row A3): one bordered group under "2 approvals waiting", its rows
     compact ApprovalCards that give up their own border, one separator apart. -->
<div style="max-inline-size: 40rem;">
  <ApprovalGroup id="approval-group-batch" heading="2 approvals waiting">
    <div>
      <ApprovalCard
        layout="row"
        headingLevel={4}
        question="Refund order 4471 for $42.00?"
        tool={{ name: 'issue-refund', label: 'Issue refund', risk: 'high', irreversible: true }}
        source="Tool runner"
        operation={{ kind: 'other', argsPreview: { orderId: 4471, cents: 4200 } }}
        policyVersion="policy-2026-06"
        idempotencyKey="approval-group-refund"
        state="pending"
        onResolve={() => undefined}
      />
    </div>
    <div>
      <ApprovalCard
        layout="row"
        headingLevel={4}
        question="Email the customer about order 4471?"
        tool={{ name: 'send-email', label: 'Send email', risk: 'medium' }}
        source="Tool runner"
        operation={{ kind: 'other', argsPreview: { orderId: 4471, template: 'refund-issued' } }}
        policyVersion="policy-2026-06"
        idempotencyKey="approval-group-email"
        state="pending"
        onResolve={() => undefined}
      />
    </div>
  </ApprovalGroup>
</div>
