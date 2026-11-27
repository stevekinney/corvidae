<script lang="ts">
  /**
   * One step, read from the top: its name, one line of status (the dot, the word, when it started,
   * how long it took, and its name in code), then full-width input and output summaries, the
   * branches of a step that ran several things at once, the lines the run logged under it, whatever
   * the step offers to do (complete an activity, open a stream, read a worker's record).
   */
  import { Collapsible, PayloadInspector, StatusDot } from '@lostgradient/cinder';
  import type { WorkflowTimelineEntry } from '@lostgradient/weft';
  import type { Snippet } from 'svelte';

  import { RUN_STEPS_COPY } from '../../../../app/copy/runs.ts';
  import { formatDuration } from '../../../../lib/format/index.ts';
  import LogLines from '../../runs/log-lines.svelte';
  import type { RunLogLine } from '../../runs/run-logs-data.ts';
  import { isDegradedCoordinationEntry } from '../timeline/timeline-mapping.ts';
  import { parseStepSummary, stepName, stepStatus } from './step-presentation.ts';
  import type { WaterfallBar } from '@lostgradient/interborough-plugin/step-waterfall';

  interface StepDetailProps {
    readonly entry: WorkflowTimelineEntry;
    readonly bar: WaterfallBar | undefined;
    /** Whether the run is still in this step; false for a `running` entry it has left. */
    readonly open: boolean;
    /** The lines the run logged under this step (`placeLogLines`); none when it has none or they cannot be placed. */
    readonly logs?: readonly RunLogLine[] | undefined;
    /** What the step offers to do, rendered after the branches. */
    readonly actions?: Snippet | undefined;
  }

  let { entry, bar, open, logs, actions }: StepDetailProps = $props();

  const name = $derived(stepName(entry));
  const status = $derived(stepStatus(entry.status, open));
  const failed = $derived(entry.status === 'failed' || entry.status === 'timed-out');
  const branches = $derived(entry.operationType === 'speculate' ? entry.children : entry.branches);
  const degradedGroup = $derived(isDegradedCoordinationEntry(entry));
  const omitted = $derived(
    entry.operationType === 'speculate'
      ? (entry.childrenOmitted ?? 0)
      : (entry.branchesOmitted ?? 0),
  );
</script>

