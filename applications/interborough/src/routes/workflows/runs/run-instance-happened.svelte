<script lang="ts">
  /**
   * What happened in an instance of a workflow file, which no chat thread describes: when it
   * started, then each step it began with how long after the start. A run that failed shows its
   * failure on the step that failed ("Step 2, Collect merged changes, failed after 2 tries"), with
   * why it failed under it and no banner above the page (row 14t). The entries are made from the
   * history the Bureau keeps of the instance (`run-instance.ts`).
   */
  import { Badge, Button, Collapsible, Section } from '@lostgradient/cinder';
  import type { WorkflowState } from '@lostgradient/weft';
  import { CircleX, Play, RefreshCw } from '@lucide/svelte';

  import { RUN_DETAIL_COPY } from '../../../app/copy/runs.ts';
  import { TASK_COPY } from '../../../app/copy/tasks.ts';
  import type { ScopeGate } from '../../../lib/scopes.svelte.ts';
  import { clockTime } from '../../../lib/format/clock.ts';
  import { router } from '../../../lib/router.svelte.ts';
  import {
    failureHeading,
    sentenceOf,
    triesTookWords,
    type InstanceEntry,
    type InstanceProgress,
  } from './run-instance.ts';
  import { oneLine } from '../../../lib/one-line.ts';
  import { failureCategoryExplanation, failureCategoryLabel } from '../detail/failure-category.ts';
  import { durationWords } from './run-rows.ts';

  interface RunInstanceHappenedProps {
    entries: readonly InstanceEntry[];
    /** When the run started, in epoch milliseconds. */
    startedAt: number;
    /** How far the run got, which names the step that failed. */
    progress: InstanceProgress | undefined;
    /** Whether the run failed, which draws the block on the step that failed. */
    failed?: boolean;
    /** Why the run failed, in the engine's words, when it says. */
    failure?: string | undefined;
    /** What kind of failure the engine says it was, and its stack, for an operator. */
    category?: WorkflowState['failureCategory'];
    errorStack?: string | undefined;
    /** How long the failing step's tries took, in milliseconds, when the history says (row 55b). */
    triesTook?: number | undefined;
    /**
     * The version a retry runs on, when Retry from this step is offered: the block then says what
     * the retry keeps and runs again (row 55b).
     */
    retryVersion?: string | undefined;
    /**
     * The actions the block carries (row 14t): Retry from step N runs the step again, Run again sets
     * up another run (not drawn while no provider is connected, because the header says why it is
     * held), and Open step N opens the step in How it ran.
     */
    retry?:
      | {
          readonly onRetry: () => void;
          readonly busy?: boolean | undefined;
          readonly gate?: ScopeGate | undefined;
        }
      | undefined;
    runAgain?:
      | {
          readonly href?: string | undefined;
          readonly onRun?: (() => void) | undefined;
          readonly blocked?: boolean | undefined;
          readonly busy?: boolean | undefined;
        }
      | undefined;
    onOpenStep?: (() => void) | undefined;
  }

  let {
    entries,
    startedAt,
    progress,
    failed = false,
    failure = undefined,
    category = undefined,
    errorStack = undefined,
    triesTook = undefined,
    retryVersion = undefined,
    retry = undefined,
    runAgain = undefined,
    onOpenStep = undefined,
  }: RunInstanceHappenedProps = $props();

  const copy = RUN_DETAIL_COPY.instance;

  // "Interborough tried 3 times in 3.4 s.", said after why it failed when the step was tried again.
  const tried = $derived(
    progress === undefined || progress.tries < 2
      ? undefined
      : copy.triedIn(
          progress.tries,
          triesTook === undefined ? undefined : triesTookWords(triesTook),
        ),
  );
  const retryKeeps = $derived(
    retryVersion === undefined || progress?.at === null || progress?.at === undefined
      ? undefined
      : copy.retryKeeps(progress.at),
  );

  // What the step said, in its own words and never the error's JSON (row 55b): "GitHub didn’t
  // answer (HTTP 503)". The stack below says the rest.
  const said = $derived(
    failure === undefined || failure === ''
      ? undefined
      : sentenceOf(oneLine(failure, { keepParenthetical: true }) || oneLine(failure) || failure),
  );
  const heading = $derived(progress === undefined ? undefined : failureHeading(progress));
  const stepNumber = $derived(progress?.at ?? undefined);
  // A cancellation is a person's doing; any other failure of a step is not (row 14t).
  const notYourFault = $derived(category !== 'cancellation');
  const healthPath = TASK_COPY.list.loadFailed.healthPath;

  function openLink(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }

  function openHealth(event: MouseEvent): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(healthPath);
  }
</script>

