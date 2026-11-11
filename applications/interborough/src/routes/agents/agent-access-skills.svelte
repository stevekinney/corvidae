<script lang="ts">
  /**
   * The Skills group of the Access tab's table (row 38q, sweep S65): a collapsible group headed
   * with how many skills there are and that they follow the tools they use. First the skills the
   * agent's file defines itself, granted and marked "Defined in this file"; then the skills the
   * host found, each with a box that grants it; then any the file names that the host no longer
   * lists, which can only be withdrawn. Each row shows an em dash for risk and "Follows its tools"
   * for Asks, and skills are not counted with the tools.
   *
   * A grant saves at once, as a tool's change does. A skill an agent cannot activate (an untrusted
   * source, say) has its box disabled and the reason in its row, and the Bureau refuses the grant
   * too. On an agent the page cannot write every box is disabled.
   */
  import { Checkbox, Spinner, Table } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { AGENT_PAGE_COPY, RETRY_LABEL } from '../../app/copy.ts';
  import { listSkills, type Skill } from '../../lib/bureau-skills.ts';
  import { queryKeys } from '../../lib/query.ts';
  import AgentAccessGroupRow from './agent-access-group-row.svelte';
  import { skillGrantLocked, type AgentAccessState } from './agent-access-state.svelte.ts';
  import {
    matchesFilter,
    matchesSkillFilter,
    skillHeading,
    skillKey,
    unavailableText,
  } from '../capabilities/capability-presentation.ts';

  interface Props {
    /** The tab's state, which holds the grants and saves them. */
    form: AgentAccessState;
    /** What was typed in the toolbar's search. */
    typed: string;
    /** Whether the group's rows are hidden. */
    collapsed: boolean;
    /** Shows or hides the group's rows. */
    onToggle: () => void;
  }

  let { form, typed, collapsed, onToggle }: Props = $props();

  const copy = AGENT_PAGE_COPY.access;

  const skills = createQuery(
    () => ({
      queryKey: queryKeys.skills.list(),
      queryFn: ({ signal }) => listSkills({ signal }),
      retry: false,
    }),
    undefined,
  );

  /** The skills the file names that the host did not list. */
  const unlisted = $derived.by(() => {
    const listed = new Set((skills.data ?? []).map((skill) => skill.name));
    return form.skills.filter((name) => !listed.has(name));
  });
  const own = $derived(
    form.ownSkills.filter(
      (skill) => matchesFilter(skill.name, typed) || matchesFilter(skill.id, typed),
    ),
  );
  const found = $derived((skills.data ?? []).filter((skill) => matchesSkillFilter(skill, typed)));
  const missing = $derived(unlisted.filter((name) => matchesFilter(name, typed)));
  const count = $derived(form.ownSkills.length + (skills.data?.length ?? 0) + unlisted.length);

  function grant(name: string, next: boolean): void {
    void form.change({
      key: `skill:${name}`,
      subject: skillHeading({ name }),
      restored: next ? copy.restoredNotAllowed : copy.restoredAllowed,
      apply: () => form.setGranted(name, next),
      undo: () => form.setGranted(name, !next),
    });
  }

  function locked(skill: Skill): boolean {
    return !form.editable || skillGrantLocked(skill, skills.data ?? [], form.isGranted(skill.name));
  }
</script>

