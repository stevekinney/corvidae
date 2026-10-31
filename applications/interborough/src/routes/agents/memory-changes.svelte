<script lang="ts" module>
  import type { ForgetResult } from '../../lib/memory-client.ts';

  /** What forgetting one memory answered: which memory, and the Bureau's deletion receipt. */
  export type ForgetOutcome = { readonly id: string; readonly result: ForgetResult };
</script>

<script lang="ts">
  /**
   * Forgetting a memory, for the whole Memory page. The details panel starts it (`askToForget`),
   * so the question, the server's refusals, and the deletion's receipt exist once.
   *
   * Forgetting asks first, naming the memory that goes, then reports what the deletion came to in
   * the words for its state (`MEMORY_COPY.forget.outcome`). Correcting is the details panel's own
   * form (`memory-detail.svelte`), and sharing, holding, quarantining and exporting are
   * `memory-governance.svelte`. Each change names the memory it is for when it is asked, so a
   * second request never changes what the first one reports.
   */
  import { Alert, ConfirmDialog } from '@lostgradient/cinder';
  import { createMutation, useQueryClient } from '@tanstack/svelte-query';
  import type { SvelteMap } from 'svelte/reactivity';

  import { MEMORY_COPY } from '../../app/copy.ts';
  import {
    forgetMemory,
    memoryFaultOf,
    type Memory,
    type MemoryFault,
  } from '../../lib/memory-client.ts';
  import { memoryListingsFilter, queryKeys } from '../../lib/query.ts';
  import { excerpt, labelFor, refusalWords } from './memory-presentation.ts';

  type Props = {
    agentId: string;
    /** What the last forget answered, for the page to say when its memory stays stored. */
    outcome?: ForgetOutcome | undefined;
    /**
     * What is known of each memory's legal hold. A forget answered `exempt` records a hold here,
     * and unlike the receipt, which a person can dismiss, a hold the server confirmed stays known.
     */
    holds: SvelteMap<string, 'held' | 'free'>;
    /** True while a forget is being saved, for the page to hold every Forget until it settles. */
    forgetPending?: boolean;
    /** Called once a memory is gone, so the page can close its details. */
    onForgotten: (id: string) => void;
  };

  let {
    agentId,
    outcome = $bindable(),
    holds,
    forgetPending = $bindable(false),
    onForgotten,
  }: Props = $props();

  const queryClient = useQueryClient();

  let forgetting = $state<Pick<Memory, 'id' | 'content'> | undefined>(undefined);
  let confirmingForget = $state(false);
  let failure = $state<MemoryFault | undefined>(undefined);

  const forget = createMutation(() => ({
    mutationFn: (id: string) => forgetMemory(agentId, id),
    onSuccess: (result, id) => {
      outcome = { id, result };
      if (result.deletion === 'exempt') holds.set(id, 'held');
      // A memory that is gone has no details to read again: the outcome stays on screen.
      void queryClient.invalidateQueries(
        result.deletion === 'completed'
          ? memoryListingsFilter(agentId)
          : { queryKey: queryKeys.memory.all(agentId) },
      );
      if (result.deletion === 'completed') onForgotten(id);
    },
    onError: (error) => {
      failure = memoryFaultOf(error);
    },
  }));

  $effect(() => {
    forgetPending = forget.isPending;
  });

  /** Asks whether to forget `memory`, unless a forget is already being saved. */
  export function askToForget(memory: Pick<Memory, 'id' | 'content'>): void {
    if (forget.isPending) return;
    forgetting = memory;
    confirmingForget = true;
  }

  /** Asks the server to forget, with the last refusal and receipt forgotten first. */
  function confirmForget(): void {
    if (forgetting === undefined || forget.isPending) return;
    failure = undefined;
    outcome = undefined;
    forget.mutate(forgetting.id);
  }

  const outcomeWords = $derived(
    outcome === undefined ? undefined : MEMORY_COPY.forget.outcome[outcome.result.deletion],
  );
</script>

{#if outcomeWords !== undefined && outcome !== undefined}
  <Alert
    variant={outcome.result.deletion === 'completed' ? 'success' : 'warning'}
    dismissible
    onDismiss={() => (outcome = undefined)}
  >
    <p class="weft-memory-changes__alert-title" data-forget-outcome={outcome.result.deletion}>
      {outcomeWords.title}
    </p>
    <p class="weft-memory-changes__alert-body">{outcomeWords.description}</p>
    <p class="weft-memory-changes__alert-body">{MEMORY_COPY.forget.receiptLabel}</p>
    <ul class="weft-memory-changes__targets">
      {#each outcome.result.receipt.targets as target (target.target)}
        <li data-target={target.target} data-status={target.status}>
          {labelFor(MEMORY_COPY.forget.targets, target.target)}:
          {MEMORY_COPY.forget.targetStatus[target.status]}
        </li>
      {/each}
    </ul>
  </Alert>
{/if}

{#if failure !== undefined}
  {@const words = refusalWords(failure)}
  <Alert variant="danger" dismissible onDismiss={() => (failure = undefined)}>
    <p class="weft-memory-changes__alert-title">{MEMORY_COPY.forget.failed}</p>
    <p class="weft-memory-changes__alert-body">{words.description || words.title}</p>
  </Alert>
{/if}

<ConfirmDialog
  bind:open={confirmingForget}
  title={MEMORY_COPY.forget.dialog.title}
  description={MEMORY_COPY.forget.dialog.description(excerpt(forgetting?.content ?? ''))}
  confirmLabel={MEMORY_COPY.forget.dialog.confirm}
  destructive
  onConfirm={confirmForget}
/>

<style>
  .weft-memory-changes__alert-title {
    margin: 0;
    font-weight: 600;
  }

  .weft-memory-changes__alert-body {
    margin: var(--cinder-space-1) 0;
  }

  .weft-memory-changes__targets {
    margin: 0;
    padding-inline-start: var(--cinder-space-5);
  }
</style>
