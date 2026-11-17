<script lang="ts" module>
  export const title = 'Question answered somewhere else';
  export const description =
    'A question answered in Reviews while the page is open reads the same as an approval: "Answered by you in Reviews" with the time, then the question and what happened. Nothing is left to answer here.';
</script>

<script lang="ts">
  import { ApprovalCard } from '@lostgradient/cinder';
</script>

<ApprovalCard
  question="Which environment should the release go to?"
  source="Tool runner"
  tool={{ name: 'ask-user', label: 'Ask a question', risk: 'low' }}
  operation={{ kind: 'other' }}
  policyVersion="policy-2026-06"
  idempotencyKey="card-answered-elsewhere"
  state="approved"
  outcomeLabel="Answered"
  decidedBy="you"
  decidedIn="Reviews"
  decidedAt="2026-11-02T10:44:00.000Z"
  notice="The run is continuing, so this page changed. You don't need to do anything here."
/>
