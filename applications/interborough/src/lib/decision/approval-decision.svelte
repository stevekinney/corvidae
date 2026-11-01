<script lang="ts">
  /**
   * One tool approval as a single row, 40px high: a mark, the question, a Show input icon button
   * when the call was given input, then Deny and Approve. The reply above it already explains the
   * request, so the row repeats nothing of it. It is the one decision control of the chat and of a
   * run's page, so both ask the same way. A host that can grant the tool for the rest of the chat
   * (`onAllowForChat`) adds that choice as a third button; the reviews inbox decides in its own
   * pane (`routes/reviews/approval-pane.svelte`), which also takes a note to the agent.
   */
  import { Button } from '@lostgradient/cinder';
  import { ShieldQuestion, SquareTerminal } from '@lucide/svelte';

  import { CHAT_COPY, REVIEWS_COPY } from '../../app/copy.ts';
  import IdentifierText from '../identifier-text.svelte';

  interface ApprovalDecisionProps {
    /** What is being asked, ending in a question mark. */
    question: string;
    /** The parts of the question that are identifiers (the tool's name), which are set in monospace. */
    identifiers: readonly string[];
    /** Whether a decision is being sent, which holds every button. */
    deciding: boolean;
    onDecide: (decision: 'approve' | 'deny') => void;
    /**
     * Approves and allows the tool for the rest of the chat. Omitted by a host that cannot, and the
     * button is not drawn then; `canAllowForChat` holds it while the host is still finding out how.
     */
    onAllowForChat?: (() => void) | undefined;
    /** Whether the grant can be sent yet. Its button is shown but held until it can. */
    canAllowForChat?: boolean;
    /** What the call was given, as name and value pairs. With none, there is no Show input button. */
    input?: readonly (readonly [string, string])[] | undefined;
    id: string;
  }

  let {
    question,
    identifiers,
    deciding,
    onDecide,
    onAllowForChat,
    canAllowForChat = true,
    input = [],
    id,
  }: ApprovalDecisionProps = $props();

  let inputOpen = $state(false);
</script>

<div class="ib-decision" data-kind="approval">
  <div class="ib-decision__row">
    <span class="ib-decision__mark" aria-hidden="true"><ShieldQuestion size={16} /></span>
    <p class="ib-decision__question" id={`${id}-question`}>
      <IdentifierText text={question} {identifiers} />
    </p>
    <div class="ib-decision__actions" role="group" aria-labelledby={`${id}-question`}>
      {#if input.length > 0}
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          label={inputOpen ? CHAT_COPY.hideInput : CHAT_COPY.showInput}
          aria-expanded={inputOpen}
          aria-controls={`${id}-input`}
          onclick={() => (inputOpen = !inputOpen)}
        >
          <SquareTerminal aria-hidden="true" size={16} />
        </Button>
      {/if}
      {#if onAllowForChat !== undefined}
        <Button
          data-changes
          variant="ghost"
          size="sm"
          disabled={deciding || !canAllowForChat}
          onclick={() => onAllowForChat()}>{REVIEWS_COPY.allowForChat}</Button
        >
      {/if}
      <Button
        data-changes
        variant="secondary"
        size="sm"
        disabled={deciding}
        onclick={() => onDecide('deny')}>{CHAT_COPY.deny}</Button
      >
      <Button
        data-changes
        variant="primary"
        size="sm"
        disabled={deciding}
        onclick={() => onDecide('approve')}>{CHAT_COPY.approve}</Button
      >
    </div>
  </div>
  {#if inputOpen && input.length > 0}
    <dl class="ib-decision__input" id={`${id}-input`}>
      {#each input as [key, value] (key)}
        <dt>{key}</dt>
        <dd>{value}</dd>
      {/each}
    </dl>
  {/if}
</div>
