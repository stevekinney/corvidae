<script lang="ts">
  /**
   * The Skills tab: every executable skill the host discovered (`bureau.skills.list`) as a list with
   * the open skill beside it. A skill from a source the host does not trust is listed and marked,
   * because agents are refused it. Which agents use a skill is read from the agents defined in code.
   */
  import {
    Alert,
    Badge,
    Button,
    EmptyState,
    ListDetail,
    SearchField,
    SelectableRow,
    Skeleton,
  } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { CAPABILITIES_COPY, RETRY_LABEL } from '../../app/copy.ts';
  import { listSkillCatalog } from '../../lib/bureau-skills.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { listSkillUsers } from '../../lib/skill-users.ts';
  import { isUntrusted, matchesFilter, skillKey, trustLabel } from './capability-presentation.ts';
  import { routerSelectionLocation } from './selection-location.ts';
  import SkillDetail from './skill-detail.svelte';

  const copy = CAPABILITIES_COPY;

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

  let filter = $state('');
  const all = $derived(skills.data?.skills ?? []);
  const hasSources = $derived((skills.data?.sourceCount ?? 0) > 0);
  const shown = $derived(all.filter((skill) => matchesFilter(skill.name, filter)));
</script>

<div class="ib-capabilities__panel" data-testid="skills-panel">
  {#if skills.isPending}
    <div role="status" aria-busy="true" aria-label={copy.skill.loading}>
      <Skeleton height="1.5rem" width="40%" />
      <Skeleton height="12rem" />
    </div>
  {:else if skills.isError}
    <Alert variant="danger">
      <p class="ib-capabilities__alert-title">{copy.skill.loadFailed.title}</p>
      <p>{copy.skill.loadFailed.description}</p>
      <Button variant="secondary" size="sm" onclick={() => void skills.refetch()}
        >{RETRY_LABEL}</Button
      >
    </Alert>
  {:else if all.length === 0}
    <EmptyState
      kind="first-use"
      headingLevel={2}
      title={hasSources ? copy.skill.emptySources.title : copy.skill.empty.title}
      description={hasSources ? copy.skill.emptySources.description : copy.skill.empty.description}
    />
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
        selectionLocation={routerSelectionLocation}
        storageKey="interborough-capabilities-skills"
      >
        {#snippet header()}
          <p class="ib-capabilities__count" data-testid="skills-count">
            {copy.count(shown.length, all.length)}
          </p>
          <SearchField
            aria-label={copy.filterLabel.skills}
            placeholder={copy.filterPlaceholder}
            bind:value={filter}
            onClear={() => (filter = '')}
          />
        {/snippet}
        {#snippet list(skill, row)}
          <SelectableRow
            selected={row.selected}
            selectedState="current"
            onclick={row.open}
            data-skill-row={skill.name}
            data-trust={skill.trust}
          >
            {#snippet title()}<span class="ib-capability__identifier">{skill.name}</span>{/snippet}
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
          />
        {/snippet}
      </ListDetail>
    </div>
  {/if}
</div>
