<script lang="ts">
  /**
   * The tool approvals a run is waiting on, as one warning alert above the transcript with Deny and
   * Approve inside it. The conversation holds each approval as a result row parked on
   * `action_required`, and Chat's own card for it is left out of the transcript
   * (`chat-conversation.svelte`), so there is one place to decide.
   */
  import { Alert, Button } from '@lostgradient/cinder';

  import { CHAT_COPY } from '../../app/copy.ts';

  interface PendingApproval {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly message: string | undefined;
  }

  interface ApprovalAlertProps {
    approvals: readonly PendingApproval[];
    /** Whether a decision is being sent, which holds both buttons. */
    deciding: boolean;
    onDecide: (toolCallId: string, decision: 'approve' | 'deny') => void;
  }

  let { approvals, deciding, onDecide }: ApprovalAlertProps = $props();
</script>

{#each approvals as approval (approval.toolCallId)}
  <Alert variant="warning" class="weft-chat-approval" data-tool-call={approval.toolCallId}>
    <p class="weft-chat-approval__title">
      {CHAT_COPY.approvalTitle}: <code>{approval.toolName}</code>
    </p>
    {#if approval.message}
      <p class="weft-chat-approval__message">{approval.message}</p>
    {/if}
    <div class="weft-chat-approval__actions">
      <Button
        variant="secondary"
        size="sm"
        disabled={deciding}
        onclick={() => onDecide(approval.toolCallId, 'deny')}>{CHAT_COPY.deny}</Button
      >
      <Button
        variant="primary"
        size="sm"
        disabled={deciding}
        onclick={() => onDecide(approval.toolCallId, 'approve')}>{CHAT_COPY.approve}</Button
      >
    </div>
  </Alert>
{/each}
