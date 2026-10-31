<script lang="ts">
  /**
   * The Code tab of a workflow's page. For an agent-authored workflow it is the file as it is on
   * disk, with an outline of its steps. For a code-defined workflow the code itself is not exposed:
   * the Bureau answers the workflow's description and the contract it registered with the engine
   * (`bureau.workflows.internal.get`), and the tab says so instead of presenting that as source.
   */
  import {
    Alert,
    Button,
    CodeBlock,
    EmptyState,
    SectionHeading,
    Skeleton,
  } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { RETRY_LABEL, WORKFLOW_COPY } from '../../app/copy.ts';
  import { classifyFault } from '../../lib/faults.ts';
  import { keyedByOccurrence } from '../../lib/list-keys.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { getCodeWorkflow, type WorkflowDocument } from '../../lib/workflow-files.ts';
  import { stepLabel } from './workflow-presentation.ts';

  interface Props {
    /** The workflow's type. */
    type: string;
    /** Which service defines it: a file the Bureau holds, or code the engine registered. */
    kind: 'code' | 'agent-authored';
    /** The file's text exactly as it is on disk, or `null` when the Bureau could not read it. */
    text: string | null;
    /** The file's document, for the outline of its steps. */
    document: WorkflowDocument | undefined;
  }

  let { type, kind, text, document }: Props = $props();

  const copy = WORKFLOW_COPY.page.code;

  const source = createQuery(
    () => ({
      queryKey: queryKeys.workflowCatalog.codeSource(type),
      queryFn: ({ signal }) => getCodeWorkflow(type, { signal }),
      enabled: kind === 'code',
      retry: false,
    }),
    undefined,
  );

  /** A workflow the Bureau does not know as code, or that the caller may not read, is `NotFound`. */
  const unavailable = $derived(source.isError && classifyFault(source.error)?.kind === 'not-found');
</script>

<div class="ib-workflow__code" data-testid="workflow-code">
  {#if kind === 'agent-authored'}
    <section class="ib-workflow__section" aria-label={copy.fileHeading}>
      <SectionHeading level={2} title={copy.fileHeading} />
      {#if text === null}
        <EmptyState kind="first-use" size="compact" headingLevel={3} title={copy.noText} />
      {:else}
        <div data-testid="workflow-file-source">
          <CodeBlock code={text} language="json" highlight={false} />
        </div>
      {/if}
    </section>
    {#if document !== undefined}
      <section class="ib-workflow__section" aria-label={copy.outlineHeading}>
        <SectionHeading level={2} title={copy.outlineHeading} />
        {#if document.steps.length === 0}
          <EmptyState kind="first-use" size="compact" headingLevel={3} title={copy.noOutline} />
        {:else}
          <ol class="ib-workflow__steps" data-testid="workflow-outline">
            {#each keyedByOccurrence( document.steps, (step) => stepLabel(step) ) as { key, item: step } (key)}
              <li class="ib-workflow__step">{stepLabel(step)}</li>
            {/each}
          </ol>
        {/if}
      </section>
    {/if}
  {:else}
    <section class="ib-workflow__section" aria-label={copy.codeHeading}>
      <SectionHeading level={2} title={copy.codeHeading} description={copy.codeNote} />
      {#if source.isPending}
        <div role="status" aria-busy="true" aria-label={copy.codeHeading}>
          <Skeleton height="8rem" />
        </div>
      {:else if unavailable}
        <EmptyState
          kind="first-use"
          size="compact"
          headingLevel={3}
          title={copy.unavailableTitle}
          description={copy.unavailableDescription}
        />
      {:else if source.isError}
        <Alert variant="danger">
          <p class="ib-workflow__alert-title">{copy.failedTitle}</p>
          <p class="ib-workflow__alert-body">{copy.failedDescription}</p>
          <Button variant="secondary" size="sm" onclick={() => void source.refetch()}
            >{RETRY_LABEL}</Button
          >
        </Alert>
      {:else}
        <div data-testid="workflow-code-source">
          <CodeBlock code={source.data.source.text} language="json" highlight={false} />
        </div>
      {/if}
    </section>
  {/if}
</div>
