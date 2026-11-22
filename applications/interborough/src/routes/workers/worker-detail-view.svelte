<script lang="ts">
  /**
   * The open worker (rows 78k to 78m, 78w, 79g, 79i): its name and an identifier copy control,
   * a status badge and when it was last heard from, and the
   * one action it has: Drain for a worker that takes work, Resume for one that is draining, Forget
   * for one that went away or stopped. A worker that went away and left its queue with nobody
   * under a warning notice, a facts row (the queue, what it runs now, what it serves, its
   * version), and the tasks on its queue, which the route supplies.
   */
  import {
    Alert,
    Badge,
    Button,
    CopyButton,
    DescriptionList,
    Tooltip,
    type BadgeVariant,
    type DescriptionListItem,
  } from '@lostgradient/cinder';
  import { Droplets, Trash2, TriangleAlert } from '@lucide/svelte';
  import type { Snippet } from 'svelte';

  import type { ScopeGate } from '../../lib/scopes.svelte.ts';
  import type { WorkerSummary } from './worker-catalog-types.ts';
  import { WORKER_COPY } from './worker-copy.ts';
  import {
    humanizeWorkflowType,
    queueHasNoRunner,
    workerStatusLine,
    workerStatusOf,
    workerVersion,
    type WorkerStatusWord,
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
  const badgeVariant = {
    Connected: 'success',
    Draining: 'warning',
    Disconnected: 'danger',
    Stopped: 'neutral',
  } satisfies Record<WorkerStatusWord, BadgeVariant>;
  const status = $derived(workerStatusOf(worker));
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
        <h2 class="ib-worker-detail__name">{worker.name ?? copy.unnamed}</h2>
        <CopyButton
          class="ib-worker-detail__copy"
          value={worker.id}
          label={copy.copyLabel}
          copiedLabel={copy.copied}
        />
      </div>
      <p class="ib-worker-detail__status">
        <Badge variant={badgeVariant[status]} size="sm">{status}</Badge>
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

  /* The Copy button stays beside the name, on the name's first row, however many rows a long name
   * takes (COR-2548): the row never wraps, the name shrinks and wraps inside its own box, and the
   * button keeps its size. No Cinder component pairs a title with a trailing action that holds
   * beside a wrapped title (`SectionHeading` and `PageHeader` move their actions to a row of their
   * own when narrow), so the pairing is drawn here. */
  .ib-worker-detail__title-row {
    display: flex;
    flex-wrap: nowrap;
    align-items: baseline;
    gap: var(--cinder-space-3);
    min-width: 0;
  }

  .ib-worker-detail__name {
    flex: 0 1 auto;
    min-inline-size: 0;
    margin: 0;
    font-size: var(--cinder-text-xl);
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .ib-worker-detail__title-row :global(.ib-worker-detail__copy) {
    flex: none;
  }

  .ib-worker-detail__version {
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-xs);
    overflow-wrap: anywhere;
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
