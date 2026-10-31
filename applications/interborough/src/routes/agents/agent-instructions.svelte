<script lang="ts">
  /**
   * The Instructions tab of an agent's page: the body of the agent's file as a rendered document,
   * with Edit, and the reference documents the file lists. An agent defined in code has no file to
   * edit, so it says so where Edit would be and shows the instructions it states for itself when
   * it states any. The Markdown is rendered and sanitized by `@lostgradient/markdown`.
   */
  import { Alert, Button, EmptyState, SectionHeading, Skeleton } from '@lostgradient/cinder';
  import { renderMarkdown } from '@lostgradient/markdown';

  import { AGENT_PAGE_COPY, AGENT_EDITOR_COPY, RETRY_LABEL } from '../../app/copy.ts';
  import type { AgentDetail } from '../../lib/agent-definitions.ts';
  import { keyedByOccurrence } from '../../lib/list-keys.ts';
  import { router } from '../../lib/router.svelte.ts';

  interface Props {
    /** Where Edit goes: the agent's editor. */
    editPath: string;
    /** The agent as the Bureau shows it, once read. */
    detail: AgentDetail | undefined;
    failed: boolean;
    onRetry: () => void;
  }

  let { editPath, detail, failed, onRetry }: Props = $props();

  const copy = AGENT_PAGE_COPY.instructions;

  const isFile = $derived(detail?.source === 'file');
  const body = $derived(
    isFile
      ? (detail?.definition?.instructions ?? '')
      : (detail?.codeDefinition?.instructions ?? ''),
  );
  const references = $derived(detail?.definition?.references ?? []);
  const html = $derived(body.trim() === '' ? '' : renderMarkdown(body).html);

  function goToEditor(event: MouseEvent): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(editPath);
  }
</script>

{#snippet addInstructions()}
  <Button href={router.href(editPath)} variant="primary" size="sm" onclick={goToEditor}
    >{copy.emptyAction}</Button
  >
{/snippet}

<div class="ib-agent-instructions" data-testid="agent-instructions">
  {#if failed}
    <Alert variant="danger">
      <p>{copy.loadFailed}</p>
      <Button variant="secondary" size="sm" onclick={onRetry}>{RETRY_LABEL}</Button>
    </Alert>
  {:else if detail === undefined}
    <div role="status" aria-busy="true" aria-label={copy.heading}>
      <Skeleton height="8rem" />
    </div>
  {:else}
    <section class="ib-agent-section" aria-label={copy.heading}>
      <SectionHeading level={2} title={copy.heading}>
        {#snippet actions()}
          {#if isFile}
            <Button href={router.href(editPath)} variant="secondary" size="sm" onclick={goToEditor}
              >{AGENT_EDITOR_COPY.editAction}</Button
            >
          {/if}
        {/snippet}
      </SectionHeading>
      {#if !isFile}
        <p class="ib-agent-note" data-testid="agent-built-in">{copy.builtIn}</p>
      {/if}
      {#if html === '' && isFile}
        <EmptyState
          kind="first-use"
          size="compact"
          headingLevel={3}
          title={copy.emptyTitle}
          description={copy.emptyDescription}
          action={addInstructions}
        />
      {:else if html === ''}
        <EmptyState
          kind="first-use"
          size="compact"
          headingLevel={3}
          title={copy.emptyTitle}
          description={copy.emptyDescription}
        />
      {:else}
        <!-- `renderMarkdown` sanitizes before it returns HTML. -->
        <div class="ib-agent-document" data-testid="agent-instructions-body">{@html html}</div>
      {/if}
    </section>

    {#if isFile}
      <section class="ib-agent-section" aria-label={copy.referencesHeading}>
        <SectionHeading
          level={2}
          title={copy.referencesHeading}
          description={copy.referencesDescription}
        />
        {#if references.length === 0}
          <EmptyState
            kind="first-use"
            size="compact"
            headingLevel={3}
            title={copy.noReferencesTitle}
            description={copy.noReferencesDescription}
          />
        {:else}
          <ul class="ib-agent-references" data-testid="agent-references">
            {#each keyedByOccurrence(references, (path) => path) as { key, item: path } (key)}
              <li><code>{path}</code></li>
            {/each}
          </ul>
        {/if}
      </section>
    {/if}
  {/if}
</div>
