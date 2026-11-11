<script lang="ts">
  import CircleAlert from '@lucide/svelte/icons/circle-alert';

  import Alert from '../alert/alert.svelte';
  import type { ApprovalFailure } from './approval-card.types.ts';

  /** Props of the internal failure message. Not part of the public API. */
  type ApprovalCardFailureProps = {
    /** Why the last answer did not go through. */
    failure: ApprovalFailure;
  };

  let { failure }: ApprovalCardFailureProps = $props();
</script>

<!-- A tinted, bordered danger message that Alert announces, with the summary in bold and the reason after it. -->
<Alert variant="danger" class="cinder-approval-card__failure">
  {#snippet icon()}<CircleAlert size={16} strokeWidth={2} />{/snippet}
  <strong class="cinder-approval-card__failure-summary" dir="auto">{failure.summary}</strong>
  {#if failure.detail !== undefined}{' '}{failure.detail}{/if}
</Alert>
