<script lang="ts">
  /**
   * Why the Bureau cannot use a workflow file: the problem's code and message, and each issue with
   * the path it names. The list, a workflow's page, and the editor all say it the same way.
   */
  import { keyedByOccurrence } from '../../lib/list-keys.ts';
  import type { WorkflowProblem } from '../../lib/workflow-files.ts';

  interface Props {
    problem: WorkflowProblem;
  }

  let { problem }: Props = $props();
</script>

<p class="weft-workflow-problem" data-testid="workflow-problem">
  <code>{problem.code}</code>: {problem.message}
</p>
{#if problem.issues !== null && problem.issues.length > 0}
  <ul class="weft-workflow-issues" data-testid="workflow-issues">
    {#each keyedByOccurrence(problem.issues, (issue) => `${issue.path}:${issue.message}`) as { key, item: issue } (key)}
      <li><code>{issue.path}</code>: {issue.message}</li>
    {/each}
  </ul>
{/if}

<style>
  .weft-workflow-problem {
    margin: 4px 0 0;
    font-size: var(--cinder-text-sm);
    overflow-wrap: anywhere;
  }

  .weft-workflow-issues {
    margin: 4px 0 0;
    padding-inline-start: var(--cinder-space-6);
    font-size: var(--cinder-text-sm);
    overflow-wrap: anywhere;
  }
</style>
