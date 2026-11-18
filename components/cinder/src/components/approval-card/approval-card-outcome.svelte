<script lang="ts">
  import type { Snippet } from 'svelte';

  /** Props of the internal outcome line. Not part of the public API. */
  type ApprovalCardOutcomeProps = {
    /** What was decided and by whom, such as "Denied by you". */
    outcomeText: string;
    /** When it was decided, such as "10:40 AM". */
    outcomeTime: string | undefined;
    /** Green for an approval, neutral for everything else: a denial is a decision, not an error. */
    tone: 'success' | 'neutral';
    /** Whether the word is led by a dot in its tone. Off where a glyph above already says it. Default `true`. */
    dot?: boolean | undefined;
    /** Content after the outcome and its time, such as where the question was asked ("Tool runner in a chat"). */
    trailing?: Snippet | undefined;
    /** The note the approver left with the decision. */
    decisionNote?: string | undefined;
    /** Where the note went, such as "Sent to the agent as the reason.". */
    decisionNoteCaption?: string | undefined;
  };

  let {
    outcomeText,
    outcomeTime,
    tone,
    dot = true,
    trailing,
    decisionNote,
    decisionNoteCaption,
  }: ApprovalCardOutcomeProps = $props();
</script>

<p class="cinder-approval-card__outcome" data-cinder-tone={tone}>
  <span class="cinder-approval-card__outcome-word">
    {#if dot}<span class="cinder-approval-card__outcome-dot" aria-hidden="true"></span>{/if}
    {outcomeText}
  </span>{#if outcomeTime !== undefined}
    {' '}
    <span class="cinder-approval-card__outcome-time">{outcomeTime}</span>
  {/if}{#if trailing !== undefined}
    {' '}
    <span class="cinder-approval-card__outcome-trailing">{@render trailing()}</span>
  {/if}
</p>
{#if decisionNote !== undefined && decisionNote !== ''}
  <p class="cinder-approval-card__decision-note">
    <span class="cinder-approval-card__decision-note-label">Your note:</span>
    <span class="cinder-approval-card__decision-note-text" dir="auto">{decisionNote}</span>
    {#if decisionNoteCaption !== undefined}
      <span class="cinder-approval-card__decision-note-caption">{decisionNoteCaption}</span>
    {/if}
  </p>
{/if}
