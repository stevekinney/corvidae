<script lang="ts">
  /**
   * The Instructions tab of an agent's page (board PageAgent, rows 38i, 38j and 39r): the version of
   * the agent's file ("Version 4, saved Oct 29 by you"), the body of the file as a document in a
   * card, and the reference documents the file lists, read-only, each with its size. Documents are
   * added and removed in the editor, so the section says so with a link to it, and an agent that
   * reads none says it in one muted line whose "the editor" is the link. The tab bar names the tab
   * and the header holds Edit, so the body repeats neither (sweep S51). An agent defined in code has
   * no file to edit, so it says so and shows the instructions it states for itself when it states
   * any. The page's frame says when the agent is still being read or could not be
   * (`agent-tab-state.svelte`). The Markdown is rendered and sanitized by `@lostgradient/markdown`.
   */
  import { Button, Card, EmptyState, SectionHeading, Skeleton } from '@lostgradient/cinder';
  import { renderMarkdown } from '@lostgradient/markdown';
  import { createQuery } from '@tanstack/svelte-query';

  import { AGENT_PAGE_COPY } from '../../app/copy/agents.ts';
  import { listAgentVersions, type AgentDetail } from '../../lib/agent-definitions.ts';
  import { agentTabPath } from '../../lib/agent-paths.ts';
  import { keyedByOccurrence } from '../../lib/list-keys.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import AgentPluginNote from './agent-plugin-note.svelte';
  import { referenceSizeText, versionLine } from './agent-presentation.ts';

  interface Props {
    /** The agent's identifier. */
    id: string;
    /** Where Add instructions and the reference documents' links go: the agent's editor. */
    editPath: string;
    /** The plugin that ships the agent, or `null`: its file is read-only. */
    plugin: string | null;
    /** The agent as the Bureau shows it, once read. */
    detail: AgentDetail | undefined;
    /** The plugin's title, as Settings › Plugins shows it, for the line that names the plugin. */
    pluginTitle?: string;
    /** Whether the agent's plugin is disabled. */
    unavailable?: boolean;
    /**
     * Whether the page changes the agent through overrides (COR-2229): its instructions are
     * shown here, with the overrides applied, and changed on the Settings tab.
     */
    overridable?: boolean;
  }

  let {
    id,
    editPath,
    plugin,
    detail,
    pluginTitle = '',
    unavailable = false,
    overridable = false,
  }: Props = $props();

  const copy = AGENT_PAGE_COPY.instructions;

  const isFile = $derived(detail?.source === 'file');
  const body = $derived(
    isFile
      ? (detail?.definition?.instructions ?? '')
      : (detail?.codeDefinition?.instructions ?? ''),
  );
  const references = $derived(detail?.definition?.references ?? []);
  const html = $derived(body.trim() === '' ? '' : renderMarkdown(body).html);
  const editable = $derived(isFile && plugin === null);

  // The newest saved version, which is the one the file holds: the Versions list on Settings reads
  // the same entry. A read that fails or has nothing yet leaves the line out; the document stands.
  const versions = createQuery(
    () => ({
      queryKey: queryKeys.agents.versions(id),
      queryFn: ({ signal }: { signal: AbortSignal }) => listAgentVersions(id, { signal }),
      enabled: isFile,
      retry: false,
    }),
    undefined,
  );
  const newest = $derived(versions.data?.[0]);
  const version = $derived(newest === undefined ? undefined : versionLine(newest));

  /** The size of the reference document at `path` as its row says it, or `undefined` when the Bureau did not say. */
  function sizeOf(path: string): string | undefined {
    return referenceSizeText(detail?.referenceSizes?.find((entry) => entry.path === path)?.size);
  }

  function goToEditor(event: MouseEvent): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(editPath);
  }

  const settingsPath = $derived(agentTabPath(id, 'settings'));

  function goToSettings(event: MouseEvent): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(settingsPath);
  }
</script>

{#snippet addInstructions()}
  <Button href={router.href(editPath)} variant="primary" size="sm" onclick={goToEditor}
    >{copy.emptyAction}</Button
  >
{/snippet}

{#snippet addOnSettings()}
  <Button
    href={router.href(settingsPath)}
    variant="primary"
    size="sm"
    data-testid="agent-instructions-settings"
    onclick={goToSettings}>{copy.emptyAction}</Button
  >
{/snippet}

{#snippet editorLink(label: string)}
  <a href={router.href(editPath)} onclick={goToEditor}>{label}</a>
{/snippet}

<div class="ib-agent-instructions" data-testid="agent-instructions">
  {#if detail === undefined}
    <div role="status" aria-busy="true" aria-label={copy.heading}>
      <Skeleton height="8rem" />
    </div>
  {:else}
    <section class="ib-agent-section" aria-label={copy.heading}>
      {#if overridable}
        <AgentPluginNote {plugin} title={pluginTitle} mode="editable" />
        <!-- With none to change, the empty state's own action is the way to Settings: one statement, not three. -->
        {#if html !== ''}
          <p class="ib-agent-note" data-testid="agent-instructions-settings">
            {copy.changeBefore}<a href={router.href(settingsPath)} onclick={goToSettings}
              >{copy.changeSettings}</a
            >{copy.changeAfter}
          </p>
        {/if}
      {:else if plugin !== null}
        <AgentPluginNote
          {plugin}
          title={pluginTitle}
          mode={unavailable ? 'unavailable' : 'read-only'}
        />
      {:else if !isFile}
        <p class="ib-agent-note" data-testid="agent-built-in">{copy.builtIn}</p>
      {/if}
      {#if isFile && version !== undefined}
        <p class="ib-agent-note" data-testid="agent-version">{version}</p>
      {/if}
      {#if html === '' && editable}
        <EmptyState
          kind="first-use"
          size="compact"
          headingLevel={3}
          title={copy.emptyTitle}
          description={copy.emptyDescription}
          action={addInstructions}
        />
      {:else if html === '' && overridable}
        <EmptyState
          kind="first-use"
          size="compact"
          headingLevel={3}
          title={copy.emptyTitle}
          description={copy.emptyDescription}
          action={addOnSettings}
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
        <Card variant="card" edge="border">
          <!-- `renderMarkdown` sanitizes before it returns HTML. -->
          <div
            class="cinder-markdown-content ib-agent-document"
            data-testid="agent-instructions-body"
          >
            {@html html}
          </div>
        </Card>
      {/if}
    </section>

    {#if isFile}
      <section class="ib-agent-section" aria-label={copy.referencesHeading}>
        <SectionHeading
          level={2}
          title={copy.referencesHeading}
          description={copy.referencesDescription}
        />
        {#if references.length === 0 && !editable}
          <p class="ib-agent-note" data-testid="agent-no-references">{copy.noReferencesReadOnly}</p>
        {:else if references.length === 0}
          <p class="ib-agent-note" data-testid="agent-no-references">
            {copy.noReferencesBefore}{@render editorLink(
              copy.noReferencesEditor,
            )}{copy.noReferencesAfter}
          </p>
        {:else}
          <ul class="ib-agent-references" data-testid="agent-references">
            {#each keyedByOccurrence(references, (path) => path) as { key, item: path } (key)}
              {@const size = sizeOf(path)}
              <li>
                <code>{path}</code>
                {#if size !== undefined}<span class="ib-agent-note">{size}</span>{/if}
              </li>
            {/each}
          </ul>
          {#if editable}
            <p class="ib-agent-note" data-testid="agent-references-note">
              {copy.referencesNote}
              {@render editorLink(copy.editAgent)}
            </p>
          {/if}
        {/if}
      </section>
    {/if}
  {/if}
</div>
