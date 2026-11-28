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
  import { Badge, Button, Collapsible, ErrorState, Stack, Text } from '@lostgradient/cinder';
  import { FailureExplanation } from '@lostgradient/plugin-inspectors/failure-explanation';
  import { displayStack } from '../../../lib/run-diagnostic-display.ts';
  import {
    buildExplanationModel,
    FAILURE_EXPLANATION_LABELS,
  } from '@lostgradient/interborough-plugin/failure-explanation';
  import type { WorkflowState } from '@lostgradient/weft';
  import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';
  import type { Snippet } from 'svelte';

  import { Plug } from '@lucide/svelte';

  import { CHAT_COPY } from '../../../app/copy/chat.ts';
  import FaultErrorState from '../../../app/fault-error-state.svelte';
  import { RUN_DETAIL_COPY, RUN_EXPLAIN_FURTHER_COPY } from '../../../app/copy/runs.ts';
  import { CHAT_READINESS_PATHS, providerConnected } from '../../../app/first-run.ts';
  import {
    explainRunFailure,
    generateModelExplanation,
    readModelExplanation,
  } from '../../../lib/bureau-tasks.ts';
  import { faultTreatment } from '../../../lib/faults.ts';
  import { sentenceTime } from '../../../lib/format/clock.ts';
  import { formatCost } from '../../../lib/format/cost.ts';
  import { getProviders } from '../../../lib/host-providers.ts';
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
    /** How long the failing step's tries took, in words, when the engine's history says. */
    took?: string | undefined;
    /** What the page itself says of the failure while the Bureau has no answer, or holds none. */
    fallback?: Snippet | undefined;
    /**
     * Whether to offer "Explain further" (COR-2534): a failed agent run, whose task keeps what a
     * model writes. An instance of a workflow file has no task to keep it on, so it is not offered.
     */
    explainFurther?: boolean;
    /**
     * Whether the failed-ask row draws its own box. Left off where an Alert already surrounds this
     * section, so no box is drawn inside a box.
     */
    framed?: boolean;
  }

  let {
    runId,
    category = undefined,
    errorStack = undefined,
    showStep = true,
    took = undefined,
    fallback = undefined,
    explainFurther = false,
    framed = true,
  }: RunFailureExplanationProps = $props();

  const copy = RUN_DETAIL_COPY.instance;
  const furtherCopy = RUN_EXPLAIN_FURTHER_COPY;
  const queryClient = useQueryClient();

  // What a model wrote, kept on the task: read when the section opens, so a reopened page shows it
  // with no model call. Asking for one happens only on the action below.
  const stored = createQuery(
    () => ({
      queryKey: queryKeys.bureauTasks.modelExplanation(runId),
      queryFn: ({ signal }: { signal: AbortSignal }) => readModelExplanation(runId, { signal }),
      enabled: explainFurther,
      retry: false,
    }),
    undefined,
  );
  const ask = createMutation(() => ({
    mutationFn: () => generateModelExplanation(runId),
    onSuccess: (written) => {
      queryClient.setQueryData(queryKeys.bureauTasks.modelExplanation(runId), written);
    },
    // The fault is drawn under the action with the server's remediation, so no toast says it twice.
    onError: () => undefined,
  }));
  // Whether a provider is connected, read as Chat reads it (the same query key), so the action is
  // not offered where it cannot work: there is no model to ask until one is connected.
  const providers = createQuery(
    () => ({
      queryKey: queryKeys.hostProviders(),
      queryFn: ({ signal }: { signal: AbortSignal }) => getProviders({ signal }),
      enabled: explainFurther,
      retry: false,
    }),
    undefined,
  );
  const written = $derived(stored.data ?? undefined);
  // The fault of the last ask, with the server's remediation; a new ask clears it.
  const askFault = $derived(ask.isError ? faultTreatment(ask.error) : undefined);
  // No provider is its own state, in Chat's words: the providers say none is connected, or the Bureau
  // answered that no model can write the explanation (a fault that is not supported). It is never
  // drawn as a generic fault with the same fact said again.
  const noProvider = $derived(
    (providers.data !== undefined && !providerConnected(providers.data.providers)) ||
      askFault?.kind === 'not-supported',
  );
  const connect = CHAT_COPY.readiness['needs-provider'];
  const connectPath = CHAT_READINESS_PATHS['needs-provider'];

  const paragraphs = $derived((written?.text ?? '').split(/\n{2,}/).filter((part) => part !== ''));
  const writtenCost = $derived(formatCost(written?.costUsd));

  const explanation = createQuery(
    () => ({
      queryKey: queryKeys.bureauTasks.explanation(runId),
      queryFn: ({ signal }: { signal: AbortSignal }) => explainRunFailure(runId, { signal }),
      retry: false,
    }),
    undefined,
  );
  const answer = $derived(explanation.data);

  // The Tries row says how long the tries took when the engine's history does (row 55b): the
  // Bureau's answer holds how often, never how long.
  function modelOf(held: NonNullable<typeof answer>) {
    const model = buildExplanationModel(held);
    return model.tries === null || took === undefined
      ? model
      : { ...model, tries: copy.inBlock.triesIn(model.tries, took) };
  }

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
    <FailureExplanation model={modelOf(answer)} {showStep} />
  {:else}
    {#if category !== undefined}
      <!-- Reading the answer, or the Bureau holds none: the engine's own kind of failure, in a badge. -->
      <p class="ib-run-explanation__fallback" data-run-failure-category>
        <Badge variant={failureCategoryTone(category)}>{failureCategoryLabel(category)}</Badge>
      </p>
    {/if}
    {@render fallback?.()}
  {/if}
  {#if explainFurther}
    <Stack gap="var(--cinder-space-3)" data-explanation="further">
      {#if written !== undefined}
        <Stack gap="var(--cinder-space-2)" data-explanation="model-text">
          <!-- A heading in the sizes the page already has: body type, semibold, as the remediation's label. -->
          <Text as="h3" variant="body"><strong>{furtherCopy.heading}</strong></Text>
          <Text variant="caption" data-explanation="model-name">
            {furtherCopy.writtenBy(
              written.model,
              sentenceTime(Date.parse(written.generatedAt), Date.now()),
            )}
          </Text>
          {#each paragraphs as paragraph, index (index)}
            <Text variant="body" measure>{paragraph}</Text>
          {/each}
          <Text variant="caption" data-explanation="model-cost">
            {writtenCost === undefined ? furtherCopy.costUnknown : furtherCopy.cost(writtenCost)}
          </Text>
        </Stack>
      {/if}
      {#if noProvider}
        <!-- One title, in Chat's words, and the way to fix it: no second sentence, no action that cannot work. -->
        <ErrorState
          variant="row"
          tone="neutral"
          bordered={framed}
          measure
          title={furtherCopy.noProvider}
          description=""
          headingLevel={3}
          data-explanation="no-provider"
        >
          {#snippet icon()}
            <Plug />
          {/snippet}
          {#snippet secondaryAction()}
            <Button variant="secondary" href={router.href(connectPath)} label={connect.action} />
          {/snippet}
        </ErrorState>
      {:else}
        {#if askFault !== undefined}
          <div data-explanation="further-fault">
            <!-- No Try again here: the action under it asks again. -->
            <FaultErrorState treatment={askFault} offerHealth={false} bordered={framed} />
          </div>
        {/if}
        <div>
          <!-- It asks a model and writes the answer on the task, so it is a changing control. -->
          <Button
            data-changes
            variant="secondary"
            label={written === undefined ? furtherCopy.action : furtherCopy.again}
            loading={ask.isPending}
            disabled={ask.isPending || stored.isPending}
            onclick={() => ask.mutate()}
          />
        </div>
        {#if written === undefined}
          <Text variant="caption" measure data-explanation="further-note">{furtherCopy.note}</Text>
        {/if}
      {/if}
    </Stack>
  {/if}
  {#if errorStack !== undefined && errorStack.length > 0}
    <Collapsible variant="flat" trigger={copy.inBlock.errorDetails}>
      <pre class="weft-send-tab__result" data-explanation="stack">{displayStack(errorStack)}</pre>
    </Collapsible>
  {/if}
</div>
