<script lang="ts">
  /**
   * The tasks on the open worker's queue (rows 78n to 78p, 79b to 79e): a section headed "Tasks on
   * the reports queue" with a segmented control over All, Waiting and Failed for good (each with
   * its count), and, on the failed tab, Retry all and Clear all. A failed task leads with the red
   * status word, names the activity and the run it is for, says how many tries it took and why,
   * and carries Retry, Clear and a link to its payload; a waiting one is listed in the order it
   * arrived with nothing to act on. A page of waiting tasks ends in "Showing 3 of 12 waiting
   * tasks" and Load more. A retry needs no confirmation, since it only puts the task back; a clear
   * is held for an Undo (`queue-task-clear.svelte.ts`).
   *
   * The route owns the reads and the writes; this section decides only how they are laid out.
   */
  import {
    Alert,
    Button,
    DataList,
    Link,
    LoadMore,
    Segment,
    SegmentedControl,
    Skeleton,
    StackedListItem,
    StatusDot,
    Tooltip,
    type StackedListItemAction,
  } from '@lostgradient/cinder';
  import { RefreshCw, Trash2 } from '@lucide/svelte';

  import { router, workflowDetailPath } from '../../lib/router.svelte.ts';
  import type { ScopeGate } from '../../lib/scopes.svelte.ts';
  import { queueTaskRows, type QueueTaskRow } from './queue-task-rows.ts';
  import type { QueueTask, QueueTaskTab } from './queue-tasks-data.ts';
  import { WORKER_COPY } from './worker-copy.ts';

  interface Props {
    readonly queue: string;
    readonly tab: QueueTaskTab;
    readonly onTabChange: (tab: QueueTaskTab) => void;
    /** The queue's counts, with any clear that is held already taken off; `undefined` until read. */
    readonly counts: { readonly waiting: number; readonly failed: number } | undefined;
    /** The tasks loaded for the tab, with the ones a clear is holding out already left out. */
    readonly tasks: readonly QueueTask[];
    /** The failed tasks Retry has put back and that have not been read again. */
    readonly retrying: ReadonlySet<string>;
    /** Whether Retry all is in flight, and how many tasks it is putting back. */
    readonly retryingCount: number;
    readonly loading: boolean;
    readonly error: unknown;
    readonly onReload: () => void;
    readonly hasMore: boolean;
    readonly loadingMore: boolean;
    readonly onLoadMore: () => Promise<void>;
    readonly adminGate: ScopeGate;
    readonly onRetryAll: () => void;
    readonly onClearAll: () => void;
    readonly onRetry: (operationId: string) => void;
    readonly onClear: (operationId: string) => void;
    readonly onViewPayload: (operationId: string, name: string) => void;
    /** Reference instant for the times; defaults to render time. */
    readonly now?: number;
  }

  let {
    queue,
    tab,
    onTabChange,
    counts,
    tasks,
    retrying,
    retryingCount,
    loading,
    error,
    onReload,
    hasMore,
    loadingMore,
    onLoadMore,
    adminGate,
    onRetryAll,
    onClearAll,
    onRetry,
    onClear,
    onViewPayload,
    now = Date.now(),
  }: Props = $props();

  const copy = WORKER_COPY.tasks;
  const rows = $derived(queueTaskRows(tasks, queue, retrying, now));
  const failedCount = $derived(counts?.failed ?? 0);
  const waitingCount = $derived(counts?.waiting ?? 0);
  const retryAllBusy = $derived(retryingCount > 0);
  const hasFailedRows = $derived(rows.some((row) => row.failed));
  const showBulk = $derived(tab === 'failed' && (failedCount > 0 || retryAllBusy));

  function rowActions(row: QueueTaskRow): StackedListItemAction[] {
    if (!row.failed) return [];
    const disabled = adminGate.disabled;
    const reason = adminGate.title;
    return [
      {
        label: copy.retry,
        onclick: () => onRetry(row.id),
        disabled,
        ...(disabled && reason !== undefined ? { disabledReason: reason } : {}),
      },
      {
        label: copy.clear,
        onclick: () => onClear(row.id),
        disabled,
        ...(disabled && reason !== undefined ? { disabledReason: reason } : {}),
      },
    ];
  }

  /** Opens a run in place, and leaves a modified click to the browser. */
  function openRun(event: MouseEvent, id: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(workflowDetailPath(id));
  }
</script>