<Section title={RUN_DETAIL_COPY.happened.heading} data-section="what-happened">
  <ol class="ib-run-happened" aria-label={RUN_DETAIL_COPY.happened.listLabel}>
    <li class="ib-run-happened__entry" data-state="done">
      <span class="ib-run-happened__title"
        >{RUN_DETAIL_COPY.happened.started(clockTime(startedAt))}</span
      >
    </li>
    {#each entries as entry (entry.key)}
      <li
        class="ib-run-happened__entry"
        data-state={entry.state === 'failed' ? 'done' : entry.state}
        data-failed={entry.state === 'failed' ? '' : undefined}
      >
        <span class="ib-run-happened__title">{entry.title}</span>
        {#if entry.offsetMilliseconds !== undefined}
          <span class="ib-run-happened__offset">+{durationWords(entry.offsetMilliseconds)}</span>
        {/if}
      </li>
    {/each}
  </ol>
  {#if failed && heading !== undefined}
    <div class="weft-overview-tab__failure" data-testid="run-step-failure">
      <div class="weft-overview-tab__failure-title">
        <CircleX aria-hidden="true" size={18} />
        <span>{heading}</span>
      </div>
      {#if said !== undefined}
        <p class="weft-overview-tab__failure-explanation">
          <strong>{copy.whyItFailed}.</strong>
          {said}{#if notYourFault}{` ${copy.notYourFault}`}{/if}{#if tried !== undefined}{` ${tried}`}{/if}
        </p>
      {:else if tried !== undefined}
        <p class="weft-overview-tab__failure-explanation">{tried}</p>
      {/if}
      <p class="weft-overview-tab__failure-explanation" data-run-retry-sentence>
        {#if retryKeeps !== undefined}{`${retryKeeps} `}{/if}{copy.checkHealth.before}<a
          href={router.href(healthPath)}
          onclick={openHealth}>{copy.checkHealth.link}</a
        >{copy.checkHealth.after}
      </p>
      {#if retry !== undefined || (runAgain !== undefined && runAgain.blocked !== true) || (onOpenStep !== undefined && stepNumber !== undefined)}
        <div class="ib-run-happened__actions" data-run-failure-actions>
          {#if retry !== undefined && stepNumber !== undefined}
            {@const retrying = retry}
            <Button
              variant="primary"
              size="sm"
              label={copy.inBlock.retry(stepNumber)}
              title={retrying.gate?.title}
              disabled={retrying.gate?.disabled === true}
              loading={retrying.busy === true}
              onclick={() => retrying.onRetry()}
            >
              {#snippet leadingIcon()}<RefreshCw aria-hidden="true" size={14} />{/snippet}
            </Button>
            {#if retryVersion !== undefined}
              <span class="ib-run-happened__offset">{copy.inBlock.runsOn(retryVersion)}</span>
            {/if}
          {/if}
          {#if runAgain !== undefined && runAgain.blocked !== true}
            {@const again = runAgain}
            {#if again.href !== undefined}
              {@const path = again.href}
              <Button
                variant="secondary"
                size="sm"
                href={router.href(path)}
                label={copy.inBlock.runAgain}
                onclick={(event) => openLink(event, path)}
              >
                {#snippet leadingIcon()}<Play aria-hidden="true" size={14} />{/snippet}
              </Button>
            {:else}
              <Button
                variant="secondary"
                size="sm"
                label={copy.inBlock.runAgain}
                loading={again.busy === true}
                onclick={() => again.onRun?.()}
              >
                {#snippet leadingIcon()}<Play aria-hidden="true" size={14} />{/snippet}
              </Button>
            {/if}
          {/if}
          {#if onOpenStep !== undefined && stepNumber !== undefined}
            <Button
              variant="ghost-accent"
              size="sm"
              label={copy.inBlock.openStep(stepNumber)}
              onclick={onOpenStep}
            />
          {/if}
        </div>
      {/if}
      <!-- The engine's kind of failure and its operator sentence are details, with the stack, not
           the block's headline (rows 14t, 55b). -->
      {#if category !== undefined || (errorStack !== undefined && errorStack.length > 0)}
        <Collapsible variant="flat" trigger={copy.inBlock.errorDetails}>
          {#if category !== undefined}
            <p class="weft-overview-tab__failure-explanation" data-run-failure-category>
              <Badge variant="danger">{failureCategoryLabel(category)}</Badge>
              {failureCategoryExplanation(category)}
            </p>
          {/if}
          {#if errorStack !== undefined && errorStack.length > 0}
            <pre class="weft-send-tab__result">{errorStack}</pre>
          {/if}
        </Collapsible>
      {/if}
    </div>
  {/if}
</Section>
