<script lang="ts">
  import Clock from '@lucide/svelte/icons/clock';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';

  import Tooltip from '../tooltip/tooltip.svelte';

  type ApprovalCardFactsLineProps = {
    /** How long the approval has left, such as "Expires in 30s", or `undefined` when it has no deadline. */
    countdown: string | undefined;
    /** Whether the operation cannot be reversed. */
    irreversible: boolean;
    /** What cannot be undone, said in the warning glyph's tooltip. */
    undoneExplanation: string;
  };

  let { countdown, irreversible, undoneExplanation }: ApprovalCardFactsLineProps = $props();
</script>

<!-- The two facts an approver weighs before answering, one small line: when the approval lapses and
     whether it can be undone. Both are plain text, so a screen reader reads them as written; the
     glyphs are decoration and the tooltip repeats what the card already says. -->
{#if countdown !== undefined || irreversible}
  <p class="cinder-approval-card__facts-line">
    {#if countdown !== undefined}
      <span class="cinder-approval-card__facts-line-fact" data-cinder-countdown>
        <Clock size={14} strokeWidth={2} aria-hidden="true" />
        <span>{countdown}</span>
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
