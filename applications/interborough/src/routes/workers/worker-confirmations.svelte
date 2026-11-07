<script lang="ts">
  /**
   * The two confirmations of the Workers page (rows 78q, 78s, 78t): Drain and Forget each ask first
   * in a Cinder confirm dialog that says what happens to the work the worker is running and the
   * work waiting for its queue. Neither is destructive: a drained worker can be resumed, and a
   * forgotten one shows up again when it checks in, so the confirm button is a primary button and
   * never a danger one. Cancel takes initial focus.
   */
  import { ConfirmDialog } from '@lostgradient/cinder';

  import type { WorkerSummary } from './worker-catalog-types.ts';
  import { WORKER_COPY } from './worker-copy.ts';
  import { drainSuccessor, workerName } from './worker-model.ts';

  export type WorkerConfirmation =
    | { readonly kind: 'drain'; readonly worker: WorkerSummary }
    | { readonly kind: 'forget'; readonly worker: WorkerSummary };

  interface Props {
    /** What is being confirmed, or `null` while nothing is. */
    readonly confirmation: WorkerConfirmation | null;
    /** Every worker the server lists, for who takes a drained worker's new tasks. */
    readonly workers: readonly WorkerSummary[];
    /** How many tasks wait on the worker's queue and failed for good there. */
    readonly counts: { readonly waiting: number; readonly failed: number } | undefined;
    readonly busy: boolean;
    readonly onConfirm: () => void;
    readonly onCancel: () => void;
  }

  let { confirmation, workers, counts, busy, onConfirm, onCancel }: Props = $props();

  const open = $derived(confirmation !== null);
  const title = $derived.by(() => {
    if (confirmation === null) return '';
    const name = workerName(confirmation.worker);
    return confirmation.kind === 'drain'
      ? WORKER_COPY.drain.title(name)
      : WORKER_COPY.forget.title(name);
  });
  const description = $derived.by(() => {
    if (confirmation === null) return '';
    const { worker } = confirmation;
    if (confirmation.kind === 'drain') {
      return WORKER_COPY.drain.body(worker.inFlight, worker.queue, drainSuccessor(workers, worker));
    }
    return WORKER_COPY.forget.body(worker.queue, counts?.waiting ?? 0, counts?.failed ?? 0);
  });
  const confirmLabel = $derived(
    confirmation?.kind === 'forget' ? WORKER_COPY.forget.confirm : WORKER_COPY.drain.confirm,
  );
</script>

<ConfirmDialog {open} {title} {description} {confirmLabel} {busy} {onConfirm} {onCancel} />
