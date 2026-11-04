<script lang="ts" module>
  export const title = 'One Fields and JSON switch for the whole page';
  export const description =
    'The card binds its view, so a page can hold one Fields and JSON choice and hand it to every payload: switching it on one card switches the other too.';
</script>

<script lang="ts">
  import { ApprovalCard } from '@lostgradient/cinder';
  import type { PayloadInspectorView } from '@lostgradient/cinder';

  let view = $state<PayloadInspectorView>('fields');
</script>

<div style="display: grid; gap: 1rem;">
  <ApprovalCard
    bind:view
    question="Refund order 4471 for $42.00?"
    source="Tool runner"
    requestedAt="2026-11-02T10:38:00.000Z"
    now={new Date('2026-11-02T10:42:00.000Z')}
    inputLabel="Runs with"
    tool={{ name: 'issue-refund', label: 'Issue refund', risk: 'high', irreversible: true }}
    operation={{
      kind: 'other',
      argsPreview: { orderId: 4471, amount: '$42.00', reason: 'Arrived damaged' },
    }}
    policyVersion="policy-2026-06"
    idempotencyKey="card-shared-view-1"
    state="pending"
    onResolve={() => undefined}
  />
  <ApprovalCard
    bind:view
    question="Refund order 4472 for $18.50?"
    source="Tool runner"
    requestedAt="2026-11-02T10:39:00.000Z"
    now={new Date('2026-11-02T10:42:00.000Z')}
    inputLabel="Runs with"
    tool={{ name: 'issue-refund', label: 'Issue refund', risk: 'high', irreversible: true }}
    operation={{
      kind: 'other',
      argsPreview: { orderId: 4472, amount: '$18.50', reason: 'Wrong size' },
    }}
    policyVersion="policy-2026-06"
    idempotencyKey="card-shared-view-2"
    state="pending"
    onResolve={() => undefined}
  />
</div>