<!-- The cells a skill shares with the others: an em dash for risk and "Follows its tools" for Asks. -->
{#snippet trailing(name: string)}
  <Table.Cell>
    <span class="ib-access-row__risk">{copy.skillRisk}</span>
  </Table.Cell>
  <Table.Cell>
    <span class="ib-access-row__follows">{copy.skillAsks}</span>
    {#if form.saves.get(`skill:${name}`)?.kind === 'saving'}
      <span class="ib-access-row__saving" data-testid="agent-access-saving">
        <Spinner size="sm" label={copy.saving} />
        <span aria-hidden="true">{copy.saving}</span>
      </span>
    {/if}
  </Table.Cell>
{/snippet}

<!-- The full-width line under a skill whose grant could not be saved. -->
{#snippet failure(name: string)}
  {@const save = form.saves.get(`skill:${name}`)}
  {#if save?.kind === 'failed'}
    <Table.Row class="ib-access-row__failure" data-failed={name}>
      <Table.Cell colspan={5}>
        <p class="ib-access-failure" role="alert">
          {copy.failed(save.subject, save.restored)}
          <button type="button" class="ib-access-failure__retry" data-changes onclick={save.retry}
            >{copy.retry}</button
          >
        </p>
      </Table.Cell>
    </Table.Row>
  {/if}
{/snippet}

<Table.Body data-testid="agent-access-skills">
  <AgentAccessGroupRow
    group="skills"
    label={copy.skillsTitle(count)}
    count={copy.skillsNote}
    {collapsed}
    {onToggle}
  />
  {#if !collapsed}
    {#if skills.isError}
      <Table.Row>
        <Table.Cell colspan={5}>
          <p class="ib-access-failure" role="alert">
            {copy.skillsLoadFailed}
            <button
              type="button"
              class="ib-access-failure__retry"
              onclick={() => void skills.refetch()}>{RETRY_LABEL}</button
            >
          </p>
        </Table.Cell>
      </Table.Row>
    {/if}
    {#each own as skill (skill.id)}
      <Table.Row data-skill={skill.id} data-own-skill="">
        <Table.Cell controls="fit">
          <Checkbox
            id={`access-own-skill-${skill.id}`}
            aria-label={copy.grantLabel(skill.name)}
            checked
            disabled
          />
        </Table.Cell>
        <Table.Cell as="th">
          <span class="ib-access-row__identity">
            <span class="ib-access-row__name">{skill.name}</span>
            <code class="ib-access-row__identifier">{skill.id}</code>
            <span class="ib-access-row__kind">{copy.definedInFile}</span>
          </span>
        </Table.Cell>
        <Table.Cell>
          {#snippet detail()}
            <span class="ib-access-row__does">{skill.description}</span>
          {/snippet}
        </Table.Cell>
        <Table.Cell>
          <span class="ib-access-row__risk">{copy.skillRisk}</span>
        </Table.Cell>
        <Table.Cell>
          <span class="ib-access-row__follows">{copy.skillAsks}</span>
        </Table.Cell>
      </Table.Row>
    {/each}
    {#each found as skill (skillKey(skill))}
      {@const reason = unavailableText(skill)}
      <Table.Row data-skill={skill.name} data-trust={skill.trust}>
        <Table.Cell controls="fit">
          <Checkbox
            id={`access-skill-${skillKey(skill)}`}
            aria-label={copy.grantLabel(skillHeading(skill))}
            checked={form.isGranted(skill.name)}
            disabled={locked(skill)}
            mutating
            data-changes
            onValueChange={(next) => grant(skill.name, next)}
          />
        </Table.Cell>
        <Table.Cell as="th">
          <span class="ib-access-row__identity">
            <span class="ib-access-row__name">{skillHeading(skill)}</span>
            <code class="ib-access-row__identifier">{skill.name}</code>
            <span class="ib-access-row__kind">{copy.skillWord}</span>
          </span>
          {#if reason !== undefined}
            <span class="ib-access-row__reason">{reason}</span>
          {/if}
        </Table.Cell>
        <Table.Cell>
          {#snippet detail()}
            <span class="ib-access-row__does">{skill.description}</span>
          {/snippet}
        </Table.Cell>
        {@render trailing(skill.name)}
      </Table.Row>
      {@render failure(skill.name)}
    {/each}
    {#each missing as name (name)}
      <Table.Row data-skill={name}>
        <Table.Cell controls="fit">
          <Checkbox
            id={`access-skill-unlisted-${name}`}
            aria-label={copy.grantLabel(name)}
            checked={form.isGranted(name)}
            disabled={!form.editable || !form.isGranted(name)}
            mutating
            data-changes
            onValueChange={(next) => grant(name, next)}
          />
        </Table.Cell>
        <Table.Cell as="th">
          <span class="ib-access-row__identity">
            <code class="ib-access-row__identifier">{name}</code>
            <span class="ib-access-row__kind">{copy.notInCatalog}</span>
          </span>
        </Table.Cell>
        <Table.Cell></Table.Cell>
        {@render trailing(name)}
      </Table.Row>
      {@render failure(name)}
    {/each}
  {/if}
</Table.Body>
