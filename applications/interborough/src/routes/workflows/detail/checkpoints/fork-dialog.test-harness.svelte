<script lang="ts">
  /**
   * Test-only harness composing `<WorkflowRouteHarness>` (provides the
   * `PrincipalStore` `ForkDialog` reads via `getPrincipalStore()` for its
   * revision-picker scope gate) around `<ForkDialog>` directly — mirrors
   * `checkpoints-tab.test-harness.svelte`'s identical pattern, scoped to
   * just this one component per WFT-117's own dedicated `fork-dialog.test.ts`.
   */
  import { HttpClient, HttpClientError } from '@lostgradient/weft';
  import type { QueryClient } from '@tanstack/svelte-query';

  import type { Principal } from '../../../../lib/scopes.svelte.ts';
  import WorkflowRouteHarness from '../../list/workflow-route-harness.test-harness.svelte';
  import ForkDialog from './fork-dialog.svelte';
  import type { ForkPreviewClient } from './fork-comparison-data.ts';
  import { forkOperations } from './fork-comparison.test-support.ts';
  import type { WorkflowRevisionListClient } from './fork-revision-picker.ts';

  interface Props {
    /** `get` (the open-time source refetch, COR-15) is optional here; a harness default resolves a purged run so tests that don't care about it keep the page-load revision. */
    client: {
      get?: (workflowId: string) => Promise<{ readonly revision?: string | undefined } | null>;
      /** The preview operation (COR-2538) defaults to a preview that keeps one step and runs one again. */
      operations: WorkflowRevisionListClient['operations'] &
        Partial<ForkPreviewClient['operations']>;
    };
    workflowId: string;
    initialStep: number;
    workflowType: string;
    sourceRevision: string | undefined;
    principal: Principal;
    queryClient: QueryClient;
    onForked?: (forkedWorkflowId: string) => void;
  }

  let {
    client,
    workflowId,
    initialStep,
    workflowType,
    sourceRevision,
    principal,
    queryClient,
    onForked = () => {},
  }: Props = $props();

  // See `checkpoints-tab.test-harness.svelte`'s identical note: nothing
  // under `<ForkDialog>` reads the context client, only the explicit
  // `client` prop.
  const contextClient = new HttpClient({ baseUrl: 'http://weft.test' });
</script>

<WorkflowRouteHarness client={contextClient} {principal} {queryClient}>
  <ForkDialog
    client={{
      ...client,
      operations: {
        'weft.workflows.fork': forkOperations()['weft.workflows.fork'],
        ...client.operations,
        'weft.workflows.get': async ({ workflowId }: { workflowId: string }) => {
          const value = await client.get?.(workflowId);
          if (value == null) throw new HttpClientError(404, 'missing');
          return value;
        },
      },
    }}
    {workflowId}
    {initialStep}
    {workflowType}
    {sourceRevision}
    {onForked}
  />
</WorkflowRouteHarness>
