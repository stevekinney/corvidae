<script lang="ts">
  /**
   * One skill (board PageCapabilities, frame "Skills tab, detail"): its name for a person with its
   * identifier small and monospaced beside it, the sentence about it, one muted line of what it
   * holds, where it is from and when it loads, the tools it brings (a skill of instructions only
   * has none), whether the host trusts its source (an untrusted skill is marked, and says why
   * agents are refused it), where it came from, the tools it asks to keep, and the agents that use
   * it.
   */
  import { Alert, Badge, SectionHeading, Table } from '@lostgradient/cinder';

  import { CAPABILITIES_COPY } from '../../app/copy.ts';
  import type { Skill } from '../../lib/bureau-skills.ts';
  import { router } from '../../lib/router.svelte.ts';
  import AgentUsers from './agent-users.svelte';
  import {
    asksWord,
    isUntrusted,
    riskLabel,
    skillHeading,
    skillMeta,
    skillSourceLabel,
    tierOf,
    toolHeading,
    trustLabel,
    unavailableText,
    type CatalogTool,
  } from './capability-presentation.ts';

  interface Props {
    skill: Skill;
    /** The agents that use the skill. */
    users: readonly string[];
    /** Whether the agents that use skills could not be read, so `users` may be incomplete. */
    usersFailed: boolean;
    /** Whether the agents that use skills are still being read. */
    usersPending: boolean;
    /** The tool catalog, which says what each tool a skill brings may do and when it asks. */
    catalog: readonly CatalogTool[];
  }

  let { skill, users, usersFailed, usersPending, catalog }: Props = $props();

  const copy = CAPABILITIES_COPY.skill;
  const heading = $derived(skillHeading(skill));
  const untrusted = $derived(isUntrusted(skill));
  /** Each tool the skill brings with its catalog entry, which is missing only while the catalog is. */
  const brought = $derived(
    skill.tools.map((name) => {
      const tool = catalog.find((entry) => entry.name === name);
      return {
        name,
        heading: tool === undefined ? name : toolHeading(tool),
        risk: tool === undefined ? '' : riskLabel(tierOf(tool)),
        asks: tool === undefined ? '' : asksWord(tool),
      };
    }),
  );

  const toolPath = (name: string): string => `/capabilities?tool=${encodeURIComponent(name)}`;

  /** Opens the tool on the Tools tab, unless the person asked for a new tab or window. */
  function openTool(event: MouseEvent, name: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(toolPath(name));
  }
  const unavailable = $derived(unavailableText(skill));
  // Users match by name, so a shadowed row would inherit the winning skill's agents.
  const shadowed = $derived(skill.unavailableReason === 'shadowed');
</script>

<article
  class="ib-capability"
  data-testid="skill-detail"
  data-skill={skill.name}
  data-trust={skill.trust}
>
  <header class="ib-capability__header">
    <h3 class="ib-capability__name">{heading}</h3>
    <code class="ib-capability__code ib-capability__identifier" data-testid="skill-identifier"
      >{skill.name}</code
    >
  </header>

  {#if unavailable !== undefined}
    <Alert variant="warning" data-testid="skill-unavailable">{unavailable}</Alert>
  {/if}

  <p class="ib-capability__prose" data-testid="skill-summary">{skill.description}</p>

  <!-- What it holds, where it is from, when it loads: muted, and told apart by a rule, not a mark. -->
  <ul class="ib-capability__meta" aria-label={copy.meta.label} data-testid="skill-meta">
    {#each skillMeta(skill) as part (part)}
      <li>{part}</li>
    {/each}
  </ul>

  {#if brought.length > 0}
    <section class="ib-capability__section" data-testid="skill-brings">
      <SectionHeading level={4} title={copy.brings.heading} />
      <Table caption={copy.brings.caption(heading)} density="comfortable">
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>{copy.brings.columns.tool}</Table.HeaderCell>
            <Table.HeaderCell>{copy.brings.columns.risk}</Table.HeaderCell>
            <Table.HeaderCell>{copy.brings.columns.asks}</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each brought as entry (entry.name)}
            <Table.Row data-brought-tool={entry.name}>
              <Table.Cell>
                <span class="ib-capability__header">
                  <a
                    href={router.href(toolPath(entry.name))}
                    onclick={(event) => openTool(event, entry.name)}>{entry.heading}</a
                  >
                  <code class="ib-capability__code ib-capability__identifier">{entry.name}</code>
                </span>
              </Table.Cell>
              <Table.Cell>{entry.risk}</Table.Cell>
              <Table.Cell>{entry.asks}</Table.Cell>
            </Table.Row>
          {/each}
        </Table.Body>
      </Table>
    </section>
  {/if}

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

  {#if shadowed || usersPending}
    <!-- Nothing: a shadowed skill has no users of its own, and pending users are not yet known. -->
  {:else if usersFailed}
    <Alert variant="warning">{copy.usersFailed}</Alert>
  {:else}
    <AgentUsers heading={copy.users} {users} empty={copy.noUsers} />
  {/if}
</article>
