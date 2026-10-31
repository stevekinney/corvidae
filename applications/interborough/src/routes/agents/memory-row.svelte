<script lang="ts">
  /**
   * One memory in the list: its text, how long ago it was learned, and what kind of memory it is,
   * in plain words (Facts, From chats, How-to, From you). The whole row opens the memory's
   * details, and Correct and Forget live there. A memory that is open but not on the pages read so
   * far (one a correction replaced, or one an address names) has no `memory` yet, so the row reads
   * it the way the details do and shares the answer.
   */
  import { Badge, RelativeTime, SelectableRow, Skeleton } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { MEMORY_COPY } from '../../app/copy.ts';
  import { getMemory, type Memory } from '../../lib/memory-client.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { formatMemoryTime, highlightSegments, plainKindOf } from './memory-presentation.ts';

  type Props = {
    agentId: string;
    id: string;
    /** The memory, when the pages read so far hold it; otherwise the row reads it. */
    memory: Memory | undefined;
    /** What the list was searched for, to mark in the text; empty when it is not a search. */
    query: string;
    /** The search's relevance for this memory, or `null` when the list is not a search. */
    score: number | null;
    selected: boolean;
    onOpen: () => void;
  };

  let { agentId, id, memory, query, score, selected, onOpen }: Props = $props();

  const read = createQuery(
    () => ({
      queryKey: queryKeys.memory.detail(agentId, id),
      queryFn: ({ signal }) => getMemory(agentId, id, { signal }),
      enabled: memory === undefined,
      retry: false,
    }),
    undefined,
  );

  const shown = $derived(memory ?? read.data?.memory);
  const segments = $derived(highlightSegments(shown?.content ?? '', query));
</script>

<SelectableRow {selected} selectedState="current" onclick={onOpen} data-memory={id}>
  {#snippet title()}
    {#if shown !== undefined}
      <span class="ib-memory__content"
        >{#each segments as segment, index (index)}{#if segment.match}<mark class="ib-memory__match"
              >{segment.text}</mark
            >{:else}{segment.text}{/if}{/each}</span
      >
    {:else if read.isError}
      <span class="ib-memory__content">{MEMORY_COPY.detail.failed}</span>
    {:else}
      <Skeleton height="1rem" width="70%" />
    {/if}
  {/snippet}
  {#snippet meta()}
    {#if shown !== undefined}
      <span class="ib-memory__facts">
        {#if score !== null}
          <span>{MEMORY_COPY.relevance}: {score.toFixed(2)}</span>
        {/if}
        <RelativeTime
          class="ib-memory__time"
          date={shown.createdAt}
          title={formatMemoryTime(shown.createdAt)}
        />
        <Badge variant="neutral" size="sm">{plainKindOf(shown)}</Badge>
      </span>
    {/if}
  {/snippet}
</SelectableRow>

<style>
  .ib-memory__content {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .ib-memory__match {
    background: var(--cinder-status-warning-background);
    color: var(--cinder-status-warning-text);
    border-radius: var(--cinder-radius-sm);
  }

  .ib-memory__facts {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--cinder-space-1) var(--cinder-space-3);
  }
</style>
