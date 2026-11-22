<script lang="ts">
  /**
   * A fork compared with the run it came from (COR-2538): the steps both runs share, collapsed, and
   * the steps the fork ran again, each marked changed, the same, or in one run only. Selecting a step
   * shows its input and output differences in Cinder's `JsonDiffViewer`.
   *
   * The server aligns the two runs (`weft.workflows.compare`, read by `fetchForkComparison`), so this
   * draws one answer and aligns nothing: a step is shared when the server says it is, and a step's
   * kind is read from its two entries by `classifyComparedStep`. It needs only the fork's id, so the
   * lineage panel offers it for any fork on any day, and the Checkpoints tab shows it right after a
   * fork is made.
   */
  import {
    Badge,
    Collapsible,
    EmptyState,
    ErrorState,
    JsonDiffViewer,
    Section,
    Skeleton,
  } from '@lostgradient/cinder';
  import {
    classifyComparedStep,
    differingFields,
    parseSummary,
    type ComparedSide,
    type ComparedStep,
    type ComparedStepKind,
  } from '@lostgradient/interborough-plugin/run-comparison';
  import { createQuery } from '@tanstack/svelte-query';

  import { RETRY_LABEL } from '../../../../app/copy/views.ts';
  import { RUN_COMPARISON_COPY } from '../../../../app/copy/runs.ts';
  import { faultTreatment } from '../../../../lib/faults.ts';
  import {
    fetchForkComparison,
    forkComparisonQueryKey,
    type ForkComparisonClient,
  } from './fork-comparison-data.ts';

  interface ForkComparisonProps {
    readonly client: ForkComparisonClient;
    /** The fork: the run whose comparison with its source is shown. */
    readonly workflowId: string;
  }

  let { client, workflowId }: ForkComparisonProps = $props();

  const comparisonQuery = createQuery(() => ({
    queryKey: forkComparisonQueryKey(workflowId),
    queryFn: () => fetchForkComparison(client, workflowId),
  }));

  const treatment = $derived(
    comparisonQuery.isError ? faultTreatment(comparisonQuery.error) : null,
  );

  const steps = $derived<readonly ComparedStep[]>(comparisonQuery.data?.steps ?? []);
  const sharedSteps = $derived(steps.filter((step) => step.shared));
  const ranAgain = $derived(
    steps
      .filter((step) => !step.shared)
      .map((step) => ({ step, kind: classifyComparedStep(step) })),
  );

  let selectedIndex = $state<number | null>(null);
  const selected = $derived(ranAgain.find((entry) => entry.step.index === selectedIndex));

  const KIND_BADGE: Record<ComparedStepKind, 'neutral' | 'warning' | 'info' | 'accent'> = {
    shared: 'neutral',
    changed: 'warning',
    unchanged: 'neutral',
    'source-only': 'info',
    'fork-only': 'accent',
  };

  /** The label a step carries: the fork's own entry when it has one, else the source's. */
  function labelOf(step: ComparedStep): string {
    return (step.fork ?? step.source)?.label ?? '';
  }

  /** What differs in a step both runs ran, as the words a row says under its title. */
  function differenceSummary(step: ComparedStep): string | undefined {
    if (step.source === undefined || step.fork === undefined) return undefined;
    const fields = differingFields(step.source, step.fork);
    return fields.length === 0
      ? undefined
      : RUN_COMPARISON_COPY.changedFields(fields.map((field) => RUN_COMPARISON_COPY.fields[field]));
  }

  type Payload = {
    readonly heading: string;
    readonly source: string | undefined;
    readonly fork: string | undefined;
  };

  /** A step's input and output summaries, side by side. */
  function payloadsOf(source: ComparedSide, fork: ComparedSide): Payload[] {
    return [
      { heading: RUN_COMPARISON_COPY.inputHeading, source: source.input, fork: fork.input },
      { heading: RUN_COMPARISON_COPY.outputHeading, source: source.output, fork: fork.output },
    ];
  }
</script>

