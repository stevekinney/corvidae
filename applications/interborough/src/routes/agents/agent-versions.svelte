<script lang="ts">
  /**
   * The saved versions of an agent, newest first (`bureau.agents.versions.list`; board PageAgent,
   * rows 38x, 38z, 39t and 39u, and sweep W60): each save and each edit made to the file by hand is
   * one numbered version, whether or not the agent ran, with when it was saved, by whom, what it
   * changed and its hash, shown small. A version a run started on is marked Ran
   * (`bureau.agents.definitions.revisions`), so there is no second list of the versions that ran.
   * The newest version is the one the file holds: it is Current and has no Restore.
   *
   * View opens a version read-only in place of the tab's form (`viewing`), with a back link to the
   * list, what it changed from the version before it, its instructions, its tools with when each
   * asks first, the tools the current version allows that it does not, and its guardrails.
   *
   * Restore, from a row or from the version's own view, asks first, naming the changes it removes,
   * then writes the older version back to the file as a new version, so the list only grows. It
   * names the hash of the file the page read (`currentHash`), not the version's own hash, so a file
   * that changed since is refused instead of overwritten.
   */
  import {
    Alert,
    Badge,
    Button,
    ConfirmDialog,
    EmptyState,
    SectionHeading,
    Skeleton,
  } from '@lostgradient/cinder';
  import { ArrowLeft } from '@lucide/svelte';
  import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';

  import { AGENT_PAGE_COPY } from '../../app/copy/agents.ts';
  import { RETRY_LABEL } from '../../app/copy/views.ts';
  import {
    agentFaultOf,
    guardrailEntryId,
    listAgentRevisions,
    listAgentVersions,
    restoreAgentVersion,
    type AgentDetail,
    type AgentGuardrailEntry,
    type AgentVersion,
  } from '../../lib/agent-definitions.ts';
  import { rowTime } from '../../lib/format/clock.ts';
  import { keyedByOccurrence } from '../../lib/list-keys.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { humanizeName } from '../settings/plugins/plugin-presentation.ts';
  import { restoredChanges, versionChanges } from './agent-settings.ts';

  interface Props {
    /** The agent's identifier. */
    id: string;
    /** The hash of the file as the page read it, which a restore names. */
    currentHash: string | null;
    /** The definition the file holds now, which a version's view sets its tools against. */
    current: AgentDetail['definition'];
    /**
     * The tools a code agent states itself, which a version of its overrides that does not
     * override its tools allows; `undefined` for an agent file.
     */
    ownTools?: readonly string[] | undefined;
    /** The version open read-only, by its number, or `null` while the list shows. */
    viewing?: number | null;
  }

  let { id, currentHash, current, ownTools, viewing = $bindable(null) }: Props = $props();

  const copy = AGENT_PAGE_COPY.versions;
  const asksWords = AGENT_PAGE_COPY.access.approvals;
  const queryClient = useQueryClient();

  const versions = createQuery(
    () => ({
      queryKey: queryKeys.agents.versions(id),
      queryFn: ({ signal }) => listAgentVersions(id, { signal }),
      retry: false,
    }),
    undefined,
  );

  // The versions that ran, to mark them in the list. A failure leaves every version unmarked.
  const revisions = createQuery(
    () => ({
      queryKey: queryKeys.agents.revisions(id),
      queryFn: ({ signal }) => listAgentRevisions(id, { signal }),
      retry: false,
    }),
    undefined,
  );
  const ran = $derived(new Set((revisions.data ?? []).map((revision) => revision.hash)));

  const newest = $derived(versions.data?.[0]?.revision);
  const shown = $derived(
    viewing === null ? undefined : versions.data?.find((version) => version.revision === viewing),
  );

  let problem = $state<string | null>(null);
  /** The version a restore asks about, and whether its question is open. */
  let restoring = $state<number | null>(null);
  let restoreOpen = $state(false);

  /** Opens the question a restore of `revision` asks first (row 38z). */
  function askRestore(revision: number): void {
    restoring = revision;
    restoreOpen = true;
  }

  const restore = createMutation(() => ({
    mutationFn: (revision: number) => {
      if (currentHash === null) throw new TypeError('The agent has no file hash to restore over.');
      return restoreAgentVersion(id, revision, currentHash);
    },
    onMutate: () => {
      problem = null;
    },
    onSuccess: () => {
      restoreOpen = false;
      viewing = null;
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.versions(id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.overrides(id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.definition(id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.revisions(id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.list() });
    },
    onError: (error) => {
      restoreOpen = false;
      const fault = agentFaultOf(error);
      if (fault.kind === 'stale') problem = copy.restoreStale;
      else
        problem =
          fault.kind === 'rejected' || fault.kind === 'other' ? fault.message : copy.restoreFailed;
      if (fault.kind === 'stale') {
        void queryClient.invalidateQueries({ queryKey: queryKeys.agents.versions(id) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.agents.overrides(id) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.agents.definition(id) });
      }
    },
  }));

  /** When a version was saved and by whom: "Thu, Oct 29, 11:38 AM, you". */
  function savedLine(version: AgentVersion): string {
    const at = Date.parse(version.savedAt);
    const when = Number.isNaN(at) ? version.savedAt : rowTime(at, Date.now());
    return copy.saved(when, version.savedBy === null);
  }

  /** The version before `version`, while it is still kept. */
  function previousOf(version: AgentVersion): AgentVersion | undefined {
    return versions.data?.find((candidate) => candidate.revision === version.revision - 1);
  }

  /** The question a restore of `revision` asks. */
  const restoreDescription = $derived(
    restoring === null || newest === undefined
      ? ''
      : copy.restoreDialog.description(
          restoring,
          newest,
          restoredChanges(versions.data ?? [], restoring),
        ),
  );

  /** The tools of a version, each with when it asks first, and the current tools it does not allow. */
  function toolLines(version: AgentVersion): string[] {
    // A code agent's version holds overrides: the tools it overrides, else the agent's own.
    const overridden = version.overrides;
    const definition = version.definition;
    const tools = overridden === null ? definition?.tools : (overridden.tools ?? ownTools);
    if (tools === undefined) return [];
    const approvals = overridden === null ? definition?.approvals : overridden.approvals;
    const allowed = tools.map((tool) =>
      copy.view.tool(humanizeName(tool), asksWords[approvals?.[tool] ?? 'on-changes']),
    );
    const missing = (current?.tools ?? [])
      .filter((tool) => !tools.includes(tool))
      .map((tool) => copy.view.notAllowed(humanizeName(tool)));
    return [...allowed, ...missing];
  }

  /** The guardrails of a version, by id, whichever form its definition or overrides hold them in. */
  function guardrailsOf(version: AgentVersion): AgentGuardrailEntry[] {
    return (
      (version.overrides === null
        ? version.definition?.guardrails
        : version.overrides.guardrails) ?? []
    );
  }
</script>

<section class="ib-agent-section" aria-label={copy.heading} data-testid="agent-versions">
  {#if problem !== null}
    <Alert variant="danger" dismissible onDismiss={() => (problem = null)}>
      <p>{problem}</p>
    </Alert>
  {/if}

  {#if shown !== undefined}
    <!-- One version, read-only (rows 39t, 39u). -->
    <article class="ib-agent-version-view" data-testid="agent-version-view">
      <div>
        <Button variant="ghost" size="sm" onclick={() => (viewing = null)}>
          {#snippet leadingIcon()}<ArrowLeft aria-hidden="true" size={14} />{/snippet}
          {copy.view.back}
        </Button>
      </div>
      <header class="ib-agent-version-view__title-row">
        <div class="ib-agent-version-view__title">
          <h2>{copy.revision(shown.revision)}</h2>
          <p class="ib-agent-note">{copy.view.readOnly(savedLine(shown))}</p>
        </div>
        {#if shown.revision !== newest}
          <Button
            data-changes
            variant="secondary"
            size="sm"
            disabled={currentHash === null || restore.isPending}
            onclick={() => askRestore(shown.revision)}
            >{copy.restoreDialog.confirm(shown.revision)}</Button
          >
        {/if}
      </header>
      {#if shown.revision > 1}
        <p data-testid="agent-version-changed-from">
          {copy.view.changedFrom(shown.revision - 1, versionChanges(shown, previousOf(shown)))}
        </p>
      {/if}
      {#if newest !== undefined}
        <p class="ib-agent-note">
          {shown.overrides === null ? copy.view.note(newest) : copy.view.overridesNote(newest)}
        </p>
      {/if}
      {#if shown.definition === null && shown.overrides === null}
        <p class="ib-agent-note">{copy.view.noDefinition}</p>
      {:else}
        <section class="ib-agent-section" aria-label={copy.view.instructions}>
          <h3>{copy.view.instructions}</h3>
          {#if shown.overrides !== null && shown.overrides.instructions === null}
            <p class="ib-agent-note">{copy.view.ownInstructions}</p>
          {:else}
            <p class="ib-agent-version-view__instructions" data-testid="agent-version-instructions">
              {shown.overrides === null
                ? shown.definition?.instructions
                : shown.overrides.instructions}
            </p>
          {/if}
        </section>
        <section class="ib-agent-section" aria-label={copy.view.tools}>
          <h3>{copy.view.tools}</h3>
          {#if toolLines(shown).length === 0}
            <p class="ib-agent-note">
              {shown.overrides !== null && shown.overrides.tools === null
                ? copy.view.ownTools
                : copy.view.noTools}
            </p>
          {:else}
            <ul class="ib-agent-version-view__list" data-testid="agent-version-tools">
              {#each keyedByOccurrence(toolLines(shown), (line) => line) as { key, item: line } (key)}
                <li>{line}</li>
              {/each}
            </ul>
          {/if}
        </section>
        <section class="ib-agent-section" aria-label={copy.view.guardrails}>
          <h3>{copy.view.guardrails}</h3>
          {#if guardrailsOf(shown).length === 0}
            <p class="ib-agent-note">
              {shown.overrides !== null && shown.overrides.guardrails === null
                ? copy.view.ownGuardrails
                : copy.view.noGuardrails}
            </p>
          {:else}
            <ul class="ib-agent-version-view__list">
              {#each keyedByOccurrence(guardrailsOf(shown), guardrailEntryId) as { key, item: entry } (key)}
                <li><code>{guardrailEntryId(entry)}</code></li>
              {/each}
            </ul>
          {/if}
        </section>
      {/if}
    </article>
  {:else}
    <SectionHeading level={2} title={copy.heading} description={copy.description} />
    {#if versions.isError}
      <Alert variant="danger">
        <p>{copy.loadFailed}</p>
        <Button variant="secondary" size="sm" onclick={() => void versions.refetch()}
          >{RETRY_LABEL}</Button
        >
      </Alert>
    {:else if versions.isPending}
      <div role="status" aria-busy="true" aria-label={copy.heading}>
        <Skeleton height="4rem" />
      </div>
    {:else if versions.data.length === 0}
      <EmptyState
        kind="first-use"
        size="compact"
        headingLevel={3}
        title={copy.emptyTitle}
        description={copy.emptyDescription}
      />
    {:else}
      <ul class="ib-agent-versions" aria-label={copy.heading}>
        {#each versions.data as version, index (version.revision)}
          <li
            class="ib-agent-version"
            data-revision={version.revision}
            data-ran={ran.has(version.hash) ? 'true' : undefined}
          >
            <div class="ib-agent-version__body">
              <span class="ib-agent-version__title">
                {copy.revision(version.revision)}
                {#if index === 0}<Badge variant="accent" size="sm">{copy.current}</Badge>{/if}
                {#if ran.has(version.hash)}<Badge variant="neutral" size="sm">{copy.ran}</Badge
                  >{/if}
              </span>
              <span class="ib-agent-version__meta">
                <time datetime={version.savedAt}>{savedLine(version)}</time>
                <code class="ib-agent-version__hash" title={version.hash}
                  >{version.hash.slice(0, 8)}</code
                >
              </span>
              <span class="ib-agent-version__changed">
                {versionChanges(version, versions.data[index + 1])}
              </span>
            </div>
            {#if index > 0}
              <div class="ib-agent-version__actions">
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={copy.viewLabel(version.revision)}
                  onclick={() => (viewing = version.revision)}>{copy.viewAction}</Button
                >
                <Button
                  data-changes
                  variant="secondary"
                  size="sm"
                  aria-label={copy.restoreLabel(version.revision)}
                  disabled={currentHash === null || restore.isPending}
                  onclick={() => askRestore(version.revision)}>{copy.restoreAction}</Button
                >
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>

<!-- Restore asks first, naming what it removes (row 38z). -->
<ConfirmDialog
  bind:open={restoreOpen}
  title={restoring === null ? '' : copy.restoreDialog.title(restoring)}
  description={restoreDescription}
  confirmLabel={restoring === null ? '' : copy.restoreDialog.confirm(restoring)}
  busy={restore.isPending}
  closeOnConfirm={false}
  onConfirm={() => {
    if (restoring !== null) restore.mutate(restoring);
  }}
/>
