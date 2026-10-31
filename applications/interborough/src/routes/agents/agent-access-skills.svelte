<script lang="ts">
  /**
   * The skills the host found, read-only: each with whether the host trusts the source it came
   * from and, when an agent is refused it, why. There is no control to grant one: a skill from a
   * source the host does not trust is refused wherever an agent would use it, and a per-agent grant
   * is not something the Bureau stores yet.
   */
  import { Alert, Badge, Button, EmptyState, SectionHeading, Skeleton } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { AGENT_PAGE_COPY, RETRY_LABEL } from '../../app/copy.ts';
  import { listSkills } from '../../lib/bureau-skills.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import {
    isUntrusted,
    skillKey,
    trustLabel,
    unavailableText,
  } from '../capabilities/capability-presentation.ts';

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
  <SectionHeading level={2} title={copy.skillsHeading} description={copy.skillsDescription} />
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
  {:else if skills.data.length === 0}
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
          <span class="ib-access-skill__name">{skill.name}</span>
          <Badge variant={isUntrusted(skill) ? 'warning' : 'success'} size="sm"
            >{trustLabel(skill)}</Badge
          >
          {#if unavailableText(skill) !== undefined}
            <p class="ib-access-skill__reason">{unavailableText(skill)}</p>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>
