<script lang="ts">
  /**
   * What an agent is made of, on one line: its model (none when the Bureau cannot tell, as for an
   * agent defined in code whose generator it cannot look inside), then its tools, then its skills. The list shows the tool count; an agent's page names
   * each tool and skill.
   *
   * The Bureau tells an agent file's model and skills (`bureau.agents.definitions.get`), a
   * code-defined agent's model (`bureau.agents.models`, asked only when the agent names a model at
   * all), and every agent's tools in `bureau.agents.list`. An agent whose listing carries no tools
   * shows none, never "no tools". Both queries share their keys with the agent's page, so a row and
   * the page it opens read one cache.
   */
  import { Badge } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { AGENTS_COPY } from '../../app/copy.ts';
  import { getAgentDefinition } from '../../lib/agent-definitions.ts';
  import { getAgentModels, type AgentSummary } from '../../lib/bureau-client.ts';
  import { keyedByOccurrence } from '../../lib/list-keys.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { agentFacts, toolCountText } from './agent-presentation.ts';

  interface AgentFactsProps {
    agent: AgentSummary;
    /** Name every tool and skill instead of counting the tools. */
    detailed?: boolean;
  }

  let { agent, detailed = false }: AgentFactsProps = $props();

  const definition = createQuery(
    () => ({
      queryKey: queryKeys.agents.definition(agent.name),
      queryFn: ({ signal }) => getAgentDefinition(agent.name, { signal }),
      enabled: agent.kind === 'file',
      retry: false,
    }),
    undefined,
  );

  const models = createQuery(
    () => ({
      queryKey: queryKeys.agents.models(agent.name),
      queryFn: ({ signal }) => getAgentModels(agent.name, { signal }),
      enabled: agent.kind === 'code' && agent.media !== null,
      retry: false,
    }),
    undefined,
  );

  const facts = $derived(agentFacts(agent, definition.data?.definition, models.data));
  const toolCount = $derived(toolCountText(facts.tools));
</script>

<div class="ib-agent-facts" data-testid="agent-facts">
  {#if facts.model.kind === 'model'}
    <div class="ib-agent-fact">
      <span class="ib-agent-fact__label">{AGENTS_COPY.modelLabel}</span>
      <Badge class="ib-agent-fact__badge" variant="neutral" size="sm" monospace
        >{facts.model.name}</Badge
      >
    </div>
  {/if}
  {#if facts.tools !== null}
    {#if detailed && facts.tools.length > 0}
      <div class="ib-agent-fact">
        <span class="ib-agent-fact__label">{AGENTS_COPY.toolsLabel}</span>
        <ul class="ib-agent-chips" aria-label={AGENTS_COPY.toolsLabel}>
          {#each keyedByOccurrence(facts.tools, (tool) => tool) as { key, item: tool } (key)}
            <li>
              <Badge class="ib-agent-fact__badge" variant="neutral" size="sm" monospace
                >{tool}</Badge
              >
            </li>
          {/each}
        </ul>
      </div>
    {:else}
      <div class="ib-agent-fact">{toolCount}</div>
    {/if}
  {/if}
  {#if detailed && facts.skills.length > 0}
    <div class="ib-agent-fact">
      <span class="ib-agent-fact__label">{AGENTS_COPY.skillsLabel}</span>
      <ul class="ib-agent-chips" aria-label={AGENTS_COPY.skillsLabel}>
        {#each keyedByOccurrence(facts.skills, (skill) => skill.id) as { key, item: skill } (key)}
          <li>
            <Badge class="ib-agent-fact__badge" variant="neutral" size="sm">{skill.name}</Badge>
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</div>
