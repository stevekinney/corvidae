<script lang="ts">
  /** Props of the internal outcome line. Not part of the public API. */
  type ApprovalCardOutcomeProps = {
    /** What was decided and by whom, such as "Denied by you". */
    outcomeText: string;
    /** When it was decided, such as "10:40 AM". */
    outcomeTime: string | undefined;
    /** Green for an approval, neutral for everything else: a denial is a decision, not an error. */
    tone: 'success' | 'neutral';
    /** Text after the outcome, such as where the question was asked ("Tool runner in a chat"). */
    trailing?: string | undefined;
    /** The note the approver left with the decision. */
    decisionNote?: string | undefined;
    /** Where the note went, such as "Sent to the agent as the reason.". */
    decisionNoteCaption?: string | undefined;
  };

  let {
    outcomeText,
    outcomeTime,
    tone,
    trailing,
    decisionNote,
    decisionNoteCaption,
  }: ApprovalCardOutcomeProps = $props();
</script>

<p class="cinder-approval-card__outcome" data-cinder-tone={tone}>
  <span class="cinder-approval-card__outcome-word">
    <span class="cinder-approval-card__outcome-dot" aria-hidden="true"></span>
    {outcomeText}
  </span>
  {#if outcomeTime !== undefined}
    <span class="cinder-approval-card__separator" aria-hidden="true">·</span>
    <span class="cinder-approval-card__outcome-time">{outcomeTime}</span>
  {/if}
  {#if trailing !== undefined}
    <span class="cinder-approval-card__separator" aria-hidden="true">·</span>
    <span class="cinder-approval-card__outcome-trailing">{trailing}</span>
  {/if}
</p>
{#if decisionNote !== undefined && decisionNote !== ''}
  <p class="cinder-approval-card__decision-note">
    <span class="cinder-approval-card__decision-note-label">Your note</span>
    <span class="cinder-approval-card__decision-note-text">{decisionNote}</span>
    {#if decisionNoteCaption !== undefined}
      <span class="cinder-approval-card__decision-note-caption">{decisionNoteCaption}</span>
    {/if}
  </p>
{/if}
