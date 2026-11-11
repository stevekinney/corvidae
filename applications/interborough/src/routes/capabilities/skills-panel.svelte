<script lang="ts">
  /**
   * The Skills tab: every executable skill the host discovered (`bureau.skills.list`) as a list with
   * the open skill beside it. A skill from a source the host does not trust is listed and marked,
   * because agents are refused it. Which agents use a skill is read from the agents defined in code,
   * and the tools a skill brings are read from the tool catalog, where they are listed with the
   * skill as their source.
   */
  import {
    Alert,
    Badge,
    Button,
    EmptyState,
    ListDetail,
    SearchField,
    SelectableRow,
  } from '@lostgradient/cinder';
  import { Plus, Puzzle } from '@lucide/svelte';
  import { createQuery } from '@tanstack/svelte-query';

  import { CAPABILITIES_COPY, RETRY_LABEL } from '../../app/copy.ts';
  import { getAgentCatalog } from '../../lib/agent-definitions.ts';
  import { listSkillCatalog } from '../../lib/bureau-skills.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { listSkillUsers } from '../../lib/skill-users.ts';
  import {
    isUntrusted,
    matchesSkillFilter,
    skillHeading,
    skillKey,
    trustLabel,
  } from './capability-presentation.ts';
  import { routerSelectionLocationFor } from '../../lib/router-selection-location.ts';
  import CapabilitiesLoading from './capabilities-loading.svelte';
  import SkillDetail from './skill-detail.svelte';

  const copy = CAPABILITIES_COPY;
  const selectionLocation = routerSelectionLocationFor('/capabilities');

  const skills = createQuery(
    () => ({
      queryKey: queryKeys.skills.list(),
      queryFn: ({ signal }) => listSkillCatalog({ signal }),
      // A failure is shown with Try again, not retried behind the person's back.
      retry: false,
    }),
    undefined,
  );
  const users = createQuery(
    () => ({
      queryKey: queryKeys.skills.users(),
      queryFn: ({ signal }) => listSkillUsers({ signal }),
      retry: false,
    }),
    undefined,
  );

  // The tools a skill brings are told apart from the rest by the catalog, which knows their risk and asks level.
  const catalog = createQuery(
    () => ({
      queryKey: queryKeys.agents.catalog(),
      queryFn: ({ signal }) => getAgentCatalog({ signal }),
      retry: false,
    }),
    undefined,
  );

  let filter = $state('');
  const all = $derived(skills.data?.skills ?? []);
  const hasSources = $derived((skills.data?.sourceCount ?? 0) > 0);
  const shown = $derived(all.filter((skill) => matchesSkillFilter(skill, filter)));

  /** Goes to the plugins page, unless the person asked for a new tab or window. */
  function addPlugin(event: MouseEvent): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(copy.skill.empty.action.href);
  }
</script>

<div class="ib-capabilities__panel" data-testid="skills-panel">
  {#if skills.isPending}
    <CapabilitiesLoading label={copy.skill.loading} />
  {:else if skills.isError}
    <Alert variant="danger">
      <p class="ib-capabilities__alert-title">{copy.skill.loadFailed.title}</p>
      <p>{copy.skill.loadFailed.description}</p>
      <Button variant="secondary" size="sm" onclick={() => void skills.refetch()}
        >{RETRY_LABEL}</Button
      >
    </Alert>
  {:else if all.length === 0 && hasSources}
    <EmptyState
      kind="first-use"
      headingLevel={2}
      title={copy.skill.emptySources.title}
      description={copy.skill.emptySources.description}
    />
  {:else if all.length === 0}
    <!-- First use (row 31y): the one primary button on the tab adds the plugin that brings skills. -->
    <EmptyState
      kind="first-use"
      headingLevel={2}
      title={copy.skill.empty.title}
      description={copy.skill.empty.description}
      data-testid="skills-first-use"
    >
      {#snippet icon()}<Puzzle size={28} aria-hidden="true" />{/snippet}
      {#snippet action()}
        <Button
          variant="primary"
          href={router.href(copy.skill.empty.action.href)}
          onclick={addPlugin}
        >
          {#snippet leadingIcon()}<Plus size={16} aria-hidden="true" />{/snippet}
          {copy.skill.empty.action.label}
        </Button>
      {/snippet}
    </EmptyState>
  {:else}
    <div class="ib-capabilities__frame" data-shortcut-region="list-detail">
      <ListDetail
        items={shown}
        key={skillKey}
        label={copy.listLabel.skills}
        detailLabel={copy.detailLabel.skills}
        emptyTitle={copy.emptyDetailTitle}
        emptyDescription={copy.emptyDetailDescription}
        selectionParameter="skill"
        {selectionLocation}
        storageKey="interborough-capabilities-skills"
      >
        {#snippet header()}
          <!-- The list itself shows no count; one reads at the right of the field once something is typed. -->
          <div class="ib-capabilities__filter">
            <div class="ib-capabilities__filter-field">
              <SearchField
                aria-label={copy.filterLabel.skills}
                placeholder={copy.filterPlaceholder}
                bind:value={filter}
                onClear={() => (filter = '')}
              />
            </div>
            {#if filter.trim() !== ''}
              <p class="ib-capabilities__count" data-testid="skills-count">
                {copy.filteredCount.skills(shown.length, all.length)}
              </p>
            {/if}
          </div>
        {/snippet}
        {#snippet list(skill, row)}
          <SelectableRow
            selected={row.selected}
            selectedState="current"
            onclick={row.open}
            data-skill-row={skill.name}
            data-trust={skill.trust}
          >
            {#snippet title()}{skillHeading(skill)}{/snippet}
            {#snippet description()}{skill.description}{/snippet}
            {#snippet meta()}
              {#if isUntrusted(skill)}
                <Badge variant="warning" size="sm">{trustLabel(skill)}</Badge>
              {:else if !skill.available}
                <Badge variant="warning" size="sm">{copy.skill.unavailableBadge}</Badge>
              {/if}
            {/snippet}
          </SelectableRow>
        {/snippet}
        {#snippet listEmpty()}
          <EmptyState
            kind="filtered"
            size="compact"
            headingLevel={3}
            title={copy.skill.filtered.title}
            description={copy.skill.filtered.description}
            clearFiltersLabel={copy.skill.filtered.clear}
            onClearFilters={() => (filter = '')}
          />
        {/snippet}
        {#snippet detail(skill)}
          <SkillDetail
            {skill}
            users={users.data?.get(skill.name) ?? []}
            usersPending={users.isPending}
            usersFailed={users.isError}
            catalog={catalog.data?.tools ?? []}
          />
        {/snippet}
      </ListDetail>
    </div>
  {/if}
</div>
