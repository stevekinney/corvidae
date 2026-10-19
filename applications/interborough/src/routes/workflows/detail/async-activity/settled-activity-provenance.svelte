<script lang="ts">
  /**
   * Worker provenance for an activity that has settled (COR-281). A remote `ctx.run()` enqueues its
   * task under a token Weft derives from the workflow id, the activity's step, and the dispatch
   * attempt (`deriveAsyncActivityToken`), so the ledger can be read for a finished activity too,
   * with no pending record to hand over the token. Attempts are read in order, `1` upward, until
   * the ledger has no record; each one that has a record gets the same attempt history the
   * in-flight drawer shows.
   *
   * An activity that ran in-process never reached the ledger, so the first attempt is already
   * absent and the panel says no worker task is recorded.
   */
  import { EmptyState, Skeleton } from '@lostgradient/cinder';
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';
  import Lock from '@lucide/svelte/icons/lock';
  import { deriveAsyncActivityToken } from '@lostgradient/weft';

  import { FAULT_TREATMENT_TITLE, faultTreatment } from '../../../../lib/faults.ts';
  import { queryKeys } from '../../../../lib/query.ts';
  import { isForbidden, scopeReason } from '../../../../lib/scopes.svelte.ts';
  import {
    MalformedTaskLedgerError,
    parseTaskLedgerDetail,
  } from '../../../workers/workers-data.ts';
  import ActivityWorkerProvenance, {
    PROVENANCE_STALE_TIME_MS,
  } from './activity-worker-provenance.svelte';

  /** More attempts than any activity retry policy is expected to dispatch through the engine. */
  const MAX_ATTEMPTS_READ = 10;

  interface SettledActivityProvenanceProps {
    readonly workflowId: string;
    /** The activity's timeline step, which is its async token's state key. */
    readonly step: number;
    readonly readTask: (input: { operationId: string }) => Promise<unknown>;
  }

  let { workflowId, step, readTask }: SettledActivityProvenanceProps = $props();

  const queryClient = useQueryClient();

  // Each read goes into the task-detail cache under the key the attempt's panel uses, so the
  // panel renders from what the probe already read instead of reading it again.
  const tokensQuery = createQuery(() => ({
    queryKey: ['workflows', 'provenance', workflowId, String(step)],
    queryFn: async (): Promise<readonly string[]> => {
      const recorded: string[] = [];
      for (let attempt = 1; attempt <= MAX_ATTEMPTS_READ; attempt += 1) {
        const token = deriveAsyncActivityToken(workflowId, step, attempt);
        try {
          await queryClient.fetchQuery({
            queryKey: queryKeys.tasks.detail(token),
            queryFn: async () => parseTaskLedgerDetail(await readTask({ operationId: token })),
            staleTime: PROVENANCE_STALE_TIME_MS,
            retry: false,
          });
        } catch (error) {
          if (faultTreatment(error).kind === 'not-found') break;
          // A record the console cannot read still has a panel, which says so.
          if (error instanceof MalformedTaskLedgerError) {
            recorded.push(token);
            break;
          }
          throw error;
        }
        recorded.push(token);
      }
      return recorded;
    },
    retry: false,
  }));

  const error = $derived(tokensQuery.error);
</script>

{#if tokensQuery.isPending}
  <div role="status" aria-busy="true" aria-label="Loading worker provenance">
    <Skeleton height="6rem" />
  </div>
{:else if error && isForbidden(error)}
  <EmptyState
    title="Worker provenance is locked"
    description={`${scopeReason('system:read')} to read which worker ran each attempt.`}
  >
    {#snippet icon()}
      <Lock size={24} aria-hidden="true" />
    {/snippet}
  </EmptyState>
{:else if error}
  {@const treatment = faultTreatment(error)}
  <EmptyState title={FAULT_TREATMENT_TITLE[treatment.kind]} description={treatment.message} />
{:else if tokensQuery.data && tokensQuery.data.length === 0}
  <EmptyState
    title="No worker task recorded"
    description="The task ledger holds no record for this activity, so no worker has run it."
  />
{:else if tokensQuery.data}
  {#each tokensQuery.data as token, index (token)}
    <ActivityWorkerProvenance
      operationId={token}
      {readTask}
      heading={tokensQuery.data.length === 1
        ? 'Worker provenance'
        : `Worker provenance, dispatch ${index + 1}`}
    />
  {/each}
{/if}
