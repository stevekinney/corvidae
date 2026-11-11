<script lang="ts">
  /**
   * One memory of an agent, in the detail pane (board PageMemory): a muted context line ("Fact,
   * remembered yesterday") with the two icon buttons that change it, Correct (a pencil) and Forget
   * (a trash can), the memory's text as a bold heading, and label/value rows: Came from (only for a
   * memory someone other than you wrote), Written by, and History. Trust is not drawn: it follows
   * from who wrote the memory. The legal hold is a row only once it is known. Sharing, the legal
   * hold and quarantine are under "More options", out of the way of the rows the design draws.
   *
   * Correct edits the text in place and saves a correction, which is a new memory that replaces this
   * one; the original is kept, and is reached from the correction's History. A correction the
   * server refuses is said at the form, with what was typed still in the field; only when the
   * person moved to another memory meanwhile does the page report it (`onCorrectionFailed`). The
   * legal hold has no read of its own, so it is shown only once `hold` knows it: from a hold or a
   * release made here, or from a forget that ran into one.
   *
   * The page mounts one of these per memory (`{#key}`), so what was said about one is never shown
   * for another. Forgetting and the governance actions belong to the page, which asks the same way
   * wherever it is asked from.
   */
  import { onDestroy, untrack } from 'svelte';

  import { Alert, Button, DescriptionList, Skeleton, Textarea } from '@lostgradient/cinder';
  import { Pencil, Trash2 } from '@lucide/svelte';
  import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';

  import { MEMORY_COPY, RETRY_LABEL } from '../../app/copy.ts';
  import {
    correctMemory,
    getMemory,
    memoryFaultOf,
    type Memory,
    type MemoryFault,
  } from '../../lib/memory-client.ts';
  import { queryKeys } from '../../lib/query.ts';
  import MemoryCameFrom from './memory-came-from.svelte';
  import {
    contextLine,
    correctionRefusalWords,
    historySummary,
    writerName,
  } from './memory-presentation.ts';

  type Props = {
    agentId: string;
    /** What the agent is called, for the memories it wrote ("Written by Tool runner" in the rows). */
    agentName: string;
    id: string;
    /** What is known of this memory's legal hold, or `undefined` while nothing has said. */
    hold: 'held' | 'free' | undefined;
    /** True while a forget is being saved: it is asked once, so the action waits for it. */
    forgetPending: boolean;
    /** True while a sharing, hold, quarantine or export change is being saved. */
    governancePending: boolean;
    /** Opens another memory of the agent, such as the one this corrects. */
    onOpen: (id: string) => void;
    onForget: (memory: Memory) => void;
    /** Called once a correction landed: the memory it replaced, and the correction. */
    onCorrected: (replaced: string, correction: Memory) => void;
    /**
     * Called when a correction was refused after this panel was gone (the person moved to another
     * memory): the memory it was for, the fault, and the text that was sent. While the panel is
     * here the refusal is said in its form, where the text stays.
     */
    onCorrectionFailed: (replaced: string, fault: MemoryFault, content: string) => void;
    /** The text of a refused correction to edit again, which opens this memory in its form. */
    resume?: string | undefined;
    onShare: (memory: Memory) => void;
    onHold: (id: string, change: 'place' | 'release') => void;
    onQuarantine: (memory: Memory) => void;
  };

  let {
    agentId,
    agentName,
    id,
    hold,
    forgetPending,
    governancePending,
    onOpen,
    onForget,
    onCorrected,
    onCorrectionFailed,
    resume,
    onShare,
    onHold,
    onQuarantine,
  }: Props = $props();

  const queryClient = useQueryClient();

  const detail = createQuery(
    () => ({
      queryKey: queryKeys.memory.detail(agentId, id),
      queryFn: ({ signal }) => getMemory(agentId, id, { signal }),
      retry: false,
    }),
    undefined,
  );

  // A refused correction the person chose to edit again starts this panel in its form.
  let editing = $state(untrack(() => resume !== undefined));
  let draft = $state(untrack(() => resume ?? ''));

  /** The refusal of the correction in this form, which keeps what was typed; cleared by the next try. */
  let failure = $state<MemoryFault | undefined>(undefined);
  /** Whether this panel is still on the page, which says where a refused correction is reported. */
  let present = true;
  onDestroy(() => {
    present = false;
  });

  // The memory a correction is for travels with it, because the panel may be gone by the time it
  // lands (the page mounts one per memory) and its `id` prop then answers for the memory now open.
  const correct = createMutation(() => ({
    mutationFn: (change: { readonly id: string; readonly content: string }) =>
      correctMemory(agentId, change.id, change.content),
    onSuccess: (result, change) => {
      editing = false;
      failure = undefined;
      void queryClient.invalidateQueries({ queryKey: queryKeys.memory.all(agentId) });
      onCorrected(change.id, result.memory);
    },
    onError: (error, change) => {
      const fault = memoryFaultOf(error);
      if (present) failure = fault;
      else onCorrectionFailed(change.id, fault, change.content);
    },
  }));

  const detailFault = $derived(detail.isError ? memoryFaultOf(detail.error) : undefined);

  function startCorrecting(memory: Memory): void {
    draft = memory.content;
    failure = undefined;
    editing = true;
  }

  function stopCorrecting(): void {
    failure = undefined;
    editing = false;
  }

  function submitCorrection(event: SubmitEvent): void {
    event.preventDefault();
    if (draft.trim() === '' || correct.isPending) return;
    failure = undefined;
    correct.mutate({ id, content: draft });
  }
