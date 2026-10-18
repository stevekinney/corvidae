<script lang="ts">
  /** The error state shared by both contract-verification panels (COR-162). */
  import { EmptyState } from '@lostgradient/cinder';

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
  <EmptyState title="Malformed server response" description={fault.message} />
{:else if fault.kind === 'permission-denied'}
  <EmptyState
    title="Permission denied"
    description={`Contract verification needs system:read. ${fault.message}`}
  />
{:else}
  <EmptyState title={fault.title} description={fault.message} />
{/if}
