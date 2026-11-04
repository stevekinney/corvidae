<script lang="ts">
  import CircleAlert from '@lucide/svelte/icons/circle-alert';

  import type { ApprovalFailure } from './approval-card.types.ts';

  /** Props of the internal failure message. Not part of the public API. */
  type ApprovalCardFailureProps = {
    /** Why the last answer did not go through. */
    failure: ApprovalFailure;
  };

  let { failure }: ApprovalCardFailureProps = $props();
</script>

<div class="cinder-approval-card__failure" role="alert">
  <CircleAlert size={16} strokeWidth={2} aria-hidden="true" />
  <span>
    <strong class="cinder-approval-card__failure-summary">{failure.summary}</strong>
    {#if failure.detail !== undefined}{' '}{failure.detail}{/if}
  </span>
</div>
