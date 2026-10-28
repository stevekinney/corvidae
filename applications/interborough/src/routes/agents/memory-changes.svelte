<script lang="ts" module>
  /** What forgetting one memory answered: which memory, and the Bureau's deletion receipt. */
  export type ForgetOutcome = { readonly id: string; readonly result: ForgetResult };
</script>

<script lang="ts">
  /**
   * The two things a person can do to a memory, forgetting it and correcting it, for the whole
   * Memory page. A row and the details panel both start them (`askToForget`, `startCorrecting`), so
   * the question, the correction form, the Bureau's refusals, and the deletion's receipt exist once
   * and read the same wherever the change began.
   *
   * Forgetting asks first, then reports what the deletion came to in the words for its state
   * (`MEMORY_COPY.forget.outcome`). Correcting writes the person's words as the memory's
   * replacement; the Bureau's two refusals are worded apart. Each change names the memory it is
   * for when it is asked, so a second request never changes what the first one reports.
   */
  import { Alert, Button, ConfirmDialog, Modal, Textarea } from '@lostgradient/cinder';
  import { createMutation, useQueryClient } from '@tanstack/svelte-query';

  import { MEMORY_COPY } from '../../app/copy.ts';
  import {
    correctMemory,
    forgetMemory,
    memoryFaultOf,
    type ForgetResult,
    type Memory,
    type MemoryFault,
  } from '../../lib/memory-client.ts';
  import { memoryListingsFilter, queryKeys } from '../../lib/query.ts';
  import { labelFor } from './memory-presentation.ts';

  type Props = {
    agentId: string;
    /** What the last forget answered, for the page to say when its memory stays stored. */
    outcome?: ForgetOutcome | undefined;
    /**
     * The memories a forget answered with a legal hold. Unlike the receipt, which a person can
     * dismiss, a hold the Bureau confirmed stays known.
     */
    held?: readonly string[];
    /** True while a forget is being saved, for the page to hold every Forget until it settles. */
    forgetPending?: boolean;
    /**
     * Called once a change has landed, so the page can look at the list again. `select` is false
     * for a correction that finished after the person had moved on to another memory.
     */
    onChanged: (change: {
      readonly kind: 'forgotten' | 'corrected';
      readonly id: string;
      readonly select?: boolean;
    }) => void;
  };

  let {
    agentId,
    outcome = $bindable(),
    held = $bindable([]),
    forgetPending = $bindable(false),
    onChanged,
  }: Props = $props();

  const queryClient = useQueryClient();

  let forgetting = $state<string | undefined>(undefined);
  let confirmingForget = $state(false);
  let correcting = $state<string | undefined>(undefined);
  let correctionOpen = $state(false);
  let draft = $state('');
  let failure = $state<MemoryFault | undefined>(undefined);
  let correctionFailure = $state<MemoryFault | undefined>(undefined);

  const forget = createMutation(() => ({
    mutationFn: (id: string) => forgetMemory(agentId, id),
    onSuccess: (result, id) => {
      outcome = { id, result };
      if (result.deletion === 'exempt' && !held.includes(id)) held = [...held, id];
      // A memory that is gone has no details to read again: the outcome stays on screen.
      void queryClient.invalidateQueries(
        result.deletion === 'completed'
          ? memoryListingsFilter(agentId)
          : { queryKey: queryKeys.memory.all(agentId) },
      );
      if (result.deletion === 'completed') onChanged({ kind: 'forgotten', id });
    },
    onError: (error) => {
      failure = memoryFaultOf(error);
    },
  }));

  const correct = createMutation(() => ({
    mutationFn: (change: { readonly id: string; readonly content: string }) =>
      correctMemory(agentId, change.id, change.content),
    onMutate: () => {
      correctionFailure = undefined;
    },
    onSuccess: (result, change) => {
      // The form may have moved on to another memory while this one was saved: close only the
      // form that asked for this correction, and do not take the person to its result.
      const current = correcting === change.id;
      if (current) correctionOpen = false;
      void queryClient.invalidateQueries({ queryKey: queryKeys.memory.all(agentId) });
      onChanged({ kind: 'corrected', id: result.memory.id, select: current });
    },
    onError: (error, change) => {
      if (correcting === change.id) correctionFailure = memoryFaultOf(error);
    },
  }));

  $effect(() => {
    forgetPending = forget.isPending;
  });

  /** Asks whether to forget the memory `id`, unless a forget is already being saved. */
  export function askToForget(id: string): void {
    if (forget.isPending) return;
    forgetting = id;
    confirmingForget = true;
  }

  /** Opens the correction form for `memory`, with its words to start from. */
  export function startCorrecting(memory: Pick<Memory, 'id' | 'content'>): void {
    correcting = memory.id;
    draft = memory.content;
    correctionFailure = undefined;
    correctionOpen = true;
  }

  /** Asks the Bureau to forget, with the last refusal and receipt forgotten first. */
  function confirmForget(): void {
    if (forgetting === undefined || forget.isPending) return;
    failure = undefined;
    outcome = undefined;
    forget.mutate(forgetting);
  }

  function submitCorrection(event: SubmitEvent): void {
    event.preventDefault();
    if (correcting !== undefined && draft.trim() !== '') {
      correct.mutate({ id: correcting, content: draft });
    }
  }

  /** The words for a fault the Bureau answered a change with. */
  function refusalWords(fault: MemoryFault): { title: string; description: string } {
    const words = MEMORY_COPY.correct.refusal;
    switch (fault.kind) {
      case 'superseded':
      case 'successor-not-admitted':
      case 'forbidden':
      case 'not-found':
        return words[fault.kind];
      case 'other':
        return { title: words.other.title, description: fault.message };
    }
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
  description={MEMORY_COPY.forget.dialog.description}
  confirmLabel={MEMORY_COPY.forget.dialog.confirm}
  destructive
  onConfirm={confirmForget}
/>

<Modal bind:open={correctionOpen} title={MEMORY_COPY.correct.dialog.title}>
  <form class="weft-memory-changes__form" onsubmit={submitCorrection}>
    <p class="weft-memory-changes__alert-body">{MEMORY_COPY.correct.dialog.description}</p>
    {#if correctionFailure !== undefined}
      {@const words = refusalWords(correctionFailure)}
      <Alert variant="danger">
        <p
          class="weft-memory-changes__alert-title"
          data-correction-refusal={correctionFailure.kind}
        >
          {words.title}
        </p>
        {#if words.description !== ''}
          <p class="weft-memory-changes__alert-body">{words.description}</p>
        {/if}
      </Alert>
    {/if}
    <Textarea
      id="weft-memory-correction"
      label={MEMORY_COPY.correct.dialog.label}
      rows={6}
      bind:value={draft}
    />
    <div class="weft-memory-changes__actions">
      <Button variant="secondary" onclick={() => (correctionOpen = false)}
        >{MEMORY_COPY.correct.dialog.cancel}</Button
      >
      <Button type="submit" variant="primary" disabled={correct.isPending || draft.trim() === ''}
        >{MEMORY_COPY.correct.dialog.submit}</Button
      >
    </div>
  </form>
</Modal>

<style>
  .weft-memory-changes__form {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
  }

  .weft-memory-changes__actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-2);
  }

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
