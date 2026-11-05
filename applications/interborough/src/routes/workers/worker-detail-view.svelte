<script lang="ts">
  /**
   * The open worker (rows 78k to 78m, 78w, 79g, 79i): its name with its id small and monospaced
   * beside it, a status line (the status dot and word, then when it was last heard from), and the
   * one action it has: Drain for a worker that takes work, Resume for one that is draining, Forget
   * for one that went away or stopped. A worker that went away and left its queue with nobody
   * under a warning notice, a facts row (the queue, what it runs now, what it serves, its
   * version), and the tasks on its queue, which the route supplies.
   *
   * An id too long to sit beside the heading (a generated one) wraps on its own line under it with
   * a Copy button, and the list shows its end, which is what tells such workers apart.
   */
  import {
    Alert,
    Button,
    CopyButton,
    DescriptionList,
    StatusDot,
    Tooltip,
    type DescriptionListItem,
  } from '@lostgradient/cinder';
  import { Droplets, Trash2, TriangleAlert } from '@lucide/svelte';
  import type { Snippet } from 'svelte';

  import type { ScopeGate } from '../../lib/scopes.svelte.ts';
  import type { WorkerSummary } from './worker-catalog-types.ts';
  import { WORKER_COPY } from './worker-copy.ts';
  import {
    hasLongId,
    humanizeWorkflowType,
    queueHasNoRunner,
    workerName,
    workerStatusLine,
    workerStatusOf,
    workerVersion,
  } from './worker-model.ts';

  interface Props {
    readonly worker: WorkerSummary;
    /** Every worker the server lists, for whether anything else runs this worker's queue. */
    readonly workers: readonly WorkerSummary[];
    readonly adminGate: ScopeGate;
    /** How many tasks wait on the worker's queue and failed for good there; `undefined` until read. */
    readonly counts: { readonly waiting: number; readonly failed: number } | undefined;
    readonly onDrain: () => void;
    readonly onResume: () => void;
    readonly onForget: () => void;
    /** The tasks on the worker's queue. */
    readonly tasks: Snippet;
    /** Reference instant for relative times; defaults to render time. */
    readonly now?: number;
  }

  let {
    worker,
    workers,
    adminGate,
    counts,
    onDrain,
    onResume,
    onForget,
    tasks,
    now = Date.now(),
  }: Props = $props();

  const copy = WORKER_COPY.detail;
  const status = $derived(workerStatusOf(worker));
  const longId = $derived(hasLongId(worker));
  const version = $derived(workerVersion(worker));
  const serves = $derived(
    (worker.workflows ?? []).map((type) => humanizeWorkflowType(type)).join(', '),
  );
  // Only a worker that went away leaves its queue with nobody; one that was told to stop did not.
  const showNotice = $derived(status === 'Disconnected' && queueHasNoRunner(workers, worker));

  const facts = $derived<DescriptionListItem[]>([
    { id: 'queues', term: copy.facts.queues, definition: worker.queue },
    {
      id: 'running',
      term: copy.facts.running,
      definition: copy.facts.runningValue(worker.inFlight),
    },
    { id: 'serves', term: copy.facts.serves, definition: serves === '' ? copy.facts.none : serves },
    {
      id: 'version',
      term: copy.facts.version,
      definition: version === undefined ? copy.facts.none : versionValue,
    },
  ]);
</script>

{#snippet versionValue()}<code class="ib-worker-detail__version">{version}</code>{/snippet}

{#snippet action()}
  {#if adminGate.disabled}
    <Tooltip text={adminGate.title ?? ''}>
      <Button
        variant="secondary"
        size="sm"
        disabled
        label={status === 'Connected'
          ? copy.drain
          : status === 'Draining'
            ? copy.resume
            : copy.forget}
      />
    </Tooltip>
  {:else if status === 'Connected'}
    <Button data-changes variant="secondary" size="sm" label={copy.drain} onclick={onDrain}>
      {#snippet leadingIcon()}<Droplets size={14} aria-hidden="true" />{/snippet}
    </Button>
  {:else if status === 'Draining'}
    <Button data-changes variant="secondary" size="sm" label={copy.resume} onclick={onResume} />
  {:else}
    <Button data-changes variant="secondary" size="sm" label={copy.forget} onclick={onForget}>
      {#snippet leadingIcon()}<Trash2 size={14} aria-hidden="true" />{/snippet}
    </Button>
  {/if}
{/snippet}

<div class="ib-worker-detail" data-testid="worker-detail" data-status={status}>
  <header class="ib-worker-detail__top">
    <div class="ib-worker-detail__identity">
      <div class="ib-worker-detail__title-row">
        <h2 class="ib-worker-detail__name">{workerName(worker)}</h2>
        {#if !longId}
          <code class="ib-worker-detail__id" data-testid="worker-id">{worker.id}</code>
        {/if}
      </div>
      {#if longId}
        <div class="ib-worker-detail__long-id">
          <code class="ib-worker-detail__id" data-testid="worker-id">{worker.id}</code>
          <CopyButton value={worker.id} label={copy.copyLabel} copiedLabel={copy.copied}>
            {copy.copy}
            {#snippet confirmation()}{copy.copied}{/snippet}
          </CopyButton>
        </div>
      {/if}
      <p class="ib-worker-detail__status">
        <StatusDot word={status} size="sm" />
        <span data-testid="worker-status-line">{workerStatusLine(worker, now)}</span>
      </p>
    </div>
    <div class="ib-worker-detail__actions">{@render action()}</div>
  </header>

  {#if showNotice}
    <Alert variant="warning" data-testid="worker-notice">
      {#snippet icon()}<TriangleAlert size={16} aria-hidden="true" />{/snippet}
      <strong>{copy.notice.lead(worker.queue)}</strong>
      {copy.notice.body(worker.queue, counts?.waiting ?? 0, counts?.failed ?? 0)}
    </Alert>
  {/if}

  <DescriptionList items={facts} variant="facts" data-testid="worker-facts" />

  {@render tasks()}
</div>

<style>
  .ib-worker-detail {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-4);
    min-width: 0;
  }

  .ib-worker-detail__top {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--cinder-space-2) var(--cinder-space-4);
  }

  .ib-worker-detail__identity {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-1);
    min-width: 0;
    flex: 1 1 16rem;
  }

  .ib-worker-detail__title-row {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--cinder-space-2) var(--cinder-space-3);
    min-width: 0;
  }

  .ib-worker-detail__name {
    margin: 0;
    font-size: var(--cinder-text-xl);
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .ib-worker-detail__id,
  .ib-worker-detail__version {
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-xs);
    overflow-wrap: anywhere;
  }

  .ib-worker-detail__long-id {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--cinder-space-2);
  }

  .ib-worker-detail__status {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--cinder-space-1) var(--cinder-space-3);
    margin: 0;
    color: var(--cinder-text-muted);
  }

  .ib-worker-detail__actions {
    flex: none;
  }
</style>
