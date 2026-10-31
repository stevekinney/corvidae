/**
 * What a run's page reads from the workflow engine: the run itself (`weft.workflows.get`), the
 * finalizer work of a run that was cancelled or timed out, the revision the catalog has active,
 * and the four actions that move a run (cancel, suspend, resume and force a timeout), with the
 * clock the deadline counts down on.
 *
 * The page owns one of these instead of the sections owning a query each, because the header, the
 * Details rail and the sections all read the same run: one fetch, one status. It is created while a
 * component initializes (it opens queries and a subscription that end with that component), and it
 * asks the engine nothing for a caller who may not read it (`enabled`), so a page without engine
 * access holds no failed request.
 *
 * Fleet liveness: the shell applies every fleet frame (`connectFleetInvalidation`), which
 * invalidates `queryKeys.workflows.detail(id)` for any event naming this run, so the run, its
 * status and its finalizer refresh without this page subscribing to the feed for that. The finalizer
 * is fetched only while the status may carry one (`statusMayHaveFinalizer`), and the active revision
 * only once the run has answered, since the engine needs a type to look one up.
 */
import type { HttpClient, WorkflowFinalizerStatus, WorkflowState } from '@lostgradient/weft';
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';
import { onDestroy } from 'svelte';

import { getClient } from '../../../lib/client.ts';
import { faultTreatment, type FaultTreatment } from '../../../lib/faults.ts';
import { queryKeys } from '../../../lib/query.ts';
import { getPrincipalStore, scopeGate, type ScopeGate } from '../../../lib/scopes.svelte.ts';
import {
  fetchActiveWorkflowRevision,
  type WorkflowCatalogActivePointerLike,
} from '../../../lib/workflow-revision.ts';
import { TickingClock } from '../detail/ticking-clock.svelte.ts';
import { finalizerQueryKey, getFinalizerStatus } from '../detail/workflow-observability.ts';
import {
  ACTION_REQUIRED_SCOPE,
  statusMayHaveFinalizer,
  type WorkflowContextualAction,
} from '../detail/workflow-status.ts';

/** The engine's side of one run's page. */
export class RunEngine {
  /** The HTTP client the sections read and write through. */
  readonly client: HttpClient = getClient();
  /** Ticks while the page is open, for the deadline countdown and relative times. */
  readonly clock = new TickingClock();

  readonly #id: () => string;
  readonly #principal = getPrincipalStore();
  readonly #queryClient = useQueryClient();
  readonly #detail;
  readonly #finalizer;
  readonly #activeRevision;
  readonly #action;

  /** The action being carried out, or `null`. */
  pendingAction = $state<WorkflowContextualAction | null>(null);

  constructor(id: () => string, allowed: () => boolean) {
    this.#id = id;
    onDestroy(() => this.clock.dispose());

    this.#detail = createQuery(() => ({
      queryKey: queryKeys.workflows.detail(this.#id()),
      queryFn: () => this.client.get(this.#id()),
      enabled: allowed(),
    }));
    this.#finalizer = createQuery(() => ({
      queryKey: finalizerQueryKey(this.#id()),
      queryFn: () => getFinalizerStatus(this.client, this.#id()),
      enabled: allowed() && statusMayHaveFinalizer(this.#detail.data?.status ?? 'pending'),
    }));
    this.#activeRevision = createQuery(() => ({
      queryKey: queryKeys.catalog.active(this.#detail.data?.type ?? ''),
      queryFn: () => fetchActiveWorkflowRevision(this.client, this.#detail.data?.type ?? ''),
      enabled: allowed() && this.#detail.data != null,
    }));
    this.#action = createMutation(() => ({
      mutationFn: (action: WorkflowContextualAction) =>
        ACTION_CALL[action](this.client, this.#id()),
      onMutate: (action: WorkflowContextualAction) => {
        this.pendingAction = action;
      },
      onSettled: () => {
        this.pendingAction = null;
        void this.#queryClient.invalidateQueries({
          queryKey: queryKeys.workflows.detail(this.#id()),
        });
      },
    }));
  }

  /** The run, `null` when the engine does not hold it, `undefined` until it answers. */
  get workflow(): WorkflowState | null | undefined {
    return this.#detail.data;
  }

  /** Whether the engine answered that it does not hold the run. */
  get notFound(): boolean {
    return this.#detail.isSuccess && this.#detail.data === null;
  }

  /** How the read failed, when it did and no run was read before. */
  get fault(): FaultTreatment | null {
    return this.#detail.isError ? faultTreatment(this.#detail.error) : null;
  }

  /** The finalizer work of the run, `undefined` while unread, `null` when none was recorded. */
  get finalizerStatus(): WorkflowFinalizerStatus | null | undefined {
    return this.#finalizer.data;
  }

  /**
   * The catalog's active revision of the run's type. A failed read is `undefined` ("unknown"), not
   * the last pointer read: TanStack keeps the previous `data` beside `isError`, and a revoked scope
   * would otherwise keep labeling a superseded run Active.
   */
  get activeRevision(): WorkflowCatalogActivePointerLike | null | undefined {
    return this.#activeRevision.isError ? undefined : this.#activeRevision.data;
  }

  /** What `workflows:write` allows: cancel, suspend, resume and force a timeout. */
  get actionGate(): ScopeGate {
    return scopeGate(this.#principal, [ACTION_REQUIRED_SCOPE]);
  }

  /** Carries out one of the run's actions. */
  act(action: WorkflowContextualAction): void {
    this.#action.mutate(action);
  }

  /** Runs a read-only query of the workflow and resolves with its answer. */
  async runQuery(name: string, inputText: string): Promise<unknown> {
    const trimmed = inputText.trim();
    const input = trimmed.length === 0 ? undefined : (JSON.parse(trimmed) as unknown);
    return this.client.query(this.#id(), name, input);
  }
}

const ACTION_CALL: Readonly<
  Record<WorkflowContextualAction, (client: HttpClient, id: string) => Promise<unknown>>
> = {
  cancel: (client, id) => client.cancel(id),
  suspend: (client, id) => client.suspend(id),
  resume: (client, id) => client.resume(id),
  'force-timeout': (client, id) => client.timeout(id),
};
