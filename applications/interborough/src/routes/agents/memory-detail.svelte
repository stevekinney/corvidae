<script lang="ts">
  /**
   * One memory of an agent: the text, where it came from, and the two things that can be done to it.
   *
   * The lineage reads only what the Bureau's `bureau.memory.get` returns. From the memory itself:
   * its source, trust, class, creation time, and the chat that produced it. From the governance
   * ledger: the run that wrote it, the memory it corrects, and the memory that corrected it. The
   * legal-hold state has no read of its own: a hold is placed by a governance authority, which
   * this application never is, so the page learns of one only from a forget that answers
   * `exempt` (`legalHold`), and says so until then.
   *
   * The page mounts one of these per memory (`{#key}`), so what was said about one is never shown
   * for another. Forgetting and correcting belong to the page (`memory-changes.svelte`), which asks
   * the same way whether a row or this panel started them.
   */
  import {
    Alert,
    Button,
    DescriptionList,
    Skeleton,
    type DescriptionListItem,
  } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';
  import { onMount } from 'svelte';

  import { MEMORY_COPY, RETRY_LABEL } from '../../app/copy.ts';
  import { getMemory, memoryFaultOf, type Memory } from '../../lib/memory-client.ts';
  import { chatSessionPath } from '../../lib/identifier-paths.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { lineageFields } from './memory-presentation.ts';

  type Props = {
    agentId: string;
    id: string;
    /** Whether a forget of this memory was answered with a legal hold. */
    legalHold: boolean;
    /** True while a forget is being saved: it is asked once, so the action waits for it. */
    forgetPending: boolean;
    /** Opens another memory of the agent, such as the one this corrects. */
    onOpen: (id: string) => void;
    onClose: () => void;
    onForget: (id: string) => void;
    onCorrect: (memory: Memory) => void;
  };

  let { agentId, id, legalHold, forgetPending, onOpen, onClose, onForget, onCorrect }: Props =
    $props();

  const detail = createQuery(
    () => ({
      queryKey: queryKeys.memory.detail(agentId, id),
      queryFn: ({ signal }) => getMemory(agentId, id, { signal }),
      retry: false,
    }),
    undefined,
  );

  const detailFault = $derived(detail.isError ? memoryFaultOf(detail.error) : undefined);
  const holdWords = $derived(
    legalHold ? MEMORY_COPY.detail.legalHold.held : MEMORY_COPY.detail.legalHold.unknown,
  );

  let panel = $state<HTMLElement | null>(null);

  /**
   * On a narrow screen the panel opens below the list: bring it into view. Beside the list, in the
   * two-column layout (`min-width: 64rem`, as the page's), it is already in view and scrolling
   * would move the row that was opened out of it.
   */
  onMount(() => {
    const beside = window.matchMedia?.('(min-width: 64rem)').matches ?? false;
    if (!beside) panel?.scrollIntoView?.({ block: 'nearest' });
  });

  function goTo(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }
</script>

<section
  bind:this={panel}
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
    {@const fields = lineageFields(memory, lineage, holdWords)}
    {@const items = fields.map((field): DescriptionListItem => ({
      id: field.id,
      term: field.term,
      definition:
        field.link === undefined
          ? field.id === 'run' && lineage.runId !== null
            ? runCode
            : field.value
          : field.id === 'session'
            ? chatLink
            : field.id === 'corrects'
              ? correctsLink
              : correctedByLink,
    }))}
    {#snippet runCode()}
      <code class="weft-memory-detail__code">{lineage.runId}</code>
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
      <button type="button" class="weft-memory-detail__link" onclick={() => onOpen(target)}>
        {MEMORY_COPY.detail.openMemory}
      </button>
    {/snippet}

    <blockquote class="weft-memory-detail__content" aria-label={MEMORY_COPY.detail.content}>
      {memory.content}
    </blockquote>
    <h3 class="weft-memory-detail__subheading">{MEMORY_COPY.detail.lineage}</h3>
    <DescriptionList {items} variant="two-column" />

    <div class="weft-memory-detail__actions">
      <Button data-changes variant="secondary" onclick={() => onCorrect(memory)}
        >{MEMORY_COPY.correct.action}</Button
      >
      <Button
        data-changes
        variant="danger"
        disabled={forgetPending}
        onclick={() => onForget(memory.id)}>{MEMORY_COPY.forget.action}</Button
      >
    </div>
  {/if}
</section>

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

  .weft-memory-detail__actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-2);
  }

  .weft-memory-detail__alert-title {
    margin: 0;
    font-weight: 600;
  }

  .weft-memory-detail__alert-body {
    margin: var(--cinder-space-1) 0;
  }

  .weft-memory-detail__code {
    font-family: var(--cinder-font-mono);
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
