<script lang="ts">
  /**
   * Test-only harness composing `<WorkflowRouteHarness>` (the list track's
   * shared context provider — `CheckpointsTab` reads `getPrincipalStore()`
   * for the replay scope gate) around `<CheckpointsTab>`.
   */
  import { HttpClient, HttpClientError } from '@lostgradient/weft';
  import type { QueryClient } from '@tanstack/svelte-query';

  import type { Principal } from '../../../../lib/scopes.svelte.ts';
  import WorkflowRouteHarness from '../../list/workflow-route-harness.test-harness.svelte';
  import CheckpointsTab from './checkpoints-tab.svelte';
  import type { CheckpointsOperationsClient, ReplayClient } from './checkpoints-data.ts';
  import type { ForkComparisonClient, ForkPreviewClient } from './fork-comparison-data.ts';
  import { forkOperations } from './fork-comparison.test-support.ts';
  import type { WorkflowRevisionListClient } from './fork-revision-picker.ts';

  interface Props {
    client: Omit<CheckpointsOperationsClient, 'operations'> &
      Omit<WorkflowRevisionListClient, 'operations'> & {
        /** The comparison and the fork's dry run (COR-2538) default to an empty comparison and a one-step preview. */
        operations: CheckpointsOperationsClient['operations'] &
          ReplayClient['operations'] &
          WorkflowRevisionListClient['operations'] &
          Partial<ForkComparisonClient['operations'] & ForkPreviewClient['operations']>;
        /** The fork dialog's open-time source refetch (COR-15); defaults to "purged" so tests that don't care keep the page-load revision. */
        get?: (workflowId: string) => Promise<{ readonly revision?: string | undefined } | null>;
      };
    workflowId: string;
    principal: Principal;
    queryClient: QueryClient;
    workflowType?: string;
    sourceRevision?: string;
  }

  let {
    client,
    workflowId,
    principal,
    queryClient,
    workflowType = 'test-workflow',
    sourceRevision,
  }: Props = $props();

  // `WorkflowRouteHarness` requires a full `HttpClient` for its context
  // (`getClient()`) — nothing under `<CheckpointsTab>` reads it, every
  // component here takes `client` as an explicit prop instead, so a real,
  // never-invoked instance satisfies the type without hand-duplicating the
  // whole interface or reaching for an unsafe cast.
  const contextClient = new HttpClient({ baseUrl: 'http://weft.test' });
</script>

<WorkflowRouteHarness client={contextClient} {principal} {queryClient}>
  <CheckpointsTab
    client={{
      ...client,
      operations: {
        ...forkOperations(),
        ...client.operations,
        'weft.workflows.get': async ({ workflowId }: { workflowId: string }) => {
          const value = await client.get?.(workflowId);
          if (value == null) throw new HttpClientError(404, 'missing');
          return value;
        },
      },
    }}
    {workflowId}
    {workflowType}
    {sourceRevision}
  />
</WorkflowRouteHarness>
