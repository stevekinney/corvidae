<script lang="ts">
  /**
   * One memory of an agent: the text, where it came from, and what can be done with it.
   *
   * The lineage reads only what the Bureau's `bureau.memory.get` returns. From the memory itself:
   * its source, trust, class, creation time, and the chat that produced it. From the governance
   * ledger: the run that wrote it, the memory it corrects, and the memory that corrected it. The
   * legal-hold state has no read of its own: a hold is placed by a governance authority, which
   * this application never is, so the page learns of one only from a forget that answers
   * `exempt`, and says so until then.
   *
   * The page mounts one of these per memory (`{#key}`), so what was said about one is never shown
   * for another. Forgetting asks first, then reports what the deletion came to in the words for its state
   * (`MEMORY_COPY.forget.outcome`). Correcting writes the person's words as the memory's
   * replacement; the Bureau's two refusals are worded apart.
   */
  import {
    Alert,
    Badge,
    Button,
    ConfirmDialog,
    DescriptionList,
    Modal,
    Skeleton,
    Textarea,
    type DescriptionListItem,
  } from '@lostgradient/cinder';
  import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';

  import { MEMORY_COPY, RETRY_LABEL } from '../../app/copy.ts';
  import {
    correctMemory,
    forgetMemory,
    getMemory,
    memoryFaultOf,
    type ForgetResult,
    type MemoryFault,
  } from '../../lib/memory-client.ts';
  import { chatSessionPath } from '../../lib/identifier-paths.ts';
  import { memoryListingsFilter, queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { labelFor, lineageFields } from './memory-presentation.ts';

  type Props = {
    agentId: string;
    id: string;
    /** Opens another memory of the agent, such as the one this corrects. */
    onOpen: (id: string) => void;
    onClose: () => void;
    /** Called once a change has landed, so the page can look at the list again. */
    onChanged: (change: { readonly kind: 'forgotten' | 'corrected'; readonly id: string }) => void;
  };

  let { agentId, id, onOpen, onClose, onChanged }: Props = $props();

  const queryClient = useQueryClient();

  const detail = createQuery(
    () => ({
      queryKey: queryKeys.memory.detail(agentId, id),
      queryFn: ({ signal }) => getMemory(agentId, id, { signal }),
      retry: false,
    }),
    undefined,
  );

  const detailFault = $derived(detail.isError ? memoryFaultOf(detail.error) : undefined);

  let confirmingForget = $state(false);
  let correcting = $state(false);
  let draft = $state('');
  let outcome = $state<ForgetResult | undefined>(undefined);
  let failure = $state<MemoryFault | undefined>(undefined);
  let correctionFailure = $state<MemoryFault | undefined>(undefined);

  const forget = createMutation(() => ({
    mutationFn: () => forgetMemory(agentId, id),
    onSuccess: (result) => {
      outcome = result;
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
    mutationFn: (content: string) => correctMemory(agentId, id, content),
    onMutate: () => {
      correctionFailure = undefined;
    },
    onSuccess: (result) => {
      correcting = false;
      void queryClient.invalidateQueries({ queryKey: queryKeys.memory.all(agentId) });
      onChanged({ kind: 'corrected', id: result.memory.id });
    },
    onError: (error) => {
      correctionFailure = memoryFaultOf(error);
    },
  }));

  /** Asks the Bureau to forget, with the last refusal forgotten first. */
  function confirmForget(): void {
    failure = undefined;
    forget.mutate();
  }

  function startCorrecting(content: string): void {
    draft = content;
    correctionFailure = undefined;
    correcting = true;
  }

  function submitCorrection(event: SubmitEvent): void {
    event.preventDefault();
    if (draft.trim() !== '') correct.mutate(draft);
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

  const legalHold = $derived(
    outcome?.deletion === 'exempt'
      ? MEMORY_COPY.detail.legalHold.held
      : MEMORY_COPY.detail.legalHold.unknown,
  );
  const outcomeWords = $derived(
    outcome === undefined ? undefined : MEMORY_COPY.forget.outcome[outcome.deletion],
  );

  function goTo(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }
</script>

<section
  class="weft-memory-detail"
  aria-labelledby="weft-memory-detail-title"
  data-memory-detail={id}
>
  <header class="weft-memory-detail__header">
    <h2 id="weft-memory-detail-title" class="weft-memory-detail__title">
      {MEMORY_COPY.detail.heading}
    </h2>
    <Button variant="ghost" size="sm" onclick={onClose}>{MEMORY_COPY.detail.close}</Button>
  </header>

  {#if detail.isPending}
    <div role="status" aria-busy="true" aria-label={MEMORY_COPY.detail.loading}>
      <Skeleton height="1.5rem" width="60%" />
      <Skeleton height="6rem" />
    </div>
  {:else if detailFault?.kind === 'not-found'}
    <Alert variant="warning">
      <p class="weft-memory-detail__alert-title">{MEMORY_COPY.detail.notFound.title}</p>
      <p class="weft-memory-detail__alert-body">{MEMORY_COPY.detail.notFound.description}</p>
    </Alert>
  {:else if detail.isError}
    <Alert variant="danger">
      <p class="weft-memory-detail__alert-title">{MEMORY_COPY.detail.failed}</p>
      <Button variant="secondary" size="sm" onclick={() => void detail.refetch()}
        >{RETRY_LABEL}</Button
      >
    </Alert>
  {:else if detail.data}
    {@const memory = detail.data.memory}
    {@const lineage = detail.data.lineage}
    {@const fields = lineageFields(memory, lineage, legalHold)}
    {@const items = fields.map((field): DescriptionListItem => ({
      id: field.id,
      term: field.term,
      definition:
        field.link === undefined
          ? field.value
          : field.id === 'session'
            ? chatLink
            : field.id === 'corrects'
              ? correctsLink
              : correctedByLink,
    }))}
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
      <button type="button" class="weft-memory-detail__link" onclick={() => onOpen(target)}>
        {MEMORY_COPY.detail.openMemory}
      </button>
    {/snippet}

    <blockquote class="weft-memory-detail__content" aria-label={MEMORY_COPY.detail.content}>
      {memory.content}
    </blockquote>
    <div class="weft-memory-detail__badges">
      <Badge variant="neutral" size="sm"
        >{labelFor(MEMORY_COPY.memoryClass, memory.memoryClass)}</Badge
      >
    </div>

    <h3 class="weft-memory-detail__subheading">{MEMORY_COPY.detail.lineage}</h3>
    <DescriptionList {items} variant="two-column" />

    {#if outcomeWords !== undefined && outcome !== undefined}
      <Alert variant={outcome.deletion === 'completed' ? 'success' : 'warning'}>
        <p class="weft-memory-detail__alert-title" data-forget-outcome={outcome.deletion}>
          {outcomeWords.title}
        </p>
        <p class="weft-memory-detail__alert-body">{outcomeWords.description}</p>
        <p class="weft-memory-detail__alert-body">{MEMORY_COPY.forget.receiptLabel}</p>
        <ul class="weft-memory-detail__targets">
          {#each outcome.receipt.targets as target (target.target)}
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
        <p class="weft-memory-detail__alert-title">{MEMORY_COPY.forget.failed}</p>
        <p class="weft-memory-detail__alert-body">{words.description || words.title}</p>
      </Alert>
    {/if}

    {#if outcome?.deletion !== 'completed'}
      <div class="weft-memory-detail__actions">
        <Button
          variant="secondary"
          disabled={forget.isPending || correct.isPending}
          onclick={() => startCorrecting(memory.content)}>{MEMORY_COPY.correct.action}</Button
        >
        <Button
          variant="danger"
          disabled={forget.isPending || correct.isPending}
          onclick={() => (confirmingForget = true)}>{MEMORY_COPY.forget.action}</Button
        >
      </div>
    {/if}
  {/if}
</section>

<ConfirmDialog
  bind:open={confirmingForget}
  title={MEMORY_COPY.forget.dialog.title}
  description={MEMORY_COPY.forget.dialog.description}
  confirmLabel={MEMORY_COPY.forget.dialog.confirm}
  destructive
  onConfirm={confirmForget}
/>

<Modal bind:open={correcting} title={MEMORY_COPY.correct.dialog.title}>
  <form class="weft-memory-detail__form" onsubmit={submitCorrection}>
    <p class="weft-memory-detail__alert-body">{MEMORY_COPY.correct.dialog.description}</p>
    {#if correctionFailure !== undefined}
      {@const words = refusalWords(correctionFailure)}
      <Alert variant="danger">
        <p class="weft-memory-detail__alert-title" data-correction-refusal={correctionFailure.kind}>
          {words.title}
        </p>
        {#if words.description !== ''}
          <p class="weft-memory-detail__alert-body">{words.description}</p>
        {/if}
      </Alert>
    {/if}
    <Textarea
      id="weft-memory-correction"
      label={MEMORY_COPY.correct.dialog.label}
      rows={6}
      bind:value={draft}
    />
    <div class="weft-memory-detail__actions">
      <Button variant="secondary" onclick={() => (correcting = false)}
        >{MEMORY_COPY.correct.dialog.cancel}</Button
      >
      <Button type="submit" variant="primary" disabled={correct.isPending || draft.trim() === ''}
        >{MEMORY_COPY.correct.dialog.submit}</Button
      >
    </div>
  </form>
</Modal>

<style>
  .weft-memory-detail {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    min-width: 0;
  }

  .weft-memory-detail__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--cinder-space-2);
  }

  .weft-memory-detail__title,
  .weft-memory-detail__subheading {
    margin: 0;
    font-weight: 600;
  }

  .weft-memory-detail__title {
    font-size: var(--cinder-text-lg);
  }

  .weft-memory-detail__subheading {
    font-size: var(--cinder-text-md);
  }

  .weft-memory-detail__content {
    margin: 0;
    padding: var(--cinder-space-3);
    border-inline-start: 3px solid var(--cinder-border);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .weft-memory-detail__badges,
  .weft-memory-detail__actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-2);
  }

  .weft-memory-detail__form {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
  }

  .weft-memory-detail__alert-title {
    margin: 0;
    font-weight: 600;
  }

  .weft-memory-detail__alert-body {
    margin: var(--cinder-space-1) 0;
  }

  .weft-memory-detail__targets {
    margin: 0;
    padding-inline-start: var(--cinder-space-5);
  }

  .weft-memory-detail__link {
    padding: 0;
    border: 0;
    background: none;
    color: var(--cinder-accent-text);
    font: inherit;
    text-decoration: underline;
    cursor: pointer;
  }
</style>
