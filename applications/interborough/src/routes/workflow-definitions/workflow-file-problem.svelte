<script lang="ts">
  /**
   * The danger banner of a workflow whose file the Bureau cannot read, under the tabs of its page:
   * the file's name and, when the page can place it, the line the problem is on, then why Start run
   * is off and that runs already going keep going, and the issues the Bureau found. One button
   * leads to where the problem is: "Open Code" from the Overview, "Edit as JSON" from the Code tab.
   */
  import { Alert, Button } from '@lostgradient/cinder';

  import { WORKFLOW_COPY } from '../../app/copy/workflows.ts';
  import { keyedByOccurrence } from '../../lib/list-keys.ts';
  import type { WorkflowProblem } from '../../lib/workflow-files.ts';
  import { problemSentence, type JsonProblem } from './workflow-source.ts';

  interface Props {
    /** The file's name with its extension, such as `order-refund.json`. */
    fileName: string;
    problem: WorkflowProblem;
    /** Where the JSON stops being JSON, when the page could place it. */
    located: JsonProblem | null;
    /** The button's words, and what it does. */
    actionLabel: string;
    onAction: () => void;
  }

  let { fileName, problem, located, actionLabel, onAction }: Props = $props();

  const copy = WORKFLOW_COPY.page.problem;
</script>

<Alert variant="danger" data-testid="workflow-file-problem">
  <div class="ib-workflow__problem">
    <p data-testid="workflow-problem">
      {problemSentence(fileName, problem, located)}
      {copy.startOff}
    </p>
    {#if problem.issues !== null && problem.issues.length > 0}
      <ul class="weft-workflow-issues" data-testid="workflow-issues">
        {#each keyedByOccurrence(problem.issues, (issue) => `${issue.path}:${issue.message}`) as { key, item: issue } (key)}
          <li><code>{issue.path}</code>: {issue.message}</li>
        {/each}
      </ul>
    {/if}
    <Button variant="secondary" size="sm" onclick={onAction}>{actionLabel}</Button>
  </div>
</Alert>
