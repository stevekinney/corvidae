<script lang="ts" module>
  export const title = 'Unavailable approval';
  export const description =
    'A held approval nobody can answer now shows a neutral word and the reason, with no decision buttons.';
</script>

<script lang="ts">
  import { ApprovalCard } from '@lostgradient/cinder';
</script>

<ApprovalCard
  layout="row"
  question="Publish notes for 2.4?"
  tool={{ name: 'publish-notes', label: 'Publish notes', risk: 'medium' }}
  source="Release helper"
  requestedAt="2026-11-02T10:30:00.000Z"
  now={new Date('2026-11-02T10:42:00.000Z')}
  operation={{ kind: 'other', argsPreview: { version: '2.4', changes: 12 } }}
  policyVersion="policy-2026-06"
  idempotencyKey="approval-row-03"
  state="unavailable"
  unavailableReason="Release helper is unavailable, so this can't be answered now. It returns when the Demo plugin is enabled."
/>
