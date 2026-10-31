<script lang="ts">
  /**
   * "Which build would this workflow land on?" for one deployment. The answer
   * is Weft's own routing decision (`selectWorkerDeployment`), so a workflow id
   * typed here lands exactly where the runtime would send it at the pointer's
   * current generation.
   */
  import { Input } from '@lostgradient/cinder';
  import type { WorkerDeploymentRouting, WorkerDeploymentVersion } from '@lostgradient/weft';

  import { explainWorkflowBucket } from './deployments-presentation.ts';

  interface WorkflowBucketExplainerProps {
    readonly deploymentName: string;
    /** Unique id for the workflow id field. */
    readonly inputId: string;
    readonly routing: WorkerDeploymentRouting | null;
    readonly versions: readonly WorkerDeploymentVersion[];
  }

  let { deploymentName, inputId, routing, versions }: WorkflowBucketExplainerProps = $props();

  let workflowId = $state('');
  const trimmed = $derived(workflowId.trim());
  const explanation = $derived(
    trimmed === '' ? undefined : explainWorkflowBucket(deploymentName, trimmed, routing, versions),
  );
</script>

<div class="weft-bucket-explainer">
  <Input
    id={inputId}
    label="Workflow ID"
    description="Type a workflow ID to see which build it deterministically lands on."
    bind:value={workflowId}
    class="weft-workers-mono"
  />
  <p class="weft-bucket-explainer__answer" role="status">
    {explanation?.text ?? 'Enter a workflow ID to see its build.'}
  </p>
</div>
