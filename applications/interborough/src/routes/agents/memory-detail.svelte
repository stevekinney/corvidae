<script lang="ts">
  /**
   * One memory of an agent, in the detail pane: its text at reading size, a context line (its kind,
   * when it was learned, and the two icon buttons that change it: Correct and Forget), the facts
   * below in three columns, and the governance actions.
   *
   * Correct edits the text in place and saves a correction, which is a new memory that replaces this
   * one; the original is kept, and is reached from the correction's history. The facts read only
   * what `bureau.memory.get` returns. From the memory itself: its source, trust, class, creation
   * time, and the chat that produced it. From the governance ledger: the run that wrote it, the
   * memory it corrects, and the memory that corrected it. The legal hold has no read of its own,
   * so it is shown only once `hold` knows it: from a hold or a release made here, or from a forget
   * that ran into one.
   *
   * The page mounts one of these per memory (`{#key}`), so what was said about one is never shown
   * for another. Forgetting and the governance actions belong to the page, which asks the same way
   * wherever it is asked from.
   */
  import { untrack } from 'svelte';

  import {
    Alert,
    Badge,
    Button,
    DescriptionList,
    RelativeTime,
    Skeleton,
    Textarea,
    type DescriptionListItem,
  } from '@lostgradient/cinder';
  import { Pencil, Trash2 } from '@lucide/svelte';
  import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';

  import { MEMORY_COPY, RETRY_LABEL } from '../../app/copy.ts';
  import { chatSessionPath } from '../../lib/identifier-paths.ts';
  import {
    correctMemory,
    getMemory,
    memoryFaultOf,
    type Memory,
    type MemoryFault,
  } from '../../lib/memory-client.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import {
    formatMemoryTime,
    kindOf,
    lineageGroups,
    plainKindOf,
    type LineageField,
  } from './memory-presentation.ts';

  type Props = {
    agentId: string;
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
     * Called when a correction was refused: the memory it was for, the fault, and the text that was
     * sent. The page reports it, because this panel is gone if the person moves to another memory.
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

  // The memory a correction is for travels with it, because the panel may be gone by the time it
  // lands (the page mounts one per memory) and its `id` prop then answers for the memory now open.
  const correct = createMutation(() => ({
    mutationFn: (change: { readonly id: string; readonly content: string }) =>
      correctMemory(agentId, change.id, change.content),
    onSuccess: (result, change) => {
      editing = false;
      void queryClient.invalidateQueries({ queryKey: queryKeys.memory.all(agentId) });
      onCorrected(change.id, result.memory);
    },
    onError: (error, change) => {
      onCorrectionFailed(change.id, memoryFaultOf(error), change.content);
    },
  }));

  const detailFault = $derived(detail.isError ? memoryFaultOf(detail.error) : undefined);

  function startCorrecting(memory: Memory): void {
    draft = memory.content;
    editing = true;
  }

  function submitCorrection(event: SubmitEvent): void {
    event.preventDefault();
    if (draft.trim() !== '' && !correct.isPending) correct.mutate({ id, content: draft });
  }

  function goTo(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
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
    {@const groups = lineageGroups(memory, lineage, hold)}
    {#snippet runCode()}
      <code class="ib-memory-detail__code">{lineage.runId}</code>
    {/snippet}
    {#snippet chatLink()}
      {@const chatPath = chatSessionPath(memory.sessionId ?? '')}
      <a href={router.href(chatPath)} onclick={(event) => goTo(event, chatPath)}
        >{MEMORY_COPY.detail.openChat}</a
      >
    {/snippet}
    {#snippet correctsLink()}
      {@render memoryLink(lineage.corrects ?? '')}
    {/snippet}
    {#snippet correctedByLink()}
      {@render memoryLink(lineage.correctedBy ?? '')}
    {/snippet}
    {#snippet memoryLink(target: string)}
      <button type="button" class="ib-memory-detail__link" onclick={() => onOpen(target)}>
        {MEMORY_COPY.detail.openMemory}
      </button>
    {/snippet}
    {@const itemsOf = (fields: LineageField[]): DescriptionListItem[] =>
      fields.map((field) => ({
        id: field.id,
        term: field.term,
        definition:
          field.link === undefined
            ? field.id === 'run' && lineage.runId !== null
              ? runCode
              : field.value
            : field.link.kind === 'chat'
              ? chatLink
              : field.id === 'corrects'
                ? correctsLink
                : correctedByLink,
      }))}

    <div class="ib-memory-detail__context">
      <Badge variant="neutral" size="sm">{plainKindOf(memory)}</Badge>
      <RelativeTime date={memory.createdAt} title={formatMemoryTime(memory.createdAt)} />
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
        <p class="ib-memory-detail__alert-body">{MEMORY_COPY.correct.edit.description}</p>
        <Textarea
          id="ib-memory-correction"
          label={MEMORY_COPY.correct.edit.label}
          rows={6}
          bind:value={draft}
        />
        <div class="ib-memory-detail__actions">
          <Button
            type="submit"
            variant="primary"
            disabled={correct.isPending || draft.trim() === ''}
            >{MEMORY_COPY.correct.edit.submit}</Button
          >
          <Button variant="secondary" onclick={() => (editing = false)}
            >{MEMORY_COPY.correct.edit.cancel}</Button
          >
        </div>
      </form>
    {:else}
      <blockquote class="ib-memory-detail__text" aria-label={MEMORY_COPY.detail.content}>
        {memory.content}
      </blockquote>
    {/if}

    <div class="ib-memory-detail__facts">
      <section class="ib-memory-detail__group" aria-label={MEMORY_COPY.detail.groups.origin}>
        <h3 class="ib-memory-detail__subheading">{MEMORY_COPY.detail.groups.origin}</h3>
        <DescriptionList items={itemsOf(groups.origin)} />
      </section>
      <section class="ib-memory-detail__group" aria-label={MEMORY_COPY.detail.groups.standing}>
        <h3 class="ib-memory-detail__subheading">{MEMORY_COPY.detail.groups.standing}</h3>
        <DescriptionList items={itemsOf(groups.standing)} />
        <p class="ib-memory-detail__hint">{kindOf(memory).description}</p>
      </section>
      <section class="ib-memory-detail__group" aria-label={MEMORY_COPY.detail.groups.history}>
        <h3 class="ib-memory-detail__subheading">{MEMORY_COPY.detail.groups.history}</h3>
        <DescriptionList items={itemsOf(groups.history)} />
      </section>
    </div>

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

  .ib-memory-detail__tools {
    display: inline-flex;
    gap: var(--cinder-space-1);
    margin-inline-start: auto;
  }

  /* The memory leads at reading size: it is what the page is about. */
  .ib-memory-detail__text {
    margin: 0;
    font-size: var(--cinder-text-lg);
    line-height: 1.6;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .ib-memory-detail__edit {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
  }

  /* Three columns of facts where there is room, one under another where there is not. */
  .ib-memory-detail__facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 14rem), 1fr));
    gap: var(--cinder-space-4);
  }

  .ib-memory-detail__group,
  .ib-memory-detail__govern {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .ib-memory-detail__subheading {
    margin: 0;
    font-size: var(--cinder-text-sm);
    font-weight: 600;
    color: var(--cinder-text-muted);
  }

  .ib-memory-detail__hint {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
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

  .ib-memory-detail__code {
    font-family: var(--cinder-font-mono);
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
