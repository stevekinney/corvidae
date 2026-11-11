<script lang="ts">
  /**
   * The Access tab of an agent's page (board PageAgent, rows 38l to 40c; board ResponsiveAndDark,
   * rows 07a and 07b; sweeps S32, S65 and W34).
   *
   * A toolbar with a search, a segment per source counting its tools, and at the right the one
   * allowed count ("3 of 9 allowed"). Under it one table of the tools, in collapsible groups by
   * source, each row with a leading allow box, the tool's name and identifier, what it does, its
   * risk in muted words and an Asks select; then the Skills group; then Guardrails and spend: the
   * plugin guardrails as boxes and the spend limit per chat.
   *
   * Each change saves at once as a new version (`agent-access-state.svelte.ts`): the row shows its
   * own spinner while the write is in flight, and goes back with a line that says so when it fails.
   * After a save the toolbar says "Saved as Version 5" beside the count, and a toast says the same
   * with View versions, which opens Settings, where the versions are. At rest the tab says nothing
   * about saving.
   *
   * While the server does not answer, the tab draws the offline banner itself and keeps the old
   * table at full contrast; the boxes, the selects and the spend field go inert and say why when
   * focused, and the page holds Edit back too, while the search and the segments still work.
   *
   * A file that changed on disk under the tab is read again: once no write is waiting, a hash the
   * tab did not write itself rebuilds the table. An agent the page cannot write (one defined in
   * code, or a plugin's) shows the same table read-only.
   */
  import {
    Alert,
    Banner,
    Button,
    Checkbox,
    EmptyState,
    FilterBar,
    Input,
    SectionHeading,
    Skeleton,
    Spinner,
    StaleRegion,
    Table,
    VisuallyHidden,
    type FilterSegment,
  } from '@lostgradient/cinder';
  import { Check } from '@lucide/svelte';
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';

  import {
    CONNECTION_MAX_ATTEMPTS,
    connectionBannerPreset,
    getConnection,
  } from '../../app/connection.svelte.ts';
  import {
    AGENT_EDITOR_COPY,
    AGENT_PAGE_COPY,
    CONNECTION_COPY,
    RETRY_LABEL,
  } from '../../app/copy.ts';
  import { restartActivity } from '../../app/restart/host-restart-flow.svelte.ts';
  import { hasToastHost, showToast } from '../../app/toast-host.svelte';
  import {
    agentFaultOf,
    getAgentCatalog,
    listAgentVersions,
    updateAgent,
    type AgentDetail,
    type AgentFault,
  } from '../../lib/agent-definitions.ts';
  import { agentTabPath, pluginOfAgent } from '../../lib/agent-paths.ts';
  import { listGuardrails } from '../../lib/bureau-guardrails.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { LIMIT_BOUNDS } from '../agent-editor/agent-editor-state.svelte.ts';
  import { humanizeName } from '../settings/plugins/plugin-presentation.ts';
  import AgentAccessGroupRow from './agent-access-group-row.svelte';
  import AgentAccessSkills from './agent-access-skills.svelte';
  import {
    AgentAccessState,
    groupAccessRows,
    matchesAccessRow,
    type AccessWriter,
  } from './agent-access-state.svelte.ts';
  import AgentAccessToolRow from './agent-access-tool-row.svelte';
  import AgentPluginNote from './agent-plugin-note.svelte';
  import { useAgentTabStale } from './agent-tab-stale.ts';

  interface Props {
    /** The agent's identifier. */
    id: string;
    /** The agent as the Bureau shows it, once read. */
    detail: AgentDetail | undefined;
  }

  let { id, detail }: Props = $props();

  const copy = AGENT_PAGE_COPY.access;
  const queryClient = useQueryClient();
  const connection = getConnection();
  const toasts = hasToastHost();
  const plugin = $derived(pluginOfAgent(id));

  const catalog = createQuery(
    () => ({
      queryKey: queryKeys.agents.catalog(),
      queryFn: ({ signal }) => getAgentCatalog({ signal }),
      retry: false,
    }),
    undefined,
  );

  const installedGuardrails = createQuery(
    () => ({
      queryKey: queryKeys.guardrails.list(),
      queryFn: ({ signal }) => listGuardrails({ signal }),
      retry: false,
    }),
    undefined,
  );

  // The tab draws the connection banner itself, under the agent's header (row 40b), and while the
  // server does not answer the page holds Edit back as it does for a tab showing old data (row 40c).
  $effect(() => connection.claimBanner());
  const markStale = useAgentTabStale();
  $effect(() => {
    if (!connection.unreachable) return;
    return markStale();
  });

  /** Why a write failed that the row's own line does not say: a refusal with the Bureau's words. */
  let problem = $state<string | null>(null);
  /** The version the last save made, once known; `undefined` until something here saved. */
  let savedRevision = $state<number | null | undefined>(undefined);

  function refuse(fault: AgentFault): void {
    switch (fault.kind) {
      case 'stale':
        // The row went back; the file is read again, and the table rebuilt once no write waits.
        void queryClient.invalidateQueries({ queryKey: queryKeys.agents.definition(id) });
        return;
      case 'forbidden':
        problem = copy.forbidden;
        return;
      case 'rejected':
        problem = fault.message;
        return;
      case 'not-found':
      case 'identifier-taken':
      case 'other':
        return;
    }
  }

  /** Says which version a save made: beside the count, and in a toast with View versions (row 39h). */
  async function announce(hash: string): Promise<void> {
    let revision: number | null = null;
    try {
      const versions = await queryClient.fetchQuery({
        queryKey: queryKeys.agents.versions(id),
        queryFn: ({ signal }) => listAgentVersions(id, { signal }),
        staleTime: 0,
        retry: false,
      });
      revision =
        (versions.find((version) => version.hash === hash) ?? versions[0])?.revision ?? null;
    } catch {
      revision = null;
    }
    savedRevision = revision;
    if (!toasts) return;
    showToast(copy.saved(revision), {
      variant: 'success',
      action: {
        label: copy.viewVersions,
        onAction: () => router.navigate(agentTabPath(id, 'settings')),
      },
    });
  }

  /** One row's write: the whole definition over the hash the tab holds, and what follows it. */
  const write: AccessWriter = async (expectedHash, definition) => {
    problem = null;
    try {
      const result = await updateAgent(id, expectedHash, definition);
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.definition(id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.definitions() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.revisions(id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.list() });
      void announce(result.hash);
      return result;
    } catch (error) {
      refuse(agentFaultOf(error));
      throw error;
    }
  };

  let form = $state<AgentAccessState | undefined>();
  // The table is filled from the file, and filled again when the file's hash moves to one this
  // tab did not write, once no write of its own is waiting. A refetch that answers with a hash
  // the tab wrote, or the one it was filled from, keeps the table as it is.
  $effect(() => {
    const loaded = detail;
    const offered = catalog.data;
    // Read here, so a file read while a write waited is taken up once the last write answers.
    const waiting = form?.busy ?? false;
    if (loaded === undefined || offered === undefined || waiting) return;
    untrack(() => {
      if (form !== undefined) {
        if (form.hash === (loaded.hash ?? '')) return;
        if (loaded.hash !== null && form.wrote(loaded.hash)) return;
      }
      form = AgentAccessState.from(loaded, offered, plugin === null ? write : undefined);
    });
  });

  // The toolbar: the search, the source segment, and which groups are folded.
  let typed = $state('');
  let segment = $state('all');
  const collapsed = new SvelteSet<string>();

  function toggle(group: string): void {
    if (collapsed.has(group)) collapsed.delete(group);
    else collapsed.add(group);
  }

  const groups = $derived(form === undefined ? [] : groupAccessRows(form.rows));
  const segments = $derived<FilterSegment[]>([
    { value: 'all', label: copy.all, count: form?.totalCount ?? 'pending' },
    ...groups.map((group) => ({
      value: group.key,
      label: group.label ?? copy.notInCatalogGroup,
      count: group.rows.length,
    })),
  ]);
  /** The groups the segment and the search leave, each with the rows the search matches. */
  const shown = $derived(
    groups
      .filter((group) => segment === 'all' || group.key === segment)
      .map((group) => ({
        ...group,
        matching: group.rows.filter((row) => matchesAccessRow(row, typed)),
      }))
      .filter((group) => typed.trim() === '' || group.matching.length > 0),
  );

  // The installed guardrails an agent file can list, once each (one serves several families), and
  // those the file lists that none offers now. A `memory` guardrail guards the host's memory, and
  // no agent lists it.
  const guardrailChoices = $derived.by(() => {
    const offered = new Map<string, string>();
    for (const guardrail of installedGuardrails.data ?? []) {
      if (guardrail.family === 'memory') continue;
      if (!offered.has(guardrail.id)) offered.set(guardrail.id, guardrail.description);
    }
    const listed = (form?.guardrails ?? []).filter((guardrail) => !offered.has(guardrail));
    return [
      ...[...offered].map(([guardrail, description]) => ({ id: guardrail, description })),
      ...listed.map((guardrail) => ({ id: guardrail, description: copy.guardrailMissing })),
    ];
  });

  /** A guardrail's name for a person: the part of its id after the plugin, read as words. */
  function guardrailName(guardrail: string): string {
    return humanizeName(guardrail.slice(guardrail.indexOf(':') + 1));
  }

  function turn(state: AgentAccessState, guardrail: string, on: boolean): void {
    void state.change({
      key: `guardrail:${guardrail}`,
      subject: guardrailName(guardrail),
      restored: on ? copy.restoredOff : copy.restoredOn,
      apply: () => state.setGuardrail(guardrail, on),
      undo: () => state.setGuardrail(guardrail, !on),
    });
  }

  /** Saves a typed spend limit when the field is left, unless it is one the Bureau would refuse. */
  function commitSpend(state: AgentAccessState): void {
    const next = state.spendPerChat;
    const before = state.spendApplied;
    if (state.spendLimit === undefined || next.trim() === before.trim()) return;
    void state.change({
      key: 'spend',
      subject: copy.spendSubject,
      restored: before.trim() === '' ? copy.noLimit : `${before.trim()} ${copy.spendUnit}`,
      apply: () => {
        state.spendPerChat = next;
        state.spendApplied = next;
      },
      undo: () => {
        state.spendPerChat = before;
        state.spendApplied = before;
      },
    });
  }

  const spendError = $derived(
    form?.spendLimit === undefined && form !== undefined
      ? AGENT_EDITOR_COPY.limits.errors.spend(LIMIT_BOUNDS.spendUsd)
      : '',
  );
