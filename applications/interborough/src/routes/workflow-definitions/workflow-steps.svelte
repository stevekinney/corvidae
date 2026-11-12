<script lang="ts">
  /**
   * A file's steps as one bordered, numbered list: each step has its title, a muted line for what
   * kind of step it is, and what it does. A step's message clamps to two lines (the whole message
   * is on the Code tab). A list whose steps say a lot shows its first step and a row that opens the
   * rest, so the page stays short where a long message would fill it.
   */
  import { Button } from '@lostgradient/cinder';

  import { WORKFLOW_COPY } from '../../app/copy/workflows.ts';
  import { hasLongStep, type PageStep } from './workflow-page-presentation.ts';

  interface Props {
    steps: readonly PageStep[];
  }

  let { steps }: Props = $props();

  const copy = WORKFLOW_COPY.page.steps;
  const collapsible = $derived(steps.length > 1 && hasLongStep(steps));
  let expanded = $state(false);
  const shown = $derived(collapsible && !expanded ? steps.slice(0, 1) : steps);
</script>

<ol class="ib-workflow-steps" data-testid="workflow-steps">
  {#each shown as step (step.position)}
    <li class="ib-workflow-steps__row" data-step={step.position}>
      <span class="ib-workflow-steps__number" aria-hidden="true">{step.position}</span>
      <div class="ib-workflow-steps__body">
        <p class="ib-workflow-steps__title" data-testid="workflow-step-title">{step.title}</p>
        <p class="ib-workflow-steps__kind" data-testid="workflow-step-kind">
          {step.kind}{#if step.identifier !== null}{' '}<code>{step.identifier}</code>{/if}
        </p>
        {#if step.description !== null}
          <p class="ib-workflow-steps__description" data-testid="workflow-step-description">
            {step.description}
          </p>
        {/if}
      </div>
    </li>
  {/each}
</ol>
{#if collapsible}
  <div>
    <Button variant="ghost" size="sm" onclick={() => (expanded = !expanded)}
      >{expanded ? copy.fewer : copy.more(steps.length - 1)}</Button
    >
  </div>
{/if}