<article class="ib-step-detail" aria-label={name.readable} data-step={entry.step}>
  <header class="ib-step-detail__title">
    <h3 class="ib-step-detail__name">{name.readable}</h3>
    <p class="ib-step-detail__status">
      <StatusDot status={status.dot} label={status.label} labelVisible live={false} />
      {#if bar !== undefined}
        <span>{RUN_STEPS_COPY.startedAfter(formatDuration(bar.startedAfter))}</span>
      {:else}
        <span>{RUN_STEPS_COPY.noStart}</span>
      {/if}
      {#if bar?.open === true}
        <span>{RUN_STEPS_COPY.stillGoing}</span>
      {:else if entry.duration !== undefined}
        <span>{RUN_STEPS_COPY.took(formatDuration(entry.duration))}</span>
      {/if}
      {#if name.raw !== undefined}
        <code class="ib-step-detail__raw">{name.raw}</code>
      {/if}
    </p>
  </header>

  <div class="ib-step-detail__fields">
    <!-- Timeline reads already mask engine inputs. Inspect exactly the summaries supplied by that
         read in both views, with no additional payload fetch or heuristic redaction. -->
    <PayloadInspector
      bare
      label={RUN_STEPS_COPY.input}
      value={entry.inputSummary}
      parse={parseStepSummary}
      redact={[]}
    />
    {#if entry.outputSummary === undefined}
      <section
        class="ib-step-detail__field"
        aria-label={failed ? RUN_STEPS_COPY.error : RUN_STEPS_COPY.output}
      >
        <h4 class="ib-step-detail__label">
          {failed ? RUN_STEPS_COPY.error : RUN_STEPS_COPY.output}
        </h4>
        <p class="ib-step-detail__none">{RUN_STEPS_COPY.nothingKept}</p>
      </section>
    {:else}
      <PayloadInspector
        bare
        label={failed ? RUN_STEPS_COPY.error : RUN_STEPS_COPY.output}
        value={entry.outputSummary}
        parse={parseStepSummary}
        redact={[]}
      />
    {/if}
  </div>

  {#if degradedGroup}
    <section class="ib-step-detail__field" aria-label={RUN_STEPS_COPY.branches}>
      <h4 class="ib-step-detail__label">{RUN_STEPS_COPY.branches}</h4>
      <p class="ib-step-detail__none">{RUN_STEPS_COPY.branchesUnreported}</p>
    </section>
  {:else if branches !== undefined && branches.length > 0}
    <section class="ib-step-detail__field" aria-label={RUN_STEPS_COPY.branches}>
      <h4 class="ib-step-detail__label">{RUN_STEPS_COPY.branches}</h4>
      <ul class="ib-step-detail__branches">
        {#each branches as branch (branch.index)}
          <li class="ib-step-detail__branch" data-outcome={branch.outcome}>
            <span class="ib-step-detail__branch-name">{branch.key ?? branch.operationLabel}</span>
            <code class="ib-step-detail__raw">{branch.operationType}</code>
            <span class="ib-step-detail__branch-outcome"
              >{RUN_STEPS_COPY.branchOutcome[branch.outcome]}</span
            >
            {#if branch.errorSummary !== undefined}
              <span class="ib-step-detail__branch-error">{branch.errorSummary}</span>
            {/if}
          </li>
        {/each}
      </ul>
      {#if omitted > 0}
        <p class="ib-step-detail__none">{RUN_STEPS_COPY.omitted(omitted)}</p>
      {/if}
    </section>
  {/if}

  {#if logs !== undefined && logs.length > 0}
    <section
      class="ib-step-detail__field"
      aria-label={RUN_STEPS_COPY.logs}
      data-section="step-logs"
    >
      <Collapsible open animated={false} variant="flat" trigger={RUN_STEPS_COPY.logs}>
        <LogLines lines={logs} label={RUN_STEPS_COPY.logsListLabel} />
      </Collapsible>
    </section>
  {/if}

  {#if actions !== undefined}
    <div class="ib-step-detail__actions">{@render actions()}</div>
  {/if}
</article>

<style>
  .ib-step-detail {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-4);
    padding: var(--cinder-space-4);
    min-width: 0;
  }

  .ib-step-detail__title {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-1);
    min-width: 0;
  }

  .ib-step-detail__name {
    margin: 0;
    font-size: var(--cinder-text-md);
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .ib-step-detail__status {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--cinder-space-1) var(--cinder-space-3);
    margin: 0;
    font-size: var(--cinder-text-sm);
    color: var(--cinder-text-muted);
    min-width: 0;
  }

  .ib-step-detail__raw {
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-xs);
    overflow-wrap: anywhere;
  }

  .ib-step-detail__fields {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-4);
    min-width: 0;
  }

  .ib-step-detail__field {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    min-width: 0;
  }

  .ib-step-detail__label {
    margin: 0;
    font-size: var(--cinder-text-sm);
    font-weight: 600;
    color: var(--cinder-text-muted);
  }

  .ib-step-detail__none {
    margin: 0;
    font-size: var(--cinder-text-xs);
    color: var(--cinder-text-subtle);
  }

  .ib-step-detail__branches {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .ib-step-detail__branch {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--cinder-space-1) var(--cinder-space-3);
    font-size: var(--cinder-text-sm);
    min-width: 0;
  }

  .ib-step-detail__branch-name {
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .ib-step-detail__branch-outcome {
    color: var(--cinder-text-subtle);
  }

  .ib-step-detail__branch-error {
    flex-basis: 100%;
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-xs);
    overflow-wrap: anywhere;
  }

  .ib-step-detail__actions {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    min-width: 0;
  }
</style>
