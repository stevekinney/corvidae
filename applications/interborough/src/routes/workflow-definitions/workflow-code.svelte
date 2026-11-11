<script lang="ts">
  /**
   * The Code tab of a workflow's page. For an agent-authored workflow it is the file as it is on
   * disk, read-only, with line numbers, a Copy button, and an outline of its parts beside it (a
   * select above it on a phone). A file the Bureau cannot read keeps its text, shows the danger
   * banner with a way into the editor, and marks the line its JSON stops on. For a code-defined
   * workflow the code itself is not exposed: the Bureau answers the workflow's description and the
   * contract it registered with the engine (`bureau.workflows.internal.get`), and the tab says so
   * instead of presenting that as source.
   */
  import {
    Alert,
    Button,
    CodeBlock,
    EmptyState,
    SectionHeading,
    Select,
    Skeleton,
    TableOfContents,
    type TableOfContentsItem,
  } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';
  import { MediaQuery } from 'svelte/reactivity';

  import { RETRY_LABEL, WORKFLOW_COPY } from '../../app/copy.ts';
  import { classifyFault } from '../../lib/faults.ts';
  import { queryKeys } from '../../lib/query.ts';
  import {
    getCodeWorkflow,
    type WorkflowDocument,
    type WorkflowProblem,
  } from '../../lib/workflow-files.ts';
  import WorkflowFileProblem from './workflow-file-problem.svelte';
  import { stepRows } from './workflow-page-presentation.ts';
  import {
    locateJsonProblem,
    problemNote,
    sourceLineId,
    sourceOutline,
    type OutlineEntry,
  } from './workflow-source.ts';

  interface Props {
    /** The workflow's type. */
    type: string;
    /** Which service defines it: a file the Bureau holds, or code the engine registered. */
    kind: 'code' | 'agent-authored';
    /** The file's text exactly as it is on disk, or `null` when the Bureau could not read it. */
    text: string | null;
    /** The file's document, for the titles of the steps in the outline. */
    document: WorkflowDocument | undefined;
    /** The file's path, for the line above the source. */
    path?: string;
    /** Why the Bureau cannot use the file, when it cannot. */
    problem?: WorkflowProblem | null;
    /** Opens the editor on its JSON tab, from the banner. */
    onEditAsJson?: () => void;
  }

  let { type, kind, text, document, path = '', problem = null, onEditAsJson }: Props = $props();

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

  // The page cannot read the engine's message for broken JSON, so it finds the place itself.
  const located = $derived(
    problem?.code === 'invalid-json' && text !== null ? locateJsonProblem(text) : null,
  );
  const annotations = $derived(located === null ? [] : [problemNote(located)]);

  const outline = $derived<OutlineEntry[]>(
    text === null || problem !== null
      ? []
      : sourceOutline(
          text,
          stepRows(document?.steps ?? []).map((step) => step.title),
        ),
  );
  const outlineItems = $derived<TableOfContentsItem[]>(
    outline.map((entry) => ({
      id: sourceLineId(entry.line),
      label: entry.label,
      children: entry.children.map((child) => ({
        id: sourceLineId(child.line),
        label: child.label,
      })),
    })),
  );
  const outlineOptions = $derived(
    outline.flatMap((entry) => [
      { value: sourceLineId(entry.line), label: entry.label },
      ...entry.children.map((child) => ({
        value: sourceLineId(child.line),
        label: `${entry.label}, ${child.label}`,
      })),
    ]),
  );

  /** Whether the outline fits beside the file: 640px and wider; below that a select stands in for it. */
  const wide = new MediaQuery('(min-width: 40rem)', true);

  let sourceElement = $state<HTMLElement | undefined>();

  // The outline links to a line by its `id`, which CodeBlock does not give its lines, so the lines
  // an entry points at take one here.
  $effect(() => {
    const root = sourceElement;
    if (root === undefined) return;
    const rows = root.querySelectorAll<HTMLElement>('.cinder-code-block__line');
    const named: HTMLElement[] = [];
    for (const entry of outline) {
      for (const target of [entry, ...entry.children]) {
        const row = rows.item(target.line - 1);
        if (row === null) continue;
        row.id = sourceLineId(target.line);
        named.push(row);
      }
    }
    return () => {
      for (const row of named) row.removeAttribute('id');
    };
  });

  /** Scrolls to the line an outline select chose. */
  function jumpTo(id: string): void {
    globalThis.document.getElementById(id)?.scrollIntoView({ block: 'start' });
  }
</script>

<div class="ib-workflow__code" data-testid="workflow-code">
  {#if kind === 'agent-authored'}
    {#if problem !== null && onEditAsJson !== undefined}
      <WorkflowFileProblem
        fileName={`${type}.json`}
        {problem}
        {located}
        actionLabel={WORKFLOW_COPY.page.problem.editAsJson}
        onAction={onEditAsJson}
      />
    {/if}
    {#if text === null}
      <EmptyState kind="first-use" size="compact" headingLevel={3} title={copy.noText} />
    {:else}
      <section class="ib-workflow-source" aria-label={copy.fileHeading}>
        <div class="ib-workflow-source__file">
          <p class="ib-workflow-source__caption">
            {copy.caption.before}<code data-testid="workflow-file-path">{path}</code>{copy.caption
              .after}
          </p>
          {#if outlineOptions.length > 0 && !wide.current}
            <Select
              id="workflow-source-outline"
              label={copy.outlineSelect}
              options={outlineOptions}
              onchange={(event) => jumpTo(event.currentTarget.value)}
            />
          {/if}
          <div data-testid="workflow-file-source" bind:this={sourceElement}>
            <CodeBlock
              code={text}
              language="json"
              highlight={false}
              languageLabelVisible={false}
              copyable
              lineNumbers
              {annotations}
            />
          </div>
        </div>
        {#if outlineItems.length > 0 && wide.current}
          <div class="ib-workflow-source__outline" data-testid="workflow-outline">
            <p class="ib-workflow-source__outline-title">{copy.outlineTitle}</p>
            <TableOfContents ariaLabel={copy.outlineTitle} items={outlineItems} />
          </div>
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
