<script lang="ts" module>
  /**
   * @cinder
   * @category navigation
   * @status stable
   * @purpose Ordered progress indicator that visualizes a fixed sequence of steps with completed, current, skipped, and upcoming states.
   * @tag navigation
   * @tag progress
   * @useWhen Walking the user through a multi-step wizard or checkout flow with strict ordering.
   * @useWhen Showing how far the user has advanced through a known number of stages.
   * @useWhen Showing a first-run checklist whose steps complete in any order, each with its own action, with the checklist variant.
   * @useWhen Reporting the progress of a short job, such as a restart, as a list of what is done, running and waiting, with the status variant.
   * @avoidWhen Switching between independent peer views with no order — use tabs instead.
   * @avoidWhen Showing ancestor hierarchy of the current page — use breadcrumbs instead.
   * @related tabs, breadcrumbs, pagination
   */
  export type {
    StepItem,
    StepItemState,
    StepsOrientation,
    StepsProps,
    StepsVariant,
  } from './steps.types.ts';
</script>

<script lang="ts">
  import type { Snippet } from 'svelte';

  import type { StepItemState, StepsProps } from './steps.types.ts';
  import { classNames } from '../../utilities/class-names.ts';
  import Check from '@lucide/svelte/icons/check';

  let {
    steps,
    currentStep = 0,
    variant = 'stepper',
    orientation = 'horizontal',
    heading,
    headingLevel = 3,
    progressLabel = (done: number, total: number) => `${done} of ${total} done`,
    label = 'Progress',
    completedLabel = 'Completed',
    skippedLabel = 'Skipped',
    currentLabel = 'In progress',
    pendingLabel = 'Pending',
    class: className,
    ...rest
  }: StepsProps = $props();

  // SSR-safe, per-instance id so a checklist section names itself from its heading.
  const headingId = $props.id();

  // An unknown variant behaves as the stepper, so the component never renders no layout at all.
  const safeVariant = $derived(
    variant === 'checklist' || variant === 'status' ? variant : 'stepper',
  );
  const isStepper = $derived(safeVariant === 'stepper');
  const isChecklist = $derived(safeVariant === 'checklist');
  const isStatus = $derived(safeVariant === 'status');

  // Coerce + clamp at runtime: <h0>/<hNaN> is invalid markup.
  const headingTag = $derived(
    `h${Number.isFinite(Math.trunc(Number(headingLevel))) ? Math.min(6, Math.max(1, Math.trunc(Number(headingLevel)))) : 3}`,
  );

  const clampedCurrent = $derived(
    steps.length === 0 ? undefined : Math.max(0, Math.min(steps.length, currentStep)),
  );

  // Steps of a checklist or a status list complete in any order, so "current" is the first step
  // that isn't done and an earlier skipped step does not exist.
  const firstOpenIndex = $derived(steps.findIndex((step) => step.done !== true));
  const doneCount = $derived(steps.filter((step) => step.done === true).length);

  const stepStates = $derived<StepItemState[]>(
    steps.map((step, index) => {
      if (!isStepper) {
        if (step.done === true) return 'complete';
        return index === firstOpenIndex ? 'current' : 'upcoming';
      }
      if (clampedCurrent === undefined) return 'upcoming';
      if (index === clampedCurrent) return 'current';
      if (step.state === 'skipped' && index < clampedCurrent) return 'skipped';
      if (index < clampedCurrent) return 'complete';
      return 'upcoming';
    }),
  );
</script>

<!-- A stepper is navigation; a checklist is a section; a status list is a status region. -->
<svelte:element
  this={isStepper ? 'nav' : isChecklist ? 'section' : 'div'}
  {...rest}
  class={classNames('cinder-steps', className)}
  role={isStatus ? 'status' : undefined}
  aria-label={isChecklist && heading ? undefined : label}
  aria-labelledby={isChecklist && heading ? headingId : undefined}
  data-cinder-variant={isStepper ? undefined : safeVariant}
  data-cinder-orientation={isStepper ? orientation : undefined}
>
  {#if isChecklist && heading}
    <div class="cinder-steps__header">
      <svelte:element this={headingTag} id={headingId} class="cinder-steps__heading">
        {heading}
      </svelte:element>
      <span class="cinder-steps__progress">{progressLabel(doneCount, steps.length)}</span>
    </div>
  {/if}
  <ol class="cinder-steps__list">
    {#each steps as step, index (step.id)}
      {@const state = stepStates[index] ?? 'upcoming'}
      {@const isCurrent = state === 'current'}
      {@const isComplete = state === 'complete'}
      {@const connectorState =
        clampedCurrent !== undefined && index < clampedCurrent ? 'complete' : 'upcoming'}
      {@const hasHref = step.href !== undefined}
      {@const isInteractive = hasHref || step.onclick !== undefined}
      {@const stepLabel = step.label}
      {@const stepDescription = step.description}
      {@const stateLabel =
        state === 'complete'
          ? completedLabel
          : state === 'skipped'
            ? skippedLabel
            : isStatus
              ? isCurrent
                ? currentLabel
                : pendingLabel
              : undefined}
      <li
        class="cinder-steps__item"
        data-cinder-state={state}
        aria-current={isCurrent && !isInteractive ? 'step' : undefined}
      >
        <span class="cinder-steps__marker" aria-hidden="true">
          {#if isComplete}
            <Check class="cinder-steps__check" />
          {:else if isStatus}
            <span class={isCurrent ? 'cinder-steps__spinner' : 'cinder-steps__pending'}></span>
          {:else}
            <span class="cinder-steps__index">{index + 1}</span>
          {/if}
        </span>
        {#if hasHref}
          <a
            class="cinder-steps__interactive cinder-steps__body"
            href={step.href}
            onclick={step.onclick}
            aria-current={isCurrent ? 'step' : undefined}
          >
            {@render stepBody(stepLabel, stepDescription, stateLabel)}
          </a>
        {:else if step.onclick}
          <button
            type="button"
            class="cinder-steps__interactive cinder-steps__body"
            onclick={step.onclick}
            aria-current={isCurrent ? 'step' : undefined}
          >
            {@render stepBody(stepLabel, stepDescription, stateLabel)}
          </button>
        {:else}
          <span class="cinder-steps__body">
            {@render stepBody(stepLabel, stepDescription, stateLabel)}
          </span>
        {/if}
        {#if isChecklist && step.action}
          <div class="cinder-steps__action">
            {@render step.action(state)}
          </div>
        {/if}
        {#if isStepper && index < steps.length - 1}
          <span
            class="cinder-steps__connector"
            data-cinder-state={connectorState}
            aria-hidden="true"
          ></span>
        {/if}
      </li>
    {/each}
  </ol>
</svelte:element>

{#snippet stepBody(
  bodyLabel: string | Snippet,
  bodyDescription: undefined | string | Snippet,
  bodyStateLabel: string | undefined,
)}
  <span class="cinder-steps__body-content">
    {#if bodyStateLabel}
      <span class="cinder-steps__sr-only">{bodyStateLabel}</span>
      <span class="cinder-steps__sr-only-separator"> </span>
    {/if}
    <span class="cinder-steps__label">
      {#if typeof bodyLabel === 'string'}{bodyLabel}{:else}{@render bodyLabel()}{/if}
    </span>
    {#if bodyDescription}
      <span class="cinder-steps__description">
        {#if typeof bodyDescription === 'string'}{bodyDescription}{:else}{@render bodyDescription()}{/if}
      </span>
    {/if}
  </span>
{/snippet}
