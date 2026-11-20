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
  import {
    Badge,
    Button,
    Collapsible,
    Markdown,
    Section,
    Stack,
    VisuallyHidden,
  } from '@lostgradient/cinder';
  import type { WorkflowState } from '@lostgradient/weft';
  import { CircleX } from '@lucide/svelte';
  import { createQuery } from '@tanstack/svelte-query';

  import { RUN_DETAIL_COPY, RUN_PAGE_COPY } from '../../../app/copy/runs.ts';
  import { TASK_COPY } from '../../../app/copy/tasks.ts';
  import { agentLabel } from '../../../lib/agent-label.ts';
  import { getThreadMessages } from '../../../lib/bureau-client.ts';
  import { isScheduleFire, isTerminalState, type TaskView } from '../../../lib/bureau-tasks.ts';
  import { dayAndTime } from '../../../lib/format/clock.ts';
  import { oneLine } from '../../../lib/one-line.ts';
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
    /** The agent's answer, as the Markdown source Cinder's `Markdown` renders, once there is one. */
    answer?: string | undefined;
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
    /**
     * Whether the failure of the run is told elsewhere, on the step that failed (an instance of a
     * workflow file, row 14t), so this section does not tell it a second time.
     */
    failureOnStep?: boolean;
    /** The step a failed instance failed at, counted from one, which its Output card names (row 55c). */
    failedAt?: number | undefined;
  }

  /** The reply is held to this many characters of text before Show all. */
  const CLAMP_ABOVE = 420;

  let {
    task,
    threadId,
    answer,
    answerTruncated = false,
    followState,
    workflow,
    record,
    startedAt,
    onShowRaw,
    showRaw = true,
    failureOnStep = false,
    failedAt = undefined,
  }: RunInputOutputProps = $props();

  const copy = RUN_DETAIL_COPY.io;
  const hasAnswer = $derived(answer !== undefined && answer.trim() !== '');
  const errorStack = $derived(workflow?.errorStack ?? '');
  // Why a run only the Bureau holds failed, in one line of its own words; empty when it said
  // nothing that reads, so no heading is drawn over nothing.
  const bureauFailure = $derived(task?.statusMessage ? oneLine(task.statusMessage) : '');
  const scheduled = $derived(task !== undefined && isScheduleFire(task));
  // A goal's attempt was started by its goal with the goal's prompt, in a session no person chats
  // in: its message is the goal's, never "From you" and never "Sent in the chat".
  const goalAttempt = $derived(task?.origin?.kind === 'goal');
  const prompted = $derived(scheduled || goalAttempt);
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

  // A workflow still going says what it "will produce" (row 54p).
  const workflowGoing = $derived.by(() => {
    const status = workflow?.status ?? record?.status;
    return status === 'pending' || status === 'running' || status === 'suspended';
  });
  const description = $derived(
    task !== undefined
      ? scheduled
        ? copy.scheduleDescription
        : goalAttempt
          ? copy.goalDescription
          : copy.chatDescription
      : workflowGoing
        ? copy.workflowDescriptionLive
        : copy.workflowDescription,
  );
  // What stands in the reply's place: why a run that waits on a person has none yet, or that the
  // agent has not answered, or that it finished without a written answer.
  const noReply = $derived.by((): string => {
    if (task === undefined) return '';
    if (isTerminalState(task.status)) return TASK_COPY.noAnswer;
    if (task.status === 'input-required' && task.openWaits.length > 0) {
      return task.openWaits.some((wait) => wait.kind === 'human-wait')
        ? copy.noReplyWaitingAnswer
        : copy.noReplyWaitingApproval;
    }
    return TASK_COPY.noAnswerYet;
  });
  const clamps = $derived(answer !== undefined && answer.length > CLAMP_ABOVE);
  let replyOpen = $state(false);
</script>

{@render failure()}

