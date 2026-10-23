<script lang="ts">
  /**
   * One tool approval as a flat row: the question on the left, Deny and Approve on the right, on a
   * tinted band with no border and no card. It is the one decision control, so the chat, the
   * reviews list, and a run's page all ask the same way. With `withNote` the row has an optional
   * note the agent reads when the call is denied (sent as a rejection with that reason).
   */
  import { Button, Input } from '@lostgradient/cinder';

  import { CHAT_COPY, REVIEWS_COPY } from '../../app/copy.ts';

  interface ApprovalDecisionProps {
    /** What is being asked, ending in a question mark. */
    question: string;
    /** Whether a decision is being sent, which holds both buttons. */
    deciding: boolean;
    onDecide: (decision: 'approve' | 'deny', note: string) => void;
    /** Offer a note to the agent with a denial. */
    withNote?: boolean;
    id: string;
  }

  let { question, deciding, onDecide, withNote = false, id }: ApprovalDecisionProps = $props();
  let note = $state('');
</script>

<div class="ib-decision" data-kind="approval">
  <p class="ib-decision__question" id={`${id}-question`}>{question}</p>
  {#if withNote}
    <div class="ib-decision__note">
      <Input
        id={`${id}-note`}
        label={REVIEWS_COPY.noteLabel}
        labelVisible={false}
        placeholder={REVIEWS_COPY.noteLabel}
        bind:value={note}
        disabled={deciding}
      />
    </div>
  {/if}
  <div class="ib-decision__actions" role="group" aria-labelledby={`${id}-question`}>
    <Button
      variant="secondary"
      size="lg"
      disabled={deciding}
      onclick={() => onDecide('deny', note.trim())}>{CHAT_COPY.deny}</Button
    >
    <Button
      variant="primary"
      size="lg"
      disabled={deciding}
      onclick={() => onDecide('approve', note.trim())}>{CHAT_COPY.approve}</Button
    >
  </div>
</div>
