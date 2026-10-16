<script lang="ts">
  /**
   * Renders a server-reported failure that `classifyContractFailure`
   * recognizes (COR-162). A strict payload-boundary rejection and a
   * contract mismatch get different titles and different guidance: the
   * first is a value the worker could not send as JSON, the second is a
   * revision whose payload contract differs from the active one.
   */
  import { Callout } from '@lostgradient/cinder';

  import { compatibilityReasonLabel } from '../system/compatibility-verdict.ts';
  import type { ContractFailure } from './contract-verification.ts';

  interface ContractFailureNoticeProps {
    readonly failure: ContractFailure;
  }

  let { failure }: ContractFailureNoticeProps = $props();
</script>

{#if failure.kind === 'strict-payload'}
  <Callout variant="warning" semantic="note" title="Strict payload boundary rejected a value">
    <p>
      The worker could not send <code>{failure.path}</code> as strict JSON: {failure.message}. This
      is a value the activity produced, not a contract mismatch. Return plain JSON values (no
      <code>undefined</code>, non-finite numbers, <code>-0</code>, <code>BigInt</code>, functions,
      or class instances).
    </p>
  </Callout>
{:else}
  <Callout variant="danger" semantic="note" title="Contract mismatch">
    <p>The payload contract differs from the active registry revision:</p>
    <ul>
      {#each failure.reasons as reason (reason)}
        <li>{compatibilityReasonLabel(reason)}</li>
      {/each}
    </ul>
  </Callout>
{/if}
