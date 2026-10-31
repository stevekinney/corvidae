<script lang="ts">
  /**
   * What went into a run and what came out of it: the workflow's input, the agent's answer
   * (rendered as Markdown, and followed live while the task runs), and the workflow's result, or
   * why it failed. A run only the workflow engine holds has its input and result here; a run only
   * the Bureau holds has its answer; a run of a workflow file that the engine does not hold has the
   * Bureau's record of its trigger, result and error.
   */
  import { Badge, Collapsible, PayloadInspector } from '@lostgradient/cinder';
  import type { WorkflowState } from '@lostgradient/weft';
  import { CircleX } from '@lucide/svelte';

  import { RUN_PAGE_COPY, TASK_COPY } from '../../../app/copy.ts';
  import { isTerminalState, type TaskView } from '../../../lib/bureau-tasks.ts';
  import type { WorkflowFileRunDetail } from '../../../lib/workflow-files.ts';
  import { failureCategoryExplanation, failureCategoryLabel } from '../detail/failure-category.ts';

  interface RunInputOutputProps {
    /** The Bureau's task, whose answer is shown. */
    task?: TaskView | undefined;
    /** The agent's answer, as Markdown rendered to HTML (`renderMarkdown`), once there is one. */
    answerHtml?: string | undefined;
    /** Whether the answer was cut short. */
    answerTruncated?: boolean | undefined;
    /** The state of the live follow of the task, for the sentence under the answer. */
    followState?: string | undefined;
    /** The engine's run. */
    workflow?: WorkflowState | undefined;
    /** The Bureau's record of a workflow file's run, when the engine does not hold it. */
    record?: WorkflowFileRunDetail | undefined;
  }

  let {
    task,
    answerHtml,
    answerTruncated = false,
    followState,
    workflow,
    record,
  }: RunInputOutputProps = $props();

  const hasAnswer = $derived(answerHtml !== undefined && answerHtml.trim() !== '');
  const errorStack = $derived(workflow?.errorStack ?? '');
</script>

<section class="ib-run__section" aria-labelledby="ib-run-io" data-section="input-output">
  <h2 id="ib-run-io" class="ib-run__heading-2">{RUN_PAGE_COPY.inputOutputHeading}</h2>

  {#if workflow !== undefined}
    <h3 class="ib-run__heading-3">{RUN_PAGE_COPY.inputHeading}</h3>
    <PayloadInspector value={workflow.input} label={RUN_PAGE_COPY.inputPayload} />
  {:else if record !== undefined}
    <h3 class="ib-run__heading-3">{RUN_PAGE_COPY.inputHeading}</h3>
    <PayloadInspector value={record.trigger} label={RUN_PAGE_COPY.inputPayload} />
  {/if}

  {#if task !== undefined}
    <h3 class="ib-run__heading-3">{TASK_COPY.answerHeading}</h3>
    {#if hasAnswer}
      <!-- eslint-disable-next-line svelte/no-at-html-tags -->
      <div class="weft-artifact-markdown ib-run__answer">{@html answerHtml}</div>
      {#if answerTruncated}<p class="ib-run__note">{TASK_COPY.answerTruncated}</p>{/if}
    {:else}
      <p class="ib-run__note">
        {isTerminalState(task.status) ? TASK_COPY.noAnswer : TASK_COPY.noAnswerYet}
      </p>
    {/if}
    {#if followState === 'unavailable'}
      <p class="ib-run__note" role="status">{TASK_COPY.followUnavailable}</p>
    {:else if followState === 'reconnecting'}
      <p class="ib-run__note" role="status">{TASK_COPY.followReconnecting}</p>
    {/if}
  {/if}

  {#if workflow !== undefined}
    {#if workflow.status === 'completed'}
      <h3 class="ib-run__heading-3">{RUN_PAGE_COPY.resultHeading}</h3>
      <PayloadInspector value={workflow.result} label={RUN_PAGE_COPY.resultPayload} />
    {:else if workflow.status === 'failed'}
      <div class="weft-overview-tab__failure">
        <div class="weft-overview-tab__failure-title">
          <CircleX aria-hidden="true" size={18} />
          <span>Failed</span>
          {#if workflow.failureCategory !== undefined}
            <Badge variant="danger">{failureCategoryLabel(workflow.failureCategory)}</Badge>
          {/if}
        </div>
        {#if workflow.failureCategory !== undefined}
          <p class="weft-overview-tab__failure-explanation">
            {failureCategoryExplanation(workflow.failureCategory)}
          </p>
        {/if}
        {#if workflow.error}
          <p class="weft-overview-tab__failure-explanation">{workflow.error}</p>
        {/if}
        {#if errorStack.length > 0}
          <Collapsible trigger="Show full stack trace">
            <pre class="weft-send-tab__result">{errorStack}</pre>
          </Collapsible>
        {/if}
      </div>
    {:else if workflow.status === 'cancelled' || workflow.status === 'timed-out'}
      <div class="weft-overview-tab__pending-result">
        This run ended as <strong
          >{workflow.status === 'cancelled' ? 'cancelled' : 'timed out'}</strong
        > — no result value.
      </div>
    {:else}
      <div class="weft-overview-tab__pending-result">
        <span class="ib-run__spinner" aria-hidden="true"></span>
        Result pending — workflow still {workflow.status}.
      </div>
    {/if}
  {:else if record !== undefined}
    {#if record.result !== undefined && record.result !== null}
      <h3 class="ib-run__heading-3">{RUN_PAGE_COPY.resultHeading}</h3>
      <PayloadInspector value={record.result} label={RUN_PAGE_COPY.resultPayload} />
    {/if}
    {#if record.error !== undefined && record.error !== null}
      <h3 class="ib-run__heading-3">{TASK_COPY.runRecord.error}</h3>
      <p class="ib-run__note">{record.error}</p>
    {/if}
  {/if}
</section>
