<script lang="ts">
  /**
   * Renders a classified verification failure (`verification-failure.ts`) with copy specific to
   * its kind: a payload rejected at the worker's strict JSON boundary is a bug in the value an
   * activity returned, while a contract mismatch means the deployed code and the active revision
   * disagree. The two never share a generic error state.
   */
  import { Alert } from '@lostgradient/cinder';

  import { compatibilityReasonLabel } from '../system/compatibility-verdict.ts';
  import type { VerificationFailure } from './verification-failure.ts';

  interface VerificationFailureNoticeProps {
    readonly failure: VerificationFailure;
  }

  let { failure }: VerificationFailureNoticeProps = $props();
</script>

{#if failure.kind === 'payload-boundary'}
  <Alert variant="warning" class="weft-verification-failure" data-failure-kind="payload-boundary">
    <strong>Payload rejected at the worker boundary.</strong>
    The activity produced a value that is not strict worker JSON at
    <code>{failure.path}</code>: {failure.detail}. The contract is unchanged; fix the value the
    activity returns.
  </Alert>
{:else}
  <Alert variant="danger" class="weft-verification-failure" data-failure-kind="contract-mismatch">
    <strong>Contract mismatch.</strong>
    The deployed contract disagrees with the active revision:
    <ul class="weft-verification-failure__reasons">
      {#each failure.reasons as reason (reason)}
        <li>{compatibilityReasonLabel(reason)}</li>
      {/each}
    </ul>
  </Alert>
{/if}

<style>
  .weft-verification-failure__reasons {
    margin: 4px 0 0;
    padding-left: 18px;
  }
</style>