<div class="weft-fork-comparison" data-section="fork-comparison">
  {#if comparisonQuery.isPending}
    <Skeleton height="8rem" />
  {:else if treatment}
    <ErrorState
      variant="flat"
      title={RUN_COMPARISON_COPY.loadFailedTitle}
      description={treatment.message}
      headingLevel={3}
      retryLabel={RETRY_LABEL}
      onRetry={() => void comparisonQuery.refetch()}
    />
  {:else if comparisonQuery.data}
    <p class="weft-fork-comparison__intro">
      {RUN_COMPARISON_COPY.intro(comparisonQuery.data.forkPoint)}
    </p>

    {#if sharedSteps.length > 0}
      <Collapsible variant="flat" trigger={RUN_COMPARISON_COPY.sharedSummary(sharedSteps.length)}>
        <p class="weft-fork-comparison__note">{RUN_COMPARISON_COPY.sharedNote}</p>
        <ul
          class="weft-fork-comparison__shared"
          aria-label={RUN_COMPARISON_COPY.sharedSummary(sharedSteps.length)}
        >
          {#each sharedSteps as step (step.index)}
            <li data-shared-step={step.index}>
              <span class="weft-fork-comparison__mono">
                {RUN_COMPARISON_COPY.stepTitle(step.index, labelOf(step))}
              </span>
              <Badge variant="neutral" size="sm">{RUN_COMPARISON_COPY.kinds.shared}</Badge>
            </li>
          {/each}
        </ul>
      </Collapsible>
    {/if}

    {#if ranAgain.length === 0}
      <EmptyState
        kind="first-use"
        headingLevel={3}
        title={RUN_COMPARISON_COPY.noStepsTitle}
        description={RUN_COMPARISON_COPY.noStepsDescription}
      />
    {:else}
      <div class="weft-fork-comparison__layout">
        <Section title={RUN_COMPARISON_COPY.stepsHeading} level={3}>
          <ul class="weft-fork-comparison__steps" aria-label={RUN_COMPARISON_COPY.stepsLabel}>
            {#each ranAgain as { step, kind } (step.index)}
              <li>
                <button
                  type="button"
                  class="weft-fork-comparison__row"
                  data-compared-step={step.index}
                  data-kind={kind}
                  aria-pressed={selectedIndex === step.index}
                  onclick={() => (selectedIndex = step.index)}
                >
                  <span class="weft-fork-comparison__mono weft-fork-comparison__row-title">
                    {RUN_COMPARISON_COPY.stepTitle(step.index, labelOf(step))}
                  </span>
                  <Badge variant={KIND_BADGE[kind]} size="sm"
                    >{RUN_COMPARISON_COPY.kinds[kind]}</Badge
                  >
                  {#if differenceSummary(step)}
                    <span class="weft-fork-comparison__row-detail">{differenceSummary(step)}</span>
                  {/if}
                </button>
              </li>
            {/each}
          </ul>
        </Section>

        <div class="weft-fork-comparison__detail">
          {#if selected === undefined}
            <EmptyState
              kind="first-use"
              headingLevel={3}
              title={RUN_COMPARISON_COPY.chooseTitle}
              description={RUN_COMPARISON_COPY.chooseDescription}
            />
          {:else}
            {@const { step, kind } = selected}
            <Section
              title={RUN_COMPARISON_COPY.detailLabel(step.index)}
              level={3}
              data-compared-detail={step.index}
            >
              <div class="weft-fork-comparison__detail-body">
                {#if step.source === undefined || step.fork === undefined}
                  <p class="weft-fork-comparison__note">
                    {kind === 'source-only'
                      ? RUN_COMPARISON_COPY.onlyInSource
                      : RUN_COMPARISON_COPY.onlyInFork}
                  </p>
                {:else}
                  {#if step.source.operationType !== step.fork.operationType}
                    <p class="weft-fork-comparison__note">
                      {RUN_COMPARISON_COPY.operationChange(
                        step.source.operationType,
                        step.fork.operationType,
                      )}
                    </p>
                  {/if}
                  {#if step.source.status !== step.fork.status}
                    <p class="weft-fork-comparison__note">
                      {RUN_COMPARISON_COPY.statusChange(step.source.status, step.fork.status)}
                    </p>
                  {/if}
                  {#each payloadsOf(step.source, step.fork) as payload (payload.heading)}
                    <Section title={payload.heading} level={4}>
                      {#if payload.source === undefined && payload.fork === undefined}
                        <p class="weft-fork-comparison__note">
                          {RUN_COMPARISON_COPY.sameBothSides(payload.heading)}
                        </p>
                      {:else if payload.source === undefined}
                        <p class="weft-fork-comparison__note">
                          {RUN_COMPARISON_COPY.missingSource(payload.heading)}
                        </p>
                      {:else if payload.fork === undefined}
                        <p class="weft-fork-comparison__note">
                          {RUN_COMPARISON_COPY.missingFork(payload.heading)}
                        </p>
                      {:else if payload.source === payload.fork}
                        <p class="weft-fork-comparison__note">
                          {RUN_COMPARISON_COPY.sameBothSides(payload.heading)}
                        </p>
                      {:else}
                        <JsonDiffViewer
                          before={parseSummary(payload.source)}
                          after={parseSummary(payload.fork)}
                          label={RUN_COMPARISON_COPY.diffLabel(payload.heading, step.index)}
                        />
                      {/if}
                    </Section>
                  {/each}
                {/if}
              </div>
            </Section>
          {/if}
        </div>
      </div>
    {/if}
  {/if}
</div>

<style>
  .weft-fork-comparison {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    min-width: 0;
  }

  .weft-fork-comparison__intro,
  .weft-fork-comparison__note {
    margin: 0;
    font-size: var(--cinder-text-xs);
    color: var(--cinder-text-subtle);
  }

  .weft-fork-comparison__layout {
    display: grid;
    grid-template-columns: minmax(220px, 320px) 1fr;
    gap: var(--cinder-space-4);
    align-items: start;
  }

  @media (max-width: 900px) {
    .weft-fork-comparison__layout {
      grid-template-columns: 1fr;
    }
  }

  .weft-fork-comparison__shared,
  .weft-fork-comparison__steps {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .weft-fork-comparison__shared li {
    display: flex;
    align-items: center;
    gap: var(--cinder-space-2);
    padding: var(--cinder-space-1) var(--cinder-space-2);
    font-size: var(--cinder-text-xs);
  }

  .weft-fork-comparison__mono {
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-xs);
  }

  .weft-fork-comparison__row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--cinder-space-2);
    width: 100%;
    min-height: 40px;
    padding: var(--cinder-space-2);
    background: transparent;
    border: 0;
    border-radius: var(--cinder-radius-md);
    font: inherit;
    color: inherit;
    cursor: pointer;
    text-align: start;
  }

  @media (hover: hover) {
    .weft-fork-comparison__row:hover {
      background: var(--cinder-surface-hover);
    }
  }

  .weft-fork-comparison__row[aria-pressed='true'] {
    background: var(--cinder-surface-hover);
  }

  .weft-fork-comparison__row-title {
    flex: 1 1 auto;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .weft-fork-comparison__row-detail {
    flex-basis: 100%;
    font-size: var(--cinder-text-2xs);
    color: var(--cinder-text-subtle);
  }

  .weft-fork-comparison__detail {
    min-width: 0;
  }

  .weft-fork-comparison__detail-body {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
  }
</style>
