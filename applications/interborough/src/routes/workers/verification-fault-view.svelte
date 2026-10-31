<script lang="ts">
  /** The error state shared by both contract-verification panels (COR-162). */
  import { Callout } from '@lostgradient/cinder';

  import ContractFailureNotice from './contract-failure-notice.svelte';
  import { verificationFault } from './contract-verification.ts';

  interface VerificationFaultViewProps {
    readonly error: unknown;
  }

  let { error }: VerificationFaultViewProps = $props();

  const fault = $derived(verificationFault(error));
</script>

{#if fault.kind === 'contract'}
  <ContractFailureNotice failure={fault.failure} />
{:else if fault.kind === 'malformed'}
  <Callout variant="danger" semantic="note" title="Malformed server response">
    <p>{fault.message}</p>
  </Callout>
{:else if fault.kind === 'permission-denied'}
  <Callout variant="danger" semantic="note" title="Permission denied">
    <p>Contract verification needs system:read. {fault.message}</p>
  </Callout>
{:else}
  <Callout variant="danger" semantic="note" title={fault.title}>
    <p>{fault.message}</p>
  </Callout>
{/if}
