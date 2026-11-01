<script lang="ts">
  /**
   * The skills the host found, each with whether the host trusts the source it came from and, when
   * an agent is refused it, why. With a `form`, for an agent file, each has a box that grants it,
   * saved with the rest of the tab. A skill an agent cannot activate has its box disabled and the
   * reason under it, and the Bureau refuses the grant too. A skill the file names that the host no
   * longer offers is marked and can only be withdrawn. Without a `form`, for an agent defined in
   * code, the list is read-only.
   */
  import {
    Alert,
    Badge,
    Button,
    Checkbox,
    EmptyState,
    SectionHeading,
    Skeleton,
  } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { AGENT_PAGE_COPY, RETRY_LABEL } from '../../app/copy.ts';
  import { listSkills } from '../../lib/bureau-skills.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { skillGrantLocked, type AgentAccessState } from './agent-access-state.svelte.ts';
  import {
    isUntrusted,
    skillKey,
    trustLabel,
    unavailableText,
  } from '../capabilities/capability-presentation.ts';

  interface Props {
    /** The tab's form, for an agent whose file can name skills. */
    form?: AgentAccessState | undefined;
  }

  let { form }: Props = $props();

  const copy = AGENT_PAGE_COPY.access;
  const skillsPath = '/capabilities?tab=skills';

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
    return (form?.allowedSkills ?? []).filter((name) => !listed.has(name));
  });

  function openSkills(event: MouseEvent): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(skillsPath);
  }
</script>

{#snippet browse()}
  <Button href={router.href(skillsPath)} variant="secondary" size="sm" onclick={openSkills}
    >{copy.noSkillsAction}</Button
  >
{/snippet}

<section class="ib-agent-section" aria-label={copy.skillsHeading} data-testid="agent-access-skills">
  <SectionHeading
    level={2}
    title={copy.skillsHeading}
    description={form === undefined ? copy.skillsReadOnlyDescription : copy.skillsDescription}
  />
  {#if skills.isError}
    <Alert variant="danger">
      <p>{copy.skillsLoadFailed}</p>
      <Button variant="secondary" size="sm" onclick={() => void skills.refetch()}
        >{RETRY_LABEL}</Button
      >
    </Alert>
  {:else if skills.isPending}
    <div role="status" aria-busy="true" aria-label={copy.skillsHeading}>
      <Skeleton height="4rem" />
    </div>
  {:else if skills.data.length === 0 && unlisted.length === 0}
    <EmptyState
      kind="first-use"
      size="compact"
      headingLevel={3}
      title={copy.noSkillsTitle}
      description={copy.noSkillsDescription}
      action={browse}
    />
  {:else}
    <ul class="ib-access-list" aria-label={copy.skillsListLabel}>
      {#each skills.data as skill (skillKey(skill))}
        <li class="ib-access-skill" data-skill={skill.name} data-trust={skill.trust}>
          {#if form === undefined}
            <span class="ib-access-skill__name">{skill.name}</span>
          {:else}
            {@const granted = form.isGranted(skill.name)}
            <div class="ib-access-skill__name">
              <Checkbox
                id={`access-skill-${skillKey(skill)}`}
                label={skill.name}
                checked={granted}
                disabled={skillGrantLocked(skill, skills.data, granted)}
                onValueChange={(next) => form?.setGranted(skill.name, next)}
              />
            </div>
          {/if}
          <Badge variant={isUntrusted(skill) ? 'warning' : 'success'} size="sm"
            >{trustLabel(skill)}</Badge
          >
          {#if unavailableText(skill) !== undefined}
            <p class="ib-access-skill__reason">{unavailableText(skill)}</p>
          {/if}
        </li>
      {/each}
      {#each unlisted as name (name)}
        <li class="ib-access-skill" data-skill={name}>
          <div class="ib-access-skill__name">
            <Checkbox
              id={`access-skill-unlisted-${name}`}
              label={name}
              checked
              onValueChange={(next) => form?.setGranted(name, next)}
            />
          </div>
          <Badge variant="warning" size="sm">{copy.notInCatalog}</Badge>
        </li>
      {/each}
    </ul>
  {/if}
</section>