<Section title={RUN_PAGE_COPY.inputOutputHeading} {description} data-section="input-output">
  <Stack gap="var(--cinder-space-3)">
    {#if task !== undefined}
      <div class="ib-run__payloads">
        <section class="ib-run__payload-card" aria-label={prompted ? copy.prompt : copy.messageIn}>
          <header class="ib-run__payload-title-row">
            <h3 class="ib-run__heading-3">{prompted ? copy.prompt : copy.messageIn}</h3>
            <span class="ib-run__note"
              >{scheduled ? copy.fromSchedule : goalAttempt ? copy.fromGoal : copy.fromYou}</span
            >
          </header>
          {#if messageIn !== undefined}
            <p class="ib-run__message" data-testid="run-message-in">{messageIn}</p>
          {:else if thread.isPending && threadToRead !== null && threadToRead !== ''}
            <p class="ib-run__note">{copy.loadingMessage}</p>
          {:else}
            <p class="ib-run__note">{copy.noMessageIn}</p>
          {/if}
          {#if startedAt !== undefined && !prompted}
            <p class="ib-run__note">{copy.sentInChat(dayAndTime(startedAt, Date.now()))}</p>
          {/if}
        </section>

        <section class="ib-run__payload-card" aria-label={scheduled ? copy.result : copy.replyOut}>
          <header class="ib-run__payload-title-row">
            <h3 class="ib-run__heading-3">{scheduled ? copy.result : copy.replyOut}</h3>
            <span class="ib-run__note">{copy.fromAgent(agent)}</span>
          </header>
          {#if hasAnswer}
            <Markdown
              id="ib-run-reply"
              content={answer ?? ''}
              class="weft-artifact-markdown ib-run__answer"
              data-clamped={clamps && !replyOpen ? '' : undefined}
            />
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
            <p class="ib-run__note">{noReply}</p>
          {/if}
          {#if followState === 'unavailable'}
            <p class="ib-run__note" role="status">{TASK_COPY.followUnavailable}</p>
          {:else if followState === 'reconnecting'}
            <p class="ib-run__note" role="status">{TASK_COPY.followReconnecting}</p>
          {/if}
          {#if hasAnswer && (!prompted || (goalAttempt && onShowRaw !== undefined))}
            <!-- Show raw payloads follows "Delivered to chat." on its line, and takes a line of its
                 own only when it wraps, with its words on the card's text edge (COR-2489: at 320 it
                 wrapped and its label sat 13px inside the text above it; tasks.css). A goal's
                 attempt delivers nothing to a chat; its raw payloads are still there. -->
            <div class="ib-run__delivered" data-run-delivered>
              {#if !prompted}<p class="ib-run__note">{copy.deliveredToChat}</p>{/if}
              {#if onShowRaw !== undefined}
                <Button
                  variant="ghost-accent"
                  size="sm"
                  label={copy.showRawPayloads}
                  onclick={onShowRaw}
                />
              {/if}
            </div>
          {/if}
        </section>
      </div>
    {/if}

    {#if task === undefined || showRaw}
      <RunPayloadCards {workflow} {record} {failedAt} />
    {/if}
  </Stack>

  <VisuallyHidden aria-live="polite" data-testid="payload-view-status">
    {payloadViewPreference.announcement}
  </VisuallyHidden>
</Section>

<!-- Why a failed run failed leads, above Input and output, so on a phone it is the first thing
     under the header rather than under the fold below the payloads (COR-2489). A failure told on
     the step that failed (`failureOnStep`) is told there instead. -->
{#snippet failure()}
  {#if workflow !== undefined && workflow.status === 'failed' && !failureOnStep}
    <div class="weft-overview-tab__failure" data-run-failure>
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
        <!-- In its own words, never the error's JSON; the stack below says the rest. -->
        <p class="weft-overview-tab__failure-explanation">
          {oneLine(workflow.error, { keepParenthetical: true }) || workflow.error}
        </p>
      {/if}
      {#if errorStack.length > 0}
        <Collapsible variant="flat" trigger="Show full stack trace">
          <pre class="weft-send-tab__result">{errorStack}</pre>
        </Collapsible>
      {/if}
    </div>
  {:else if task !== undefined && workflow === undefined && task.status === 'failed' && bureauFailure !== ''}
    <!-- A run only the Bureau holds says why in its own words, here and not only in the rail, which
         sits under everything on a phone (COR-2489). -->
    <Section
      title={RUN_DETAIL_COPY.instance.whyItFailed}
      description={bureauFailure}
      data-run-failure
    />
  {:else if record !== undefined && workflow === undefined && !failureOnStep}
    {#if record.error !== undefined && record.error !== null}
      <Section
        title={TASK_COPY.runRecord.error}
        description={oneLine(record.error, { keepParenthetical: true }) || record.error}
        data-run-failure
      />
    {/if}
  {/if}
{/snippet}
