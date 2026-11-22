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
    ListDetail,
    SelectableRow,
    Section,
    Skeleton,
    Text,
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
  import { faultTitle, faultTreatment, treatmentErrorStateAdvice } from '../../../../lib/faults.ts';
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
    // Opened again, it reads again: the fork may have run on since it was last shown.
    refetchOnMount: 'always' as const,
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

  /** Below this width in pixels the detail sits under the list, as it does in the run comparison panel. */
  const STACK_BELOW = 720;

  /** `ListDetail` keys are text; a step's key is its index. */
  function keyOf(entry: { readonly step: ComparedStep }): string {
    return String(entry.step.index);
  }

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
      title={faultTitle(treatment.kind, RUN_COMPARISON_COPY.loadFailedSubject)}
      description={treatment.message}
      headingLevel={3}
      retryLabel={RETRY_LABEL}
      {...treatmentErrorStateAdvice(treatment, () => void comparisonQuery.refetch())}
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
      <!-- The same Cinder list the run comparison panel draws: ListDetail over SelectableRow. -->
      <div
        class="weft-fork-comparison__frame"
        data-step-chosen={selected === undefined ? undefined : ''}
      >
        <ListDetail
          items={ranAgain}
          key={keyOf}
          label={RUN_COMPARISON_COPY.stepsLabel}
          detailLabel={RUN_COMPARISON_COPY.detailRegionLabel}
          selectionParameter={null}
          pushBelow={0}
          stackBelow={STACK_BELOW}
          bind:selectedKey={
            () => (selectedIndex === null ? null : String(selectedIndex)),
            (key) => (selectedIndex = key === null ? null : Number(key))
          }
        >
          {#snippet header()}
            <Text as="h3" variant="h4">{RUN_COMPARISON_COPY.stepsHeading}</Text>
          {/snippet}
          {#snippet list({ step, kind }, context)}
            {#snippet differs()}{differenceSummary(step)}{/snippet}
            <SelectableRow
              selected={context.selected}
              selectedState="current"
              onclick={context.open}
              data-compared-step={step.index}
              data-kind={kind}
              {...differenceSummary(step) === undefined ? {} : { description: differs }}
            >
              {#snippet title()}
                <span class="weft-fork-comparison__mono">
                  {RUN_COMPARISON_COPY.stepTitle(step.index, labelOf(step))}
                </span>
              {/snippet}
              {#snippet meta()}
                <Badge variant={KIND_BADGE[kind]} size="sm">{RUN_COMPARISON_COPY.kinds[kind]}</Badge
                >
              {/snippet}
            </SelectableRow>
          {/snippet}
          {#snippet empty()}
            <div class="weft-fork-comparison__detail-body">
              <Text as="h3" variant="h4">{RUN_COMPARISON_COPY.chooseTitle}</Text>
              <p class="weft-fork-comparison__note">{RUN_COMPARISON_COPY.chooseDescription}</p>
            </div>
          {/snippet}
          {#snippet detail({ step, kind })}
            <div class="weft-fork-comparison__detail-body" data-compared-detail={step.index}>
              <Text as="h3" variant="h4">{RUN_COMPARISON_COPY.detailLabel(step.index)}</Text>
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
          {/snippet}
        </ListDetail>
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

  /* The list owns its height when the panes sit side by side, so the frame gives it one, as the run
   * page's step list does: fixed once a step is open, and only as tall as what it holds, up to the
   * same height, before. With the detail under the list the page simply grows. */
  .weft-fork-comparison__frame {
    min-inline-size: 0;
  }

  .weft-fork-comparison__frame[data-step-chosen]:has(:global([data-cinder-layout='split'])) {
    block-size: 30rem;
    overflow: hidden;
  }

  .weft-fork-comparison__frame:not([data-step-chosen]):has(:global([data-cinder-layout='split'])) {
    max-block-size: 30rem;
    overflow-y: auto;
  }

  .weft-fork-comparison__shared {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-1);
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
    overflow-wrap: anywhere;
  }

  .weft-fork-comparison__detail-body {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
  }
</style>
