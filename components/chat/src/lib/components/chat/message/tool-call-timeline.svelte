<script lang="ts">
  import type { Snippet } from 'svelte';
  import {
    Brain,
    Check,
    ChevronRight,
    CircleAlert,
    CircleDot,
    Globe,
    Pencil,
    Search,
    Terminal,
    X,
    Button,
    Copy,
    CopyButton,
    Spinner,
    type ApprovalState,
  } from '@lostgradient/cinder';
  import { stringify } from '../../../utilities/stringify.ts';
  import { toolResultText } from '../../../utilities/tool-result-text.ts';
  import type { ToolCallPair } from '../conversation-model.ts';
  import type { ToolCallPresentation } from '../utilities/types.ts';
  import { formatToolCallProse } from '../utilities/utilities.ts';
  import ToolPayloadCode from './tool-payload-code.svelte';
  import { resolveTurnLabels, type ChatTurnLabels } from './turn-labels.ts';
  import {
    foldRepeatedSteps,
    formatToolCallDuration,
    formatToolCallElapsed,
    isProblemStatus,
    nextToolCallApprovalDeadline,
    runningStepTitle,
    toolCallFailure,
    toolCallKeyArgument,
    toolCallResultLine,
    toolCallRowStatus,
    toolCallStatusText,
    toolCallSummaryParts,
    totalToolCallDuration,
    type ToolCallRowStatus,
  } from './tool-call-summary.ts';

  let {
    pairs,
    messageId,
    describeToolCall,
    expanded = false,
    onToggle,
    activityActive = true,
    approvalStates,
    durations,
    startTimes,
    onRetryStep,
    labels,
  }: {
    pairs: ToolCallPair[];
    messageId?: string;
    describeToolCall?: ((pair: ToolCallPair) => ToolCallPresentation | undefined) | undefined;
    expanded?: boolean;
    /** Called with whether the group is open after the person toggles its summary line. */
    onToggle?: ((open: boolean) => void) | undefined;
    activityActive?: boolean;
    approvalStates?: ReadonlyMap<string, ApprovalState> | undefined;
    durations?: ReadonlyMap<string, number> | undefined;
    /**
     * When each call started, in milliseconds since the Unix epoch, keyed by call id. The step
     * under way shows how long it has been running, counted in whole seconds (COR-2283, R1).
     */
    startTimes?: ReadonlyMap<string, number> | undefined;
    /** Called with a failed call's id when the person chooses Retry this step. The button shows only when this is set. */
    onRetryStep?: ((toolCallId: string) => void) | undefined;
    /** The words of the step position, the failed count and a failed step's controls. */
    labels?: Partial<ChatTurnLabels> | undefined;
  } = $props();

  const words = $derived(resolveTurnLabels(labels));
  /** The longest delay a timer takes; a deadline further off wakes the timeline once on the way. */
  const MAXIMUM_TIMER_DELAY = 2_147_483_647;

  const navigationMessageId = $derived(messageId ?? pairs[0]?.call.id ?? 'tool-call-timeline');
  const headingId = $derived(`message-${navigationMessageId}-tool-call-summary`);
  const listId = $derived(`${navigationMessageId}-tool-calls`);

  /**
   * The time the rows are read at (COR-2280). An approval nobody settled reads as expired from its
   * deadline on, so the timeline wakes when the next deadline passes, without a host update, and
   * the count stops saying it waits, as Cinder's ApprovalCard stops offering its buttons.
   */
  let currentTime = $state(Date.now());

  $effect(() => {
    // Read against the time the rows were last read at, so a wake that came before the deadline
    // (a capped delay) arms the next one, and one past it moves on to the deadline after.
    const deadline = nextToolCallApprovalDeadline(pairs, approvalStates, currentTime);
    if (deadline === undefined) return;
    const delay = Math.min(Math.max(0, deadline - Date.now()), MAXIMUM_TIMER_DELAY);
    const timer = setTimeout(() => {
      currentTime = Date.now();
    }, delay);
    // A changed deadline, a settled approval and unmounting each drop the timer armed for the last.
    return () => clearTimeout(timer);
  });

  const rows = $derived(
    pairs.map((pair, index) => {
      const presentation = describeToolCall?.(pair);
      const status = toolCallRowStatus(pair, approvalStates?.get(pair.call.id), currentTime);
      const duration = durations?.get(pair.call.id);
      // A call the host words in the present tense and that has no answer yet is the one running.
      const active = activityActive && presentation?.tense === 'present' && !pair.result;
      return {
        key: `${index}:${pair.call.id}`,
        detailsId: `${navigationMessageId}-${index}-${pair.call.id}-details`,
        pair,
        presentation,
        prose: presentation ? formatToolCallProse(presentation) : undefined,
        status,
        active,
        keyArgument: toolCallKeyArgument(pair.call.arguments),
        resultLine: toolCallResultLine(pair),
        duration,
        icon: presentation ? toolActivityIcon(presentation.kind, active) : undefined,
      };
    }),
  );
  type TimelineRow = (typeof rows)[number];

  // Identical consecutive calls fold into one row. Two calls are identical when they name the same
  // tool and the host words them the same way; only a call that succeeded can fold, so a failure,
  // a denial or a call waiting on a person always keeps its own row.
  function repeatKey(row: TimelineRow): string | undefined {
    return row.status === 'succeeded' ? `${row.pair.call.name}\u0000${row.prose ?? ''}` : undefined;
  }
  const steps = $derived(foldRepeatedSteps(rows, repeatKey));
  function stepKey(step: (typeof steps)[number]): string {
    return step.kind === 'single' ? step.row.key : `repeated:${step.rows[0].key}`;
  }
  // A call that has no answer yet and that the host words in the present tense ("Using Lookup
  // order…") is what the group's line says while it runs, in place of the past-tense count.
  const runningRow = $derived(
    rows.findLast(
      (row) =>
        row.presentation?.tense === 'present' &&
        row.pair.result === undefined &&
        row.status === 'pending',
    ),
  );
  // Where the step under way falls among the steps so far, and how long it has run (R1). The clock
  // ticks once a second only while a step with a known start is running.
  const runningPosition = $derived(runningRow === undefined ? 0 : rows.indexOf(runningRow) + 1);
  // A call left unanswered by a run that ended (a chat reopened later) is not under way: it keeps
  // its icon and words, with no spinner, no position and no clock counting from long ago.
  const runningLive = $derived(runningRow !== undefined && activityActive);
  const runningStart = $derived(
    runningRow === undefined || !activityActive
      ? undefined
      : startTimes?.get(runningRow.pair.call.id),
  );
  let elapsedClock = $state(Date.now());

  $effect(() => {
    if (runningStart === undefined) return;
    elapsedClock = Date.now();
    const timer = setInterval(() => {
      elapsedClock = Date.now();
    }, 1000);
    return () => clearInterval(timer);
  });

  const runningElapsed = $derived(
    runningStart === undefined ? undefined : Math.max(0, elapsedClock - runningStart),
  );
  const hasProblem = $derived(rows.some((row) => isProblemStatus(row.status)));
  const summary = $derived(
    toolCallSummaryParts(
      pairs,
      rows.map((row) => row.status),
      rows.map((row) => row.duration),
    ),
  );
  // Once a step failed, the header counts the steps that worked out of all of them (R7).
  const failedCount = $derived(rows.filter((row) => row.status === 'failed').length);
  const countText = $derived(
    failedCount > 0
      ? words.stepsDone(rows.filter((row) => row.status === 'succeeded').length, pairs.length)
      : pairs.length === 1
        ? '1 step'
        : `${pairs.length} steps`,
  );

  // Failures and denials start open; the reader's own toggle wins after that.
  let groupOverride = $state<boolean | undefined>(undefined);
  const groupOpen = $derived(groupOverride ?? (expanded || hasProblem));
  let callOverrides = $state(new Map<string, boolean>());

  function toggleGroup(): void {
    groupOverride = !groupOpen;
    onToggle?.(groupOverride);
  }

  // A row starts open only for a failure or a denial; the reader's own toggle wins after that. A
  // folded run starts closed.
  function isStepOpen(key: string, startsOpen: boolean): boolean {
    return callOverrides.get(key) ?? startsOpen;
  }

  function toggleStep(key: string, startsOpen: boolean): void {
    callOverrides = new Map(callOverrides).set(key, !isStepOpen(key, startsOpen));
  }

  function isStructured(value: unknown): boolean {
    return value === null || typeof value === 'object';
  }

  const callsLabel = $derived(
    `${pairs.length} consecutive tool ${pairs.length === 1 ? 'call' : 'calls'}`,
  );
  const announcerText = $derived(
    rows.map((row) => `${row.pair.call.name}: ${toolCallStatusText(row.status)}`).join('. '),
  );

  function toolActivityIcon(kind: ToolCallPresentation['kind'], active: boolean): Snippet {
    if (kind === 'search') return active ? searchActiveIcon : searchIcon;
    if (kind === 'fetch') return active ? fetchActiveIcon : fetchIcon;
    if (kind === 'write') return active ? writeActiveIcon : writeIcon;
    if (kind === 'execute') return active ? executeActiveIcon : executeIcon;
    if (kind === 'reason') return active ? reasonActiveIcon : reasonIcon;
    return active ? defaultActiveIcon : defaultIcon;
  }