{#snippet bulkButton(
  label: string,
  disabled: boolean,
  onclick: () => void,
  glyph: 'retry' | 'clear',
)}
  {#if adminGate.disabled}
    <Tooltip text={adminGate.title ?? ''}>
      <Button variant="secondary" size="sm" disabled {label}>
        {#snippet leadingIcon()}
          {#if glyph === 'retry'}<RefreshCw size={14} aria-hidden="true" />{:else}<Trash2
              size={14}
              aria-hidden="true"
            />{/if}
        {/snippet}
      </Button>
    </Tooltip>
  {:else}
    <Button data-changes variant="secondary" size="sm" {label} {disabled} {onclick}>
      {#snippet leadingIcon()}
        {#if glyph === 'retry'}<RefreshCw size={14} aria-hidden="true" />{:else}<Trash2
            size={14}
            aria-hidden="true"
          />{/if}
      {/snippet}
    </Button>
  {/if}
{/snippet}

<section class="ib-worker-tasks" aria-labelledby="worker-tasks-heading" data-testid="worker-tasks">
  <div class="ib-worker-tasks__top">
    <h3 id="worker-tasks-heading" class="ib-worker-tasks__heading">{copy.heading(queue)}</h3>
    <div class="ib-worker-tasks__controls">
      {#if counts !== undefined}
        <SegmentedControl
          id="worker-tasks-tab"
          label={copy.tabsLabel}
          labelVisible={false}
          density="toolbar"
          value={tab}
          onValueChange={(next: QueueTaskTab) => onTabChange(next)}
        >
          <Segment value="all" count={waitingCount + failedCount}>{copy.all}</Segment>
          <Segment value="waiting" count={waitingCount}>{copy.waiting}</Segment>
          <Segment value="failed" count={failedCount}>{copy.failed}</Segment>
        </SegmentedControl>
      {/if}
      {#if showBulk}
        {@render bulkButton(
          retryAllBusy ? copy.retrying(retryingCount) : copy.retryAll(failedCount),
          retryAllBusy,
          onRetryAll,
          'retry',
        )}
        {@render bulkButton(copy.clearAll(failedCount), retryAllBusy, onClearAll, 'clear')}
      {/if}
    </div>
  </div>

  {#if loading}
    <div role="status" aria-busy="true" aria-label={copy.heading(queue)}>
      <Skeleton height="2.5rem" />
      <Skeleton height="2.5rem" />
    </div>
  {:else if error !== null && error !== undefined}
    <Alert variant="danger">
      {copy.loadFailure}
      <Button variant="ghost-accent" size="sm" label={copy.tryAgain} onclick={onReload} />
    </Alert>
  {:else if rows.length === 0}
    <p class="ib-worker-tasks__empty" data-testid="worker-tasks-empty">
      {#if tab === 'failed'}
        {copy.emptyFailed(waitingCount)}
      {:else if tab === 'waiting'}
        {copy.emptyWaiting(failedCount)}
      {:else}
        {copy.emptyAll}
      {/if}
    </p>
  {:else}
    <DataList items={rows} key={(row: QueueTaskRow) => row.id} statusColumn>
      {#snippet children(row)}
        <StackedListItem wrapMeta data-task={row.id} data-word={row.word} actions={rowActions(row)}>
          {#snippet status()}<StatusDot word={row.word} size="sm" />{/snippet}
          {#snippet title()}
            <span class="ib-worker-tasks__title">
              <code class="ib-worker-tasks__name" title={row.id}>{row.name}</code>
              {#if row.run !== undefined}
                {copy.forThe}
                <Link
                  href={router.href(workflowDetailPath(row.run.id))}
                  onclick={(event: MouseEvent) =>
                    row.run !== undefined && openRun(event, row.run.id)}>{row.run.label}</Link
                >
              {/if}
            </span>
          {/snippet}
          {#snippet time()}{row.time}{/snippet}
          {#snippet meta()}
            {row.line}
            {#if row.failed}
              <Button
                variant="ghost-accent"
                size="sm"
                label={copy.viewPayload}
                onclick={() => onViewPayload(row.id, row.name)}
              />
            {/if}
          {/snippet}
        </StackedListItem>
      {/snippet}
    </DataList>

    {#if tab === 'waiting' && counts !== undefined && waitingCount > rows.length}
      <LoadMore
        variant="footer"
        {hasMore}
        loading={loadingMore}
        loadedCount={rows.length}
        totalCount={waitingCount}
        countNoun={copy.showing}
        itemLabel={copy.showing}
        buttonLabel={copy.loadMore}
        endOfListMessage=""
        maxRetries={0}
        {onLoadMore}
      />
    {/if}
    {#if hasFailedRows}
      <p class="ib-worker-tasks__footnote">{copy.footnote}</p>
    {/if}
  {/if}
</section>

<style>
  .ib-worker-tasks {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    min-width: 0;
  }

  .ib-worker-tasks__top {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--cinder-space-2) var(--cinder-space-4);
  }

  .ib-worker-tasks__heading {
    margin: 0;
    font-size: var(--cinder-text-base);
    font-weight: 600;
  }

  .ib-worker-tasks__controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--cinder-space-2);
  }

  .ib-worker-tasks__title {
    min-width: 0;
  }

  .ib-worker-tasks__name {
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-sm);
    overflow-wrap: anywhere;
  }

  .ib-worker-tasks__empty {
    margin: 0;
    padding-block: var(--cinder-space-6);
    text-align: center;
    color: var(--cinder-text-muted);
  }

  .ib-worker-tasks__footnote {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }
</style>