</script>

<!-- A row's own state beside its control: a spinner while its write is in flight. -->
{#snippet saving(key: string)}
  {#if form?.saves.get(key)?.kind === 'saving'}
    <span class="ib-access-row__saving" data-testid="agent-access-saving">
      <Spinner size="sm" label={copy.saving} />
      <span aria-hidden="true">{copy.saving}</span>
    </span>
  {/if}
{/snippet}

<!-- The line under a control whose save failed, with Try again (row 39k). -->
{#snippet failure(key: string)}
  {@const save = form?.saves.get(key)}
  {#if save?.kind === 'failed'}
    <p class="ib-access-failure" role="alert" data-failed={key}>
      {copy.failed(save.subject, save.restored)}
      <button type="button" class="ib-access-failure__retry" data-changes onclick={save.retry}
        >{copy.retry}</button
      >
    </p>
  {/if}
{/snippet}

{#snippet table(state: AgentAccessState)}
  <div class="ib-access-toolbar">
    <FilterBar
      aria-label={copy.toolbarLabel}
      {segments}
      segmentValue={segment}
      segmentsLabel={copy.sourceLabel}
      searchQuery={typed}
      searchPlaceholder={copy.searchPlaceholder}
      searchAriaLabel={copy.searchLabel}
      onSegmentChange={(value) => (segment = value)}
      onSearchChange={(query) => (typed = query)}
    />
    <p class="ib-access-toolbar__count" data-testid="agent-access-count" aria-live="polite">
      {#if savedRevision !== undefined && !state.busy}
        <span class="ib-access-toolbar__saved" data-testid="agent-access-saved">
          <Check aria-hidden="true" size={14} />
          {copy.saved(savedRevision)}
        </span>
      {/if}
      <span>{copy.toolCount(state.allowedCount, state.totalCount)}</span>
    </p>
  </div>

  {#if state.rows.length === 0}
    <EmptyState
      kind="first-use"
      size="compact"
      headingLevel={3}
      title={copy.noToolsTitle}
      description={copy.noToolsDescription}
    />
  {:else if shown.length === 0}
    <EmptyState
      kind="filtered"
      size="compact"
      headingLevel={3}
      title={copy.noMatchTitle}
      description={copy.noMatchDescription}
      onClearFilters={() => {
        typed = '';
        segment = 'all';
      }}
      clearFiltersLabel={copy.clearSearch}
    />
  {/if}

  <Table
    caption={copy.tableCaption}
    density="condensed"
    class="ib-access-table"
    data-testid="agent-access-table"
  >
    <Table.Header>
      <Table.Row>
        <Table.HeaderCell><VisuallyHidden>{copy.columns.allow}</VisuallyHidden></Table.HeaderCell>
        <Table.HeaderCell>{copy.columns.tool}</Table.HeaderCell>
        <Table.HeaderCell>{copy.columns.does}</Table.HeaderCell>
        <Table.HeaderCell>{copy.columns.risk}</Table.HeaderCell>
        <Table.HeaderCell>{copy.columns.asks}</Table.HeaderCell>
      </Table.Row>
    </Table.Header>
    {#each shown as group (group.key)}
      <Table.Body data-group-body={group.key}>
        <AgentAccessGroupRow
          group={group.key}
          label={group.label ?? copy.notInCatalogGroup}
          count={copy.groupCount(state.allowedAmong(group.rows), group.rows.length)}
          collapsed={collapsed.has(group.key)}
          onToggle={() => toggle(group.key)}
        />
        {#if !collapsed.has(group.key)}
          {#each group.matching as tool (tool.name)}
            <AgentAccessToolRow form={state} {tool} />
          {/each}
        {/if}
      </Table.Body>
    {/each}
    {#if segment === 'all'}
      <AgentAccessSkills
        form={state}
        {typed}
        collapsed={collapsed.has('skills')}
        onToggle={() => toggle('skills')}
      />
    {/if}
  </Table>

  <section
    class="ib-agent-section ib-access-guardrails"
    aria-label={copy.guardrailsHeading}
    data-testid="agent-access-guardrails"
  >
    <SectionHeading level={2} title={copy.guardrailsHeading} />
    <fieldset class="ib-access-guardrails__set">
      <legend class="ib-access-guardrails__legend">{copy.guardrailsLabel}</legend>
      {#if installedGuardrails.isError}
        <Alert variant="danger">
          <p>{copy.guardrailsLoadFailed}</p>
          <Button variant="secondary" size="sm" onclick={() => void installedGuardrails.refetch()}
            >{RETRY_LABEL}</Button
          >
        </Alert>
      {:else if installedGuardrails.isPending}
        <Skeleton height="3rem" />
      {:else if guardrailChoices.length === 0}
        <p class="ib-agent-note">{copy.noGuardrails}</p>
      {:else}
        {#each guardrailChoices as choice (choice.id)}
          {@const on = state.hasGuardrail(choice.id)}
          <div class="ib-access-guardrail" data-guardrail={choice.id}>
            <div class="ib-access-guardrail__control">
              <Checkbox
                id={`access-guardrail-${choice.id}`}
                label={guardrailName(choice.id)}
                description={choice.description}
                checked={on}
                disabled={!state.editable || (!on && choice.description === copy.guardrailMissing)}
                mutating
                data-changes
                onValueChange={(next) => turn(state, choice.id, next)}
              />
              {@render saving(`guardrail:${choice.id}`)}
            </div>
            {@render failure(`guardrail:${choice.id}`)}
          </div>
        {/each}
      {/if}
      <p class="ib-agent-note">{copy.guardrailsNote}</p>
    </fieldset>

    <div class="ib-access-spend" data-testid="agent-access-spend">
      <Input
        id="access-spend-per-chat"
        label={copy.spendLabel}
        description={copy.spendNote}
        placeholder={copy.spendPlaceholder}
        inputmode="decimal"
        error={spendError}
        disabled={!state.editable}
        readonly={connection.unreachable}
        aria-disabled={connection.unreachable ? 'true' : undefined}
        title={connection.unreachable ? CONNECTION_COPY.changesOff : undefined}
        data-changes
        bind:value={state.spendPerChat}
        onchange={() => commitSpend(state)}
      >
        {#snippet trailing()}{copy.spendUnit}{/snippet}
      </Input>
      {@render saving('spend')}
      {@render failure('spend')}
    </div>
  </section>
{/snippet}

<div class="ib-agent-access" data-testid="agent-access">
  {#if connection.unreachable && !restartActivity.active}
    <Banner
      preset={connectionBannerPreset(connection)}
      subject={copy.offlineSubject}
      dataUpdatedAt={connection.lastHealthyAt}
      retryInSeconds={connection.retryInSeconds}
      attempt={connection.browserOffline || connection.attempt === 0
        ? undefined
        : connection.attempt}
      maxAttempts={CONNECTION_MAX_ATTEMPTS}
      onRetry={() => void connection.retryNow()}
    />
  {/if}
  {#if catalog.isError}
    <Alert variant="danger">
      <p>{copy.loadFailed}</p>
      <Button variant="secondary" size="sm" onclick={() => void catalog.refetch()}
        >{RETRY_LABEL}</Button
      >
    </Alert>
  {:else if detail !== undefined && detail.source === 'file' && detail.definition === null}
    <Alert variant="warning">
      <p>{copy.invalid}</p>
    </Alert>
  {:else if form === undefined}
    <div role="status" aria-busy="true" aria-label={copy.heading}>
      <Skeleton height="8rem" />
    </div>
  {:else}
    {#if plugin !== null}
      <AgentPluginNote {plugin} />
    {:else if !form.editable}
      <p class="ib-agent-note" data-testid="agent-built-in">{copy.builtIn}</p>
    {/if}
    {#if problem !== null}
      <Alert variant="danger" dismissible onDismiss={() => (problem = null)}>
        <p>{problem}</p>
      </Alert>
    {/if}
    <StaleRegion stale={connection.unreachable} reason={CONNECTION_COPY.changesOff}>
      {@render table(form)}
    </StaleRegion>
  {/if}
</div>