</script>

<article class="ib-memory-detail" data-memory-detail={id}>
  {#if detail.isPending}
    <div role="status" aria-busy="true" aria-label={MEMORY_COPY.detail.loading}>
      <Skeleton height="1.5rem" width="60%" />
      <Skeleton height="6rem" />
    </div>
  {:else if detailFault?.kind === 'not-found'}
    <Alert variant="warning">
      <p class="ib-memory-detail__alert-title">{MEMORY_COPY.detail.notFound.title}</p>
      <p class="ib-memory-detail__alert-body">{MEMORY_COPY.detail.notFound.description}</p>
    </Alert>
  {:else if detail.isError}
    <Alert variant="danger">
      <p class="ib-memory-detail__alert-title">{MEMORY_COPY.detail.failed}</p>
      <Button variant="secondary" size="sm" onclick={() => void detail.refetch()}
        >{RETRY_LABEL}</Button
      >
    </Alert>
  {:else if detail.data}
    {@const memory = detail.data.memory}
    {@const lineage = detail.data.lineage}
    {@const summary = historySummary(lineage, detail.data.history)}
    {#snippet cameFromValue()}
      <MemoryCameFrom sessionId={memory.sessionId} />
    {/snippet}
    {#snippet historyValue()}
      {@const corrects = summary.corrects}
      {@const correctedBy = summary.correctedBy}
      {#if corrects === undefined && correctedBy === undefined}
        {MEMORY_COPY.detail.history.none}
      {/if}
      {#if corrects !== undefined}
        <span class="ib-memory-detail__history" data-history="corrects">
          <span>{corrects.text}</span>
          <button type="button" class="ib-memory-detail__link" onclick={() => onOpen(corrects.id)}>
            {MEMORY_COPY.detail.history.original}
          </button>
        </span>
      {/if}
      {#if correctedBy !== undefined}
        <span class="ib-memory-detail__history" data-history="corrected-by">
          <span>{MEMORY_COPY.detail.history.correctedBy}</span>
          <button
            type="button"
            class="ib-memory-detail__link"
            onclick={() => onOpen(correctedBy.id)}
          >
            {MEMORY_COPY.detail.history.correction}
          </button>
        </span>
      {/if}
    {/snippet}
    <!-- Came from is a row only for a memory someone other than you wrote; the legal hold, once it is known. -->
    {@const fields = MEMORY_COPY.detail.fields}
    {@const rows = [
      ...(memory.writer === 'person'
        ? []
        : [{ id: 'came-from', term: fields.cameFrom, definition: cameFromValue }]),
      {
        id: 'written-by',
        term: fields.writtenBy,
        definition: writerName(memory, agentName, 'detail'),
      },
      { id: 'history', term: fields.history, definition: historyValue },
      ...(hold === undefined
        ? []
        : [
            {
              id: 'legal-hold',
              term: fields.legalHold,
              definition: MEMORY_COPY.detail.legalHold[hold],
            },
          ]),
    ]}

    <div class="ib-memory-detail__context">
      <p class="ib-memory-detail__kind" data-memory-context>{contextLine(memory, Date.now())}</p>
      <span class="ib-memory-detail__tools">
        <Button
          data-changes
          variant="ghost"
          size="sm"
          iconOnly
          title={MEMORY_COPY.correct.iconLabel}
          aria-label={MEMORY_COPY.correct.iconLabel}
          aria-pressed={editing}
          disabled={editing}
          onclick={() => startCorrecting(memory)}
        >
          <Pencil aria-hidden="true" size={16} />
        </Button>
        <Button
          data-changes
          variant="ghost"
          size="sm"
          iconOnly
          title={MEMORY_COPY.forget.iconLabel}
          aria-label={MEMORY_COPY.forget.iconLabel}
          disabled={forgetPending}
          onclick={() => onForget(memory)}
        >
          <Trash2 aria-hidden="true" size={16} />
        </Button>
      </span>
    </div>

    {#if editing}
      <form class="ib-memory-detail__edit" onsubmit={submitCorrection}>
        <Textarea
          id="ib-memory-correction"
          label={MEMORY_COPY.correct.edit.label}
          description={MEMORY_COPY.correct.edit.description}
          rows={6}
          bind:value={draft}
        />
        {#if failure !== undefined}
          {@const words = correctionRefusalWords(failure)}
          <Alert variant="danger">
            <p class="ib-memory-detail__alert-title" data-correction-refusal={failure.kind}>
              {words.title}
            </p>
            {#if words.description !== ''}
              <p class="ib-memory-detail__alert-body">{words.description}</p>
            {/if}
          </Alert>
        {/if}
        <div class="ib-memory-detail__actions">
          <Button
            type="submit"
            variant="primary"
            disabled={correct.isPending || draft.trim() === ''}
            >{failure === undefined
              ? MEMORY_COPY.correct.edit.submit
              : MEMORY_COPY.correct.edit.retry}</Button
          >
          <Button variant="secondary" onclick={stopCorrecting}
            >{MEMORY_COPY.correct.edit.cancel}</Button
          >
        </div>
      </form>
    {:else}
      <h2 class="ib-memory-detail__text" data-memory-text>{memory.content}</h2>
    {/if}

    <DescriptionList variant="two-column" items={rows} />

    <details class="ib-memory-detail__more">
      <summary>{MEMORY_COPY.detail.more}</summary>
      <section class="ib-memory-detail__govern" aria-label={MEMORY_COPY.govern.heading}>
        <h3 class="ib-memory-detail__subheading">{MEMORY_COPY.govern.heading}</h3>
        <div class="ib-memory-detail__actions">
          <Button
            data-changes
            variant="secondary"
            size="sm"
            disabled={governancePending}
            onclick={() => onShare(memory)}>{MEMORY_COPY.govern.share.action}</Button
          >
          <Button
            data-changes
            variant="secondary"
            size="sm"
            disabled={governancePending}
            onclick={() => onHold(memory.id, hold === 'held' ? 'release' : 'place')}
            >{hold === 'held'
              ? MEMORY_COPY.govern.hold.release
              : MEMORY_COPY.govern.hold.place}</Button
          >
          <Button
            data-changes
            variant="danger"
            size="sm"
            disabled={governancePending}
            onclick={() => onQuarantine(memory)}>{MEMORY_COPY.govern.quarantine.action}</Button
          >
        </div>
      </section>
    </details>
  {/if}
</article>

<style>
  .ib-memory-detail {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-4);
    min-width: 0;
  }

  .ib-memory-detail__context {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--cinder-space-2) var(--cinder-space-3);
  }

  /* The kind and when it was written: muted, because the memory itself is what the pane is about. */
  .ib-memory-detail__kind {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }

  .ib-memory-detail__tools {
    display: inline-flex;
    gap: var(--cinder-space-1);
    margin-inline-start: auto;
  }

  /* The memory leads as a bold heading, wrapping anywhere so a long one never scrolls sideways. */
  .ib-memory-detail__text {
    margin: 0;
    font-size: var(--cinder-text-lg);
    font-weight: 600;
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .ib-memory-detail__edit {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
  }

  .ib-memory-detail__history {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-1) var(--cinder-space-2);
    overflow-wrap: anywhere;
  }

  .ib-memory-detail__more > summary {
    color: var(--cinder-text-muted);
    cursor: pointer;
  }

  .ib-memory-detail__govern {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    min-width: 0;
    margin-block-start: var(--cinder-space-2);
  }

  .ib-memory-detail__subheading {
    margin: 0;
    font-size: var(--cinder-text-sm);
    font-weight: 600;
    color: var(--cinder-text-muted);
  }

  .ib-memory-detail__actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-2);
  }

  .ib-memory-detail__alert-title {
    margin: 0;
    font-weight: 600;
  }

  .ib-memory-detail__alert-body {
    margin: var(--cinder-space-1) 0;
  }

  .ib-memory-detail__link {
    padding: 0;
    border: 0;
    background: none;
    color: var(--cinder-accent-text);
    font: inherit;
    text-decoration: underline;
    cursor: pointer;
  }
</style>
