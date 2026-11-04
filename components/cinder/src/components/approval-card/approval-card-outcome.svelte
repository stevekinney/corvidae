<script lang="ts">
  /** Props of the internal outcome line. Not part of the public API. */
  type ApprovalCardOutcomeProps = {
    /** What was decided and by whom, such as "Denied by you". */
    outcomeText: string;
    /** When it was decided, such as "10:40 AM". */
    outcomeTime: string | undefined;
  };

  let { outcomeText, outcomeTime }: ApprovalCardOutcomeProps = $props();
</script>

<p class="cinder-approval-card__outcome">
  <span class="cinder-approval-card__outcome-word">
    <span class="cinder-approval-card__outcome-dot" aria-hidden="true"></span>
    {outcomeText}
  </span>
  {#if outcomeTime !== undefined}
    <span class="cinder-approval-card__separator" aria-hidden="true">·</span>
    <span class="cinder-approval-card__outcome-time">{outcomeTime}</span>
  {/if}
</p>