</script>

{#snippet searchIcon()}
  <span class="chat-tool-call-activity-icon" data-kind="search">
    <Search aria-hidden="true" />
  </span>
{/snippet}

{#snippet searchActiveIcon()}
  <span class="chat-tool-call-activity-icon" data-kind="search" data-cinder-tool-activity-active>
    <Search aria-hidden="true" />
  </span>
{/snippet}

{#snippet fetchIcon()}
  <span class="chat-tool-call-activity-icon" data-kind="fetch">
    <Globe aria-hidden="true" />
  </span>
{/snippet}

{#snippet fetchActiveIcon()}
  <span class="chat-tool-call-activity-icon" data-kind="fetch" data-cinder-tool-activity-active>
    <Globe aria-hidden="true" />
  </span>
{/snippet}

{#snippet writeIcon()}
  <span class="chat-tool-call-activity-icon" data-kind="write">
    <Pencil aria-hidden="true" />
  </span>
{/snippet}

{#snippet writeActiveIcon()}
  <span class="chat-tool-call-activity-icon" data-kind="write" data-cinder-tool-activity-active>
    <Pencil aria-hidden="true" />
  </span>
{/snippet}

{#snippet executeIcon()}
  <span class="chat-tool-call-activity-icon" data-kind="execute">
    <Terminal aria-hidden="true" />
  </span>
{/snippet}

{#snippet executeActiveIcon()}
  <span class="chat-tool-call-activity-icon" data-kind="execute" data-cinder-tool-activity-active>
    <Terminal aria-hidden="true" />
  </span>
{/snippet}

{#snippet reasonIcon()}
  <span class="chat-tool-call-activity-icon" data-kind="reason">
    <Brain aria-hidden="true" />
  </span>
{/snippet}

{#snippet reasonActiveIcon()}
  <span class="chat-tool-call-activity-icon" data-kind="reason" data-cinder-tool-activity-active>
    <Brain aria-hidden="true" />
  </span>
{/snippet}

{#snippet defaultIcon()}
  <span class="chat-tool-call-activity-icon" data-kind="generic">
    <CircleDot aria-hidden="true" />
  </span>
{/snippet}

{#snippet defaultActiveIcon()}
  <span class="chat-tool-call-activity-icon" data-kind="generic" data-cinder-tool-activity-active>
    <CircleDot aria-hidden="true" />
  </span>
{/snippet}

{#snippet payload(label: string, value: unknown)}
  <div class="chat-tool-call-payload">
    <span class="chat-tool-call-payload-label">{label}</span>
    {#if isStructured(value)}
      <ToolPayloadCode
        code={value === null ? 'null' : stringify(value)}
        languageLabelVisible={false}
      />
    {:else}
      <p class="chat-tool-call-payload-text">{String(value)}</p>
    {/if}
  </div>
{/snippet}

{#snippet statusIcon(status: ToolCallRowStatus, active: boolean)}
  <span
    class="chat-tool-call-status-icon"
    data-status={status}
    data-cinder-tool-activity-active={active ? '' : undefined}
  >
    {#if active}
      <!-- The step under way turns while its stream is live (R1). -->
      <span class="chat-tool-call-row-spinner" aria-hidden="true">
        <Spinner size="sm" variant="arc" label="" />
      </span>
    {:else if status === 'succeeded'}
      <Check aria-hidden="true" />
    {:else if status === 'failed' || status === 'denied' || status === 'expired'}
      <X aria-hidden="true" />
    {:else if status === 'waiting' || status === 'waiting-input'}
      <CircleAlert aria-hidden="true" />
    {:else}
      <CircleDot aria-hidden="true" />
    {/if}
  </span>
{/snippet}

<!-- A failed step (R7): what went wrong in one danger line, the rest of the error wrapping under
     it, and Copy error then Retry this step. -->
{#snippet failure(pair: ToolCallPair)}
  {@const failed = toolCallFailure(pair, words.stepFailed)}
  {#if failed}
    <div class="chat-tool-call-failure">
      <p class="chat-tool-call-failure-summary" dir="auto">
        <X class="chat-tool-call-failure-glyph" aria-hidden="true" />
        <span>{failed.summary}</span>
      </p>
      {#if failed.diagnostic !== undefined}
        <pre class="chat-tool-call-diagnostic" dir="auto">{failed.diagnostic}</pre>
      {/if}
      <div class="chat-tool-call-failure-actions">
        <CopyButton
          value={failed.copy}
          label={words.copyError}
          copiedLabel={words.errorCopied}
          confirmDuration={2000}
          class="chat-tool-call-failure-action"
        >
          <Copy class="cinder-icon-xs" aria-hidden="true" />
          {words.copyError}
        </CopyButton>
        {#if onRetryStep}
          <Button
            type="button"
            class="chat-tool-call-failure-action"
            size="xs"
            variant="secondary"
            onclick={() => onRetryStep(pair.call.id)}
          >
            {words.retryStep}
          </Button>
        {/if}
      </div>
    </div>
  {/if}
{/snippet}

{#snippet output(pair: ToolCallPair, status: ToolCallRowStatus)}
  {#if pair.result?.outcome === 'error' && status === 'failed'}
    {@render failure(pair)}
  {:else if pair.result?.outcome === 'error'}
    <!-- A denial the run reports as an error result reads Denied, not failed: it keeps the plain
         error payload and offers no retry. -->
    {@render payload('Error', pair.result.error?.message ?? pair.result.content)}
  {:else if pair.result?.parts !== undefined && pair.result}
    {@render payload('Output', toolResultText(pair.result))}
  {:else if pair.result}
    {@render payload('Output', pair.result.content)}
  {/if}
{/snippet}

<section
  id={`message-${navigationMessageId}`}
  class="chat-tool-call-timeline chat-navigation-row"
  data-cinder-tool-call-count={pairs.length}
  aria-labelledby={headingId}
  tabindex="-1"
>
  <span class="cinder-sr-only" aria-live="polite" aria-atomic="true">{announcerText}</span>
  <h3 id={headingId} class="chat-tool-call-heading">
    <button
      type="button"
      class="chat-tool-call-toggle"
      aria-expanded={groupOpen}
      aria-controls={listId}
      onclick={toggleGroup}
    >
      <ChevronRight class="chat-tool-call-chevron" aria-hidden="true" />
      <span class="chat-tool-call-summary">
        {#if runningRow?.presentation}
          <!-- The step under way (R1): a spinner, its present-tense title ending in an ellipsis,
               where it falls among the steps so far, and how long it has run. -->
          {#if runningLive}
            <span class="chat-tool-call-spinner" aria-hidden="true">
              <Spinner size="sm" variant="arc" label="" />
            </span>
          {:else if runningRow.icon}
            {@render runningRow.icon()}
          {/if}
          <span class="chat-tool-call-running" dir="auto"
            >{runningLive ? runningStepTitle(runningRow.prose ?? '') : runningRow.prose}</span
          >
          {#if runningLive && pairs.length > 1}
            <span class="chat-tool-call-summary-segment" data-step-position
              >{words.stepPosition(runningPosition, pairs.length)}</span
            >
          {/if}
          {#if runningElapsed !== undefined}
            <span class="chat-tool-call-summary-duration" data-elapsed
              >{formatToolCallElapsed(runningElapsed)}</span
            >
          {/if}
        {:else}
          <!-- A failed count follows the step count directly, so the two read as one phrase:
               "2 of 3 steps, 1 failed" (R7). -->
          <span class="chat-tool-call-summary-count"
            >{countText}{#if summary.problems.length > 0},{/if}</span
          >
          {#each summary.problems as problem, index (index)}
            <span class="chat-tool-call-summary-segment" data-problem>{problem}</span>
          {/each}
          {#if summary.tools}
            <span class="chat-tool-call-summary-tools">{summary.tools}</span>
          {/if}
          {#if summary.duration}
            <span class="chat-tool-call-summary-duration">{summary.duration}</span>
          {/if}
        {/if}
      </span>
    </button>
  </h3>
  <ol id={listId} class="chat-tool-call-list" aria-label={callsLabel} hidden={!groupOpen}>
    {#each steps as step (stepKey(step))}
      {#if step.kind === 'single'}
        {@const row = step.row}
        {@const open = isStepOpen(row.key, isProblemStatus(row.status))}
        <li class="chat-tool-call-item" data-cinder-tool-call-status={row.status}>
          <button
            type="button"
            class="chat-tool-call-row"
            aria-expanded={open}
            aria-controls={row.detailsId}
            onclick={() => toggleStep(row.key, isProblemStatus(row.status))}
          >
            {@render statusIcon(row.status, row.active)}
            {#if row.presentation}
              <span class="chat-tool-call-label">{row.prose}</span>
              <code class="chat-tool-call-name">{row.pair.call.name}</code>
            {:else}
              <code class="chat-tool-call-name">{row.pair.call.name}</code>
              {#if row.keyArgument}<span>{row.keyArgument}</span>{/if}
            {/if}
            <span class="chat-tool-call-result">
              {#if row.resultLine}→ {row.resultLine}{/if}
            </span>
            {#if row.status !== 'succeeded'}
              <span class="chat-tool-call-status">{toolCallStatusText(row.status)}</span>
            {/if}
            {#if row.duration !== undefined}
              <span class="chat-tool-call-duration">{formatToolCallDuration(row.duration)}</span>
            {/if}
          </button>
          <div id={row.detailsId} class="chat-tool-call-details" hidden={!open}>
            {#if open}
              {@render payload('Input', row.pair.call.arguments)}
              {@render output(row.pair, row.status)}
            {/if}
          </div>
        </li>
      {:else}
        {@const first = step.rows[0]}
        {@const key = stepKey(step)}
        {@const open = isStepOpen(key, false)}
        {@const total = totalToolCallDuration(step.rows.map((row) => row.duration))}
        <li
          class="chat-tool-call-item"
          data-cinder-tool-call-status="succeeded"
          data-cinder-tool-call-repeat={step.rows.length}
        >
          <button
            type="button"
            class="chat-tool-call-row"
            aria-expanded={open}
            aria-controls={`${first.detailsId}-repeated`}
            onclick={() => toggleStep(key, false)}
          >
            {@render statusIcon('succeeded', false)}
            {#if first.prose}<span class="chat-tool-call-label">{first.prose}</span>{/if}
            <code class="chat-tool-call-name">{first.pair.call.name} ×{step.rows.length}</code>
            <span class="chat-tool-call-result"></span>
            {#if total !== undefined}
              <span class="chat-tool-call-duration">{formatToolCallDuration(total)}</span>
            {/if}
          </button>
          <div id={`${first.detailsId}-repeated`} class="chat-tool-call-details" hidden={!open}>
            {#if open}
              {#each step.rows as member, memberIndex (member.key)}
                <div class="chat-tool-call-repeated-call">
                  <span class="chat-tool-call-repeated-heading">
                    {memberIndex + 1} of {step.rows.length}{#if member.keyArgument}
                      {' '}{member.keyArgument}{/if}
                  </span>
                  {@render payload('Input', member.pair.call.arguments)}
                  {@render output(member.pair, member.status)}
                </div>
              {/each}
            {/if}
          </div>
        </li>
      {/if}
    {/each}
  </ol>
</section>

<style>
  /* Contiguous steps share one bordered group on the page, with no fill: a header line with the
   * step count and the time, then one row to a step. Text is muted 12.5px. */
  .chat-tool-call-timeline {
    inline-size: min(42rem, 100%);
    min-inline-size: 0;
    max-inline-size: 100%;
    border: 1px solid var(--cinder-border-muted);
    border-radius: var(--cinder-radius-md);
    font-size: 12.5px;
    line-height: 1.4;
    color: var(--cinder-text-muted);
  }

  @container (min-width: 22rem) {
    .chat-tool-call-timeline {
      min-inline-size: 20rem;
    }
  }

  .chat-tool-call-timeline:focus-visible {
    outline: var(--cinder-ring-width) solid transparent;
    box-shadow: var(--_cinder-focus-ring-shadow);
  }

  @media (forced-colors: active) {
    .chat-tool-call-timeline:focus-visible {
      outline: var(--cinder-ring-width) solid ButtonText;
    }
  }

  .chat-tool-call-heading {
    margin: 0;
    font: inherit;
  }

  /* The first line of a button's content is where its icon aligns: when a phrase wraps, the
   * chevron and the status icon stay beside the first line, not centered on all of them. */
  .chat-tool-call-toggle,
  .chat-tool-call-row {
    display: flex;
    align-items: flex-start;
    gap: var(--cinder-space-2);
    inline-size: 100%;
    min-inline-size: 0;
    padding: var(--cinder-space-2) var(--cinder-space-3);
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: start;
    cursor: pointer;
  }

  .chat-tool-call-toggle:focus-visible,
  .chat-tool-call-row:focus-visible {
    outline: var(--cinder-ring-width) solid transparent;
    box-shadow: var(--_cinder-focus-ring-shadow);
  }

  .chat-tool-call-toggle :global(.chat-tool-call-chevron) {
    inline-size: 12px;
    block-size: 12px;
    flex: none;
    margin-block: calc((1lh - 12px) / 2);
    transition: transform 120ms ease;
  }

  .chat-tool-call-toggle[aria-expanded='true'] :global(.chat-tool-call-chevron) {
    transform: rotate(90deg);
  }

  /* The header's phrases are fields: the step count, the tools, any failed or waiting counts and
   * the time. Each is one unbroken line fragment, so a narrow header wraps between phrases and
   * never inside one. The time takes the end of its line. */
  .chat-tool-call-summary {
    display: flex;
    flex: 1 1 auto;
    flex-wrap: wrap;
    align-items: baseline;
    column-gap: var(--cinder-space-2);
    min-inline-size: 0;
  }

  /* The running call's sentence is the host's own words and wraps like any sentence; only these
   * phrases are held to one line. */
  .chat-tool-call-summary-count,
  .chat-tool-call-summary-segment,
  .chat-tool-call-summary-duration {
    white-space: nowrap;
  }

  .chat-tool-call-running {
    min-inline-size: 0;
    overflow-wrap: anywhere;
  }

  .chat-tool-call-summary-count {
    color: var(--cinder-text-default);
  }

  .chat-tool-call-summary-segment,
  .chat-tool-call-summary-duration {
    font-variant-numeric: tabular-nums;
  }

  .chat-tool-call-summary-duration {
    margin-inline-start: auto;
  }

  /* The tools take the room the other phrases leave, and a name wider than that is cut with an
   * ellipsis rather than wrapped to a second line; its whole text stays in the page. A basis of
   * zero keeps it on the line it starts. */
  .chat-tool-call-summary-tools {
    flex: 1 1 0;
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    font-family: var(--cinder-font-mono);
    font-size: 12px;
  }

  /* In a narrow chat the collapsed header leaves the raw tool names out; opening the group shows
   * each call with its full name. */
  @container (max-width: 21.99rem) {
    .chat-tool-call-summary-tools {
      display: none;
    }

    /* A row wraps between its parts, so the tool's full name always has the line it needs. */
    .chat-tool-call-row {
      flex-wrap: wrap;
      row-gap: var(--cinder-space-1);
    }

    .chat-tool-call-name {
      max-inline-size: 100%;
    }
  }

  .chat-tool-call-list {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    border-block-start: 1px solid var(--cinder-border-muted);
    list-style: none;
  }

  .chat-tool-call-item + .chat-tool-call-item {
    border-block-start: 1px solid var(--cinder-border-muted);
  }

  .chat-tool-call-list[hidden],
  .chat-tool-call-details[hidden] {
    display: none;
  }

  /* A row is its status icon, a sentence title, the tool in muted monospace, and the time at the
   * end. The result line takes the room between them. */
  .chat-tool-call-name {
    flex: 0 1 auto;
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--cinder-font-mono);
    font-size: 12px;
    color: var(--cinder-text-default);
  }

  .chat-tool-call-label + .chat-tool-call-name {
    color: var(--cinder-text-muted);
  }

  .chat-tool-call-label {
    min-inline-size: 0;
    overflow-wrap: anywhere;
    color: var(--cinder-text-default);
  }

  /* A zero basis: the result takes only the room the title, the tool and the time leave, so a long
   * result line is cut first and never squeezes them. */
  .chat-tool-call-result {
    flex: 1 1 0;
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chat-tool-call-status,
  .chat-tool-call-duration {
    flex: none;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  .chat-tool-call-item[data-cinder-tool-call-status='failed'] .chat-tool-call-status {
    color: var(--cinder-status-danger-text);
  }

  .chat-tool-call-status-icon {
    display: inline-flex;
    flex: none;
    align-items: center;
    block-size: 1lh;
    color: var(--cinder-text-subtle);
  }

  .chat-tool-call-status-icon :global(svg) {
    inline-size: 12px;
    block-size: 12px;
  }

  .chat-tool-call-status-icon[data-status='succeeded'] {
    color: var(--cinder-status-success-text);
  }

  .chat-tool-call-status-icon[data-status='failed'] {
    color: var(--cinder-status-danger-text);
  }

  .chat-tool-call-status-icon[data-status='waiting'],
  .chat-tool-call-status-icon[data-status='waiting-input'] {
    color: var(--cinder-status-warning-text);
  }

  .chat-tool-call-status-icon[data-cinder-tool-activity-active] {
    animation: chat-tool-call-pulse 1.4s ease-in-out infinite;
  }

  .chat-tool-call-details {
    --cinder-code-block-padding: var(--cinder-space-3);
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 0;
    padding: 0 var(--cinder-space-3) var(--cinder-space-2);
  }

  /* A folded run opens to its calls, one block each, with a muted "2 of 20" heading. */
  .chat-tool-call-repeated-call {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding-block: var(--cinder-space-1);
  }

  .chat-tool-call-repeated-heading {
    font-size: 11.5px;
    color: var(--cinder-text-subtle);
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
  }

  .chat-tool-call-payload {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .chat-tool-call-payload-label {
    font-size: 11.5px;
    color: var(--cinder-text-subtle);
  }

  .chat-tool-call-payload-text {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--cinder-text-default);
  }

  /* The step under way turns in the header and on its row (COR-2283, R1). */
  .chat-tool-call-spinner,
  .chat-tool-call-row-spinner {
    display: inline-flex;
    flex: none;
    align-items: center;
    block-size: 1lh;
  }

  .chat-tool-call-spinner :global(.cinder-spinner),
  .chat-tool-call-row-spinner :global(.cinder-spinner) {
    inline-size: 12px;
    block-size: 12px;
  }

  /* A failed step's row wraps between its parts rather than cutting its Failed status off (R7). */
  .chat-tool-call-item[data-cinder-tool-call-status='failed'] .chat-tool-call-row {
    flex-wrap: wrap;
    row-gap: var(--cinder-space-1);
  }

  /* What went wrong, in danger text, then the rest of the error, which wraps rather than scrolls. */
  .chat-tool-call-failure {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    min-inline-size: 0;
  }

  .chat-tool-call-failure-summary {
    display: flex;
    gap: var(--cinder-space-1);
    align-items: flex-start;
    margin: 0;
    color: var(--cinder-status-danger-text);
    overflow-wrap: anywhere;
    text-align: start;
  }

  .chat-tool-call-failure-summary :global(.chat-tool-call-failure-glyph) {
    flex: none;
    inline-size: 12px;
    block-size: 12px;
    margin-block: calc((1lh - 12px) / 2);
  }

  /* Plain text in the group, not a box inside it. */
  .chat-tool-call-diagnostic {
    margin: 0;
    color: var(--cinder-text-default);
    font-family: var(--cinder-font-mono);
    font-size: 12px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    text-align: start;
  }

  .chat-tool-call-failure-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--cinder-space-2);
  }

  .chat-tool-call-failure-actions :global(.chat-tool-call-failure-action) {
    display: inline-flex;
    align-items: center;
    gap: var(--cinder-space-1);
    inline-size: auto;
    min-inline-size: 0;
    max-inline-size: none;
    padding-inline: var(--cinder-space-2);
  }

  @media (pointer: coarse) {
    .chat-tool-call-failure-actions :global(.chat-tool-call-failure-action) {
      min-block-size: var(--cinder-touch-target-min);
    }
  }

  .chat-tool-call-activity-icon {
    display: inline-flex;
    flex: none;
  }

  .chat-tool-call-activity-icon :global(svg) {
    inline-size: 12px;
    block-size: 12px;
  }

  .chat-tool-call-activity-icon[data-cinder-tool-activity-active] {
    animation: chat-tool-call-pulse 1.4s ease-in-out infinite;
  }

  @media (prefers-reduced-motion: reduce) {
    .chat-tool-call-toggle :global(.chat-tool-call-chevron) {
      transition: none;
    }

    .chat-tool-call-activity-icon[data-cinder-tool-activity-active],
    .chat-tool-call-status-icon[data-cinder-tool-activity-active] {
      animation: none;
    }
  }

  @keyframes chat-tool-call-pulse {
    0%,
    100% {
      opacity: 0.6;
    }

    50% {
      opacity: 1;
    }
  }
</style>
