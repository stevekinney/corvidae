<script lang="ts">
  /**
   * One tool approval as a flat row: the question on the left, Deny and Approve on the right, on a
   * tinted band with no border and no card. It is the one decision control of the chat and of a
   * run's page, so both ask the same way. The reviews inbox decides in its own pane
   * (`routes/reviews/approval-pane.svelte`), which adds a note to the agent and allowing the tool
   * for the rest of the chat.
   */
  import { Button } from '@lostgradient/cinder';

  import { CHAT_COPY } from '../../app/copy.ts';
  import IdentifierText from '../identifier-text.svelte';

  interface ApprovalDecisionProps {
    /** What is being asked, ending in a question mark. */
    question: string;
    /** The parts of the question that are identifiers (the tool's name), which are set in monospace. */
    identifiers: readonly string[];
    /** Whether a decision is being sent, which holds both buttons. */
    deciding: boolean;
    onDecide: (decision: 'approve' | 'deny') => void;
    id: string;
  }

  let { question, identifiers, deciding, onDecide, id }: ApprovalDecisionProps = $props();
</script>

<div class="ib-decision" data-kind="approval">
  <p class="ib-decision__question" id={`${id}-question`}>
    <IdentifierText text={question} {identifiers} />
  </p>
  <div class="ib-decision__actions" role="group" aria-labelledby={`${id}-question`}>
    <Button data-changes variant="secondary" disabled={deciding} onclick={() => onDecide('deny')}
      >{CHAT_COPY.deny}</Button
    >
    <Button data-changes variant="primary" disabled={deciding} onclick={() => onDecide('approve')}
      >{CHAT_COPY.approve}</Button
    >
  </div>
</div>
