<script lang="ts">
  /**
   * Why a failed run failed, as the Bureau stored it (COR-2533, `bureau.tasks.explain`): the
   * Bureau's sentence, then the cause, the step, how often it was tried, the guardrails that fired,
   * and what to do next, drawn by the one component the failure explanation panel draws it with, so
   * the two read alike. The words are the server's: Chat, the CLI and the panel give the same
   * answer, so this holds no sentence per category. The stack, which the explanation never carries,
   * is behind a disclosure. While the answer is not there, or when the Bureau cannot give one (an
   * engine run it does not hold), the engine's category shows as a badge, then `fallback` says what
   * the page itself knows, and nothing else is invented.
   */
  import { Badge, Collapsible } from '@lostgradient/cinder';
  import FailureExplanation from '@lostgradient/interborough-plugin/failure-explanation.svelte';
  import {
    buildExplanationModel,
    FAILURE_EXPLANATION_LABELS,
  } from '@lostgradient/interborough-plugin/failure-explanation';
  import type { WorkflowState } from '@lostgradient/weft';
  import { createQuery } from '@tanstack/svelte-query';
  import type { Snippet } from 'svelte';

  import { RUN_DETAIL_COPY } from '../../../app/copy/runs.ts';
  import { explainRunFailure } from '../../../lib/bureau-tasks.ts';
  import { queryKeys } from '../../../lib/query.ts';
  import { FAILURE_EXPLANATION_ANCHOR, router } from '../../../lib/router.svelte.ts';
  import { failureCategoryLabel, failureCategoryTone } from '../detail/failure-category.ts';

  interface RunFailureExplanationProps {
    /** The failed run: an agent run's task id, or an instance's id. */
    runId: string;
    /** The category the engine holds, for the badge while the explanation is not there. */
    category?: WorkflowState['failureCategory'];
    /** The engine's stack, which the explanation does not carry, behind a disclosure. */
    errorStack?: string | undefined;
    /** Whether the answer names the step, which a host that names it in its own heading leaves out. */
    showStep?: boolean;
    /** What the page itself says of the failure while the Bureau has no answer, or holds none. */
    fallback?: Snippet | undefined;
  }

  let {
    runId,
    category = undefined,
    errorStack = undefined,
    showStep = true,
    fallback = undefined,
  }: RunFailureExplanationProps = $props();

  const copy = RUN_DETAIL_COPY.instance;

  const explanation = createQuery(
    () => ({
      queryKey: queryKeys.bureauTasks.explanation(runId),
      queryFn: ({ signal }: { signal: AbortSignal }) => explainRunFailure(runId, { signal }),
      retry: false,
    }),
    undefined,
  );
  const answer = $derived(explanation.data);

  // A client-side navigation to `#failure-explanation` (Chat's "Why it failed" link) never scrolls
  // as a page load does, and this section mounts after the run's own queries resolve, so it scrolls
  // itself into view once it is there, and again once its answer has changed its height.
  let section = $state<HTMLElement | undefined>();
  $effect(() => {
    if (section === undefined || router.hash !== `#${FAILURE_EXPLANATION_ANCHOR}`) return;
    void answer;
    section.scrollIntoView({ block: 'start' });
  });
</script>

<div
  bind:this={section}
  class="ib-run-explanation"
  id={FAILURE_EXPLANATION_ANCHOR}
  role="group"
  aria-label={FAILURE_EXPLANATION_LABELS.region}
  data-run-explanation
>
  {#if answer !== undefined}
    <FailureExplanation model={buildExplanationModel(answer)} {showStep} />
  {:else}
    {#if category !== undefined}
      <!-- Reading the answer, or the Bureau holds none: the engine's own kind of failure, in a badge. -->
      <p class="ib-run-explanation__fallback" data-run-failure-category>
        <Badge variant={failureCategoryTone(category)}>{failureCategoryLabel(category)}</Badge>
      </p>
    {/if}
    {@render fallback?.()}
  {/if}
  {#if errorStack !== undefined && errorStack.length > 0}
    <Collapsible variant="flat" trigger={copy.inBlock.errorDetails}>
      <pre class="weft-send-tab__result" data-explanation="stack">{errorStack}</pre>
    </Collapsible>
  {/if}
</div>
