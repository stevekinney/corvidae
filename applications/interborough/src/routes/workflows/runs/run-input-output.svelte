<script lang="ts">
  /**
   * What went into a run and what came out of it. A run that answered a chat message shows two
   * cards side by side: the message that started it ("Message in", From you) and what the agent
   * answered ("Reply out", From the agent, rendered as Markdown and followed live while the task
   * runs, held to a few lines until Show all). A run a schedule started has no chat, so its cards
   * read Prompt and Result. A run of a workflow shows the workflow's input and its output as two
   * payload cards of the same inspector, sharing one Fields or JSON choice; a run only the engine
   * holds has its input and result here, and a run of a workflow file the engine does not hold has
   * the Bureau's record of its trigger, result and error.
   */
  import { Badge, Button, Collapsible, VisuallyHidden } from '@lostgradient/cinder';
  import type { WorkflowState } from '@lostgradient/weft';
  import { CircleX } from '@lucide/svelte';
  import { createQuery } from '@tanstack/svelte-query';

  import { RUN_DETAIL_COPY, RUN_PAGE_COPY, TASK_COPY } from '../../../app/copy.ts';
  import { agentLabel } from '../../../lib/agent-label.ts';
  import { getThreadMessages } from '../../../lib/bureau-client.ts';
  import { isScheduleFire, isTerminalState, type TaskView } from '../../../lib/bureau-tasks.ts';
  import { dayAndTime } from '../../../lib/format/clock.ts';
  import type { WorkflowFileRunDetail } from '../../../lib/workflow-files.ts';
  import { failureCategoryExplanation, failureCategoryLabel } from '../detail/failure-category.ts';
  import { threadIdForTask } from './run-activity.ts';
  import { messageInOfRun } from './run-message-in.ts';
  import RunPayloadCards from './run-payload-cards.svelte';
  import { payloadViewPreference } from './run-payload-view.svelte.ts';

  interface RunInputOutputProps {
    /** The Bureau's task, whose message in and answer are shown. */
    task?: TaskView | undefined;
    /** The thread the task's message is in, when it is not the task's `contextId` (a goal's attempt). */
    threadId?: string | null | undefined;
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
    /** When the run started, in milliseconds, for the line under the message in. */
    startedAt?: number | undefined;
    /**
     * Opens the raw payloads under How it ran. The link under the reply is there only when the
     * page gives this.
     */
    onShowRaw?: (() => void) | undefined;
    /**
     * Whether a task's workflow input and output are shown here too, as cards under the message
     * and the reply. The page turns it off when it shows them under How it ran.
     */
    showRaw?: boolean;
  }

  /** The reply is held to this many characters of text before Show all. */
  const CLAMP_ABOVE = 420;

  let {
    task,
    threadId,
    answerHtml,
    answerTruncated = false,
    followState,
    workflow,
    record,
    startedAt,
    onShowRaw,
    showRaw = true,
  }: RunInputOutputProps = $props();

  const copy = RUN_DETAIL_COPY.io;
  const hasAnswer = $derived(answerHtml !== undefined && answerHtml.trim() !== '');
  const errorStack = $derived(workflow?.errorStack ?? '');
  const scheduled = $derived(task !== undefined && isScheduleFire(task));
  const agent = $derived(
    task?.agentName === null || task?.agentName === undefined
      ? TASK_COPY.unknownAgent
      : agentLabel(task.agentName, undefined),
  );

  const taskThreadId = $derived(task === undefined ? undefined : threadIdForTask(task, threadId));
  const threadToRead = $derived(
    task === undefined ? null : taskThreadId === undefined ? task.contextId : taskThreadId,
  );
  const thread = createQuery(
    () => ({
      queryKey: ['bureau-tasks', 'message-in', threadToRead, task?.id ?? ''] as const,
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        getThreadMessages(threadToRead ?? '', { signal }),
      enabled: task !== undefined && threadToRead !== null && threadToRead !== '',
      retry: false,
    }),
    undefined,
  );
  const messageIn = $derived(
    task === undefined || thread.data === undefined
      ? undefined
      : messageInOfRun(task.id, thread.data),
  );

  const description = $derived(
    task !== undefined
      ? scheduled
        ? copy.scheduleDescription
        : copy.chatDescription
      : copy.workflowDescription,
  );
  const clamps = $derived(
    answerHtml !== undefined && answerHtml.replace(/<[^>]*>/g, '').length > CLAMP_ABOVE,
  );
  let replyOpen = $state(false);
