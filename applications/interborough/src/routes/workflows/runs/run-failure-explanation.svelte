<script lang="ts">
  /**
   * Why a failed run failed, as the Bureau stored it (COR-2533, `bureau.tasks.explain`): one
   * sentence naming the step and the cause, then the cause (the category's badge, the error's code
   * and kind), the step, how often it was tried, the guardrails that fired, and what to do next. The
   * words are the server's: Chat, the CLI and the failure explanation panel give the same answer, so
   * this holds no sentence per category. The stack, which the explanation never carries, is behind a
   * disclosure. While the answer is not there, or when the Bureau cannot give one (an engine run it
   * does not hold), the engine's category shows as a badge and nothing else is invented.
   */
  import {
    Badge,
    Collapsible,
    DescriptionList,
    type DescriptionListItem,
  } from '@lostgradient/cinder';
  import type { WorkflowState } from '@lostgradient/weft';
  import { createQuery } from '@tanstack/svelte-query';

  import { RUN_DETAIL_COPY } from '../../../app/copy/runs.ts';
  import { explainRunFailure } from '../../../lib/bureau-tasks.ts';
  import { queryKeys } from '../../../lib/query.ts';
  import { FAILURE_EXPLANATION_ANCHOR } from '../../../lib/router.svelte.ts';
  import { failureCategoryLabel, failureCategoryTone } from '../detail/failure-category.ts';

  interface RunFailureExplanationProps {
    /** The failed run: an agent run's task id, or an instance's id. */
    runId: string;
    /** The category the engine holds, for the badge while the explanation is not there. */
    category?: WorkflowState['failureCategory'];
    /** The engine's stack, which the explanation does not carry, behind a disclosure. */
    errorStack?: string | undefined;
  }

  let {
    runId,
    category = undefined,
    errorStack = undefined,
  }: RunFailureExplanationProps = $props();

  const copy = RUN_DETAIL_COPY.instance;
  const words = copy.explanation;

  const explanation = createQuery(
    () => ({
      queryKey: queryKeys.bureauTasks.explanation(runId),
      queryFn: ({ signal }: { signal: AbortSignal }) => explainRunFailure(runId, { signal }),
      retry: false,
    }),
    undefined,
  );
  const answer = $derived(explanation.data);
  // The server's category is the one the sentence is built from; the engine's stands in until it
  // arrives, and when the Bureau cannot say.
  const shown = $derived(answer === undefined ? category : answer.cause.category);

  const facts = $derived.by((): DescriptionListItem[] => {
    if (answer === undefined) return [];
    const items: DescriptionListItem[] = [{ id: 'cause', term: words.cause, definition: cause }];
    if (answer.step !== null) {
      items.push({
        id: 'step',
        term: words.step,
        definition: answer.step.label,
      });
    }
    if (answer.tries !== null) {
      items.push({ id: 'tries', term: words.tries, definition: String(answer.tries) });
    }
    if (answer.verdicts.length > 0) {
      items.push({ id: 'guardrails', term: words.guardrails, definition: guardrails });
    }
    return items;
  });
  const detail = $derived(
    answer === undefined ? '' : words.causeDetail(answer.cause.code, answer.cause.kind),
  );
</script>

{#snippet cause()}
  <span data-explanation="cause">
    <Badge variant={failureCategoryTone(shown)} data-run-failure-category>
      {failureCategoryLabel(shown)}
    </Badge>
    {#if detail !== ''}<span class="ib-run-explanation__detail">{detail}</span>{/if}
  </span>
{/snippet}

{#snippet guardrails()}
  <ul class="ib-run-explanation__guardrails" data-explanation="guardrails">
    {#each answer?.verdicts ?? [] as verdict (`${verdict.name}:${String(verdict.step)}:${verdict.outcome}`)}
      <li>{words.verdict(verdict.name, verdict.outcome)}</li>
    {/each}
  </ul>
{/snippet}

<div
  class="ib-run-explanation"
  id={FAILURE_EXPLANATION_ANCHOR}
  role="group"
  aria-label={words.region}
  data-run-explanation
>
  {#if answer !== undefined}
    <p class="ib-run-explanation__summary" data-explanation="summary">{answer.summary}</p>
    <DescriptionList items={facts} variant="two-column" />
    <p class="ib-run-explanation__next" data-explanation="remediation">
      <strong>{words.next}.</strong>
      {answer.remediation}
    </p>
  {:else if shown !== undefined}
    <!-- Reading the answer, or the Bureau holds none: the engine's own kind of failure, in a badge. -->
    <p class="ib-run-explanation__fallback" data-run-failure-category>
      <Badge variant={failureCategoryTone(shown)}>{failureCategoryLabel(shown)}</Badge>
    </p>
  {/if}
  {#if errorStack !== undefined && errorStack.length > 0}
    <Collapsible variant="flat" trigger={copy.inBlock.errorDetails}>
      <pre class="weft-send-tab__result" data-explanation="stack">{errorStack}</pre>
    </Collapsible>
  {/if}
</div>
