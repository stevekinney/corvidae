<script lang="ts">
  /**
   * One skill: what it does, whether the host trusts its source (an untrusted skill is marked, and
   * says why agents are refused it), where it came from, the tools it asks to keep, and the agents
   * that use it.
   */
  import { Alert, Badge, SectionHeading } from '@lostgradient/cinder';

  import { CAPABILITIES_COPY } from '../../app/copy.ts';
  import type { Skill } from '../../lib/bureau-skills.ts';
  import AgentUsers from './agent-users.svelte';
  import {
    isUntrusted,
    skillSourceLabel,
    trustLabel,
    unavailableText,
  } from './capability-presentation.ts';

  interface Props {
    skill: Skill;
    /** The agents that use the skill. */
    users: readonly string[];
    /** Whether the agents that use skills could not be read, so `users` may be incomplete. */
    usersFailed: boolean;
  }

  let { skill, users, usersFailed }: Props = $props();

  const copy = CAPABILITIES_COPY.skill;
  const untrusted = $derived(isUntrusted(skill));
  const unavailable = $derived(unavailableText(skill));
</script>

<article
  class="ib-capability"
  data-testid="skill-detail"
  data-skill={skill.name}
  data-trust={skill.trust}
>
  <h3 class="ib-capability__name ib-capability__identifier">{skill.name}</h3>

  {#if unavailable !== undefined}
    <Alert variant="warning" data-testid="skill-unavailable">{unavailable}</Alert>
  {/if}

  <section class="ib-capability__section">
    <SectionHeading level={4} title={copy.whatItDoes} />
    <p class="ib-capability__prose">{skill.description}</p>
  </section>

  <dl class="ib-capability__facts">
    <div>
      <dt>{copy.trust}</dt>
      <dd data-testid="skill-trust">
        <Badge variant={untrusted ? 'warning' : 'success'} size="sm">{trustLabel(skill)}</Badge>
        <span>{skill.trustReason}</span>
      </dd>
    </div>
    <div>
      <dt>{copy.source}</dt>
      <dd data-testid="skill-source">
        <span>{skillSourceLabel(skill)}</span>
        {#if skill.source.plugin !== null}
          <span class="ib-capability__identifier">{skill.source.plugin}</span>
        {/if}
        <code class="ib-capability__location">{skill.source.location}</code>
      </dd>
    </div>
    {#if skill.allowedTools.length > 0}
      <div>
        <dt>{copy.allowedTools}</dt>
        <dd>
          <ul class="ib-capability__chips" data-testid="skill-allowed-tools">
            {#each skill.allowedTools as tool (tool)}
              <li class="ib-capability__identifier">{tool}</li>
            {/each}
          </ul>
        </dd>
      </div>
    {/if}
  </dl>

  {#if usersFailed}
    <Alert variant="warning">{copy.usersFailed}</Alert>
  {:else}
    <AgentUsers heading={copy.users} {users} empty={copy.noUsers} />
  {/if}
</article>