</script>

<section class="ib-run__section" aria-labelledby="ib-run-io" data-section="input-output">
  <h2 id="ib-run-io" class="ib-run__heading-2">{RUN_PAGE_COPY.inputOutputHeading}</h2>
  <p class="ib-run__note">{description}</p>

  {#if task !== undefined}
    <div class="ib-run__payloads">
      <section class="ib-run__payload-card" aria-label={scheduled ? copy.prompt : copy.messageIn}>
        <header class="ib-run__payload-header">
          <h3 class="ib-run__heading-3">{scheduled ? copy.prompt : copy.messageIn}</h3>
          <span class="ib-run__note">{scheduled ? copy.fromSchedule : copy.fromYou}</span>
        </header>
        {#if messageIn !== undefined}
          <p class="ib-run__message" data-testid="run-message-in">{messageIn}</p>
        {:else if thread.isPending && threadToRead !== null && threadToRead !== ''}
          <p class="ib-run__note">{copy.loadingMessage}</p>
        {:else}
          <p class="ib-run__note">{copy.noMessageIn}</p>
        {/if}
        {#if startedAt !== undefined && !scheduled}
          <p class="ib-run__note">{copy.sentInChat(dayAndTime(startedAt, Date.now()))}</p>
        {/if}
      </section>

      <section class="ib-run__payload-card" aria-label={scheduled ? copy.result : copy.replyOut}>
        <header class="ib-run__payload-header">
          <h3 class="ib-run__heading-3">{scheduled ? copy.result : copy.replyOut}</h3>
          <span class="ib-run__note">{copy.fromAgent(agent)}</span>
        </header>
        {#if hasAnswer}
          <!-- eslint-disable-next-line svelte/no-at-html-tags -->
          <div
            id="ib-run-reply"
            class="cinder-markdown-content weft-artifact-markdown ib-run__answer"
            data-clamped={clamps && !replyOpen ? '' : undefined}
          >
            {@html answerHtml}
          </div>
          {#if clamps}
            <button
              type="button"
              class="ib-run__show-all"
              aria-expanded={replyOpen}
              aria-controls="ib-run-reply"
              onclick={() => (replyOpen = !replyOpen)}
            >
              {replyOpen ? copy.showLess : copy.showAll}
            </button>
          {/if}
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
        {#if hasAnswer && !scheduled}
          <p class="ib-run__note">
            {copy.deliveredToChat}
            {#if onShowRaw !== undefined}
              <Button
                variant="ghost-accent"
                size="sm"
                label={copy.showRawPayloads}
                onclick={onShowRaw}
              />
            {/if}
          </p>
        {/if}
      </section>
    </div>
  {/if}

  {#if task === undefined || showRaw}
    <RunPayloadCards {workflow} {record} />
  {/if}

  {#if workflow !== undefined && workflow.status === 'failed'}
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
  {:else if record !== undefined && workflow === undefined}
    {#if record.error !== undefined && record.error !== null}
      <h3 class="ib-run__heading-3">{TASK_COPY.runRecord.error}</h3>
      <p class="ib-run__note">{record.error}</p>
    {/if}
  {/if}

  <VisuallyHidden aria-live="polite" data-testid="payload-view-status">
    {payloadViewPreference.announcement}
  </VisuallyHidden>
</section>
