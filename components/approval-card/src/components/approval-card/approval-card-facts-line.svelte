<script lang="ts">
  import Clock from '@lucide/svelte/icons/clock';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';

  import Tooltip from '@lostgradient/tooltip/components/tooltip/tooltip.svelte';

  type ApprovalCardFactsLineProps = {
    /** How long the approval has left, such as "Expires in 30s", or `undefined` when it has no deadline. */
    countdown: string | undefined;
    /**
     * The countdown as a narrow card writes it, such as "Expires Nov 17", so it shares a line with
     * "Can't be undone"; `undefined`, or the same words, when the countdown is already short.
     */
    countdownShort?: string | undefined;
    /** Whether the operation cannot be reversed. */
    irreversible: boolean;
    /** What cannot be undone, said in the warning glyph's tooltip. */
    undoneExplanation: string;
  };

  let { countdown, countdownShort, irreversible, undoneExplanation }: ApprovalCardFactsLineProps =
    $props();

  const shortened = $derived(countdownShort !== undefined && countdownShort !== countdown);
</script>

<!-- The two facts an approver weighs before answering, one small line: when the approval lapses and
     whether it can be undone. Both are plain text, so a screen reader reads them as written; the
     glyphs are decoration and the tooltip repeats what the card already says. A narrow card (its
     own width) writes a deadline more than a day out as the day alone, so the two facts share one
     line on a phone; only one of the two forms is ever drawn, so only one is read. -->
{#if countdown !== undefined || irreversible}
  <p class="cinder-approval-card__facts-line">
    {#if countdown !== undefined}
      <span
        class="cinder-approval-card__facts-line-fact"
        data-cinder-countdown
        data-cinder-shortened={shortened || undefined}
      >
        <Clock size={14} strokeWidth={2} aria-hidden="true" />
        <span class="cinder-approval-card__countdown-full">{countdown}</span>
        {#if shortened}
          <span class="cinder-approval-card__countdown-short">{countdownShort}</span>
        {/if}
      </span>
    {/if}
    {#if irreversible}
      <span class="cinder-approval-card__facts-line-fact" data-cinder-tone="danger">
        <Tooltip
          text={undoneExplanation}
          describe={false}
          class="cinder-approval-card__facts-line-tip"
        >
          <TriangleAlert size={14} strokeWidth={2} aria-hidden="true" />
        </Tooltip>
        <span class="cinder-approval-card__irreversible">Can't be undone</span>
      </span>
    {/if}
  </p>
{/if}
