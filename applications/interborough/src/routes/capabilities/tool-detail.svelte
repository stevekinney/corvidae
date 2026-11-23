<script lang="ts">
  /**
   * One tool, in the order a person needs it (owner report, 2026-11-19): what it does (its name for
   * a person and one sentence, said once), then who can use it and whether it asks (the three
   * badges, Used by, and Add to an agent as the header's button at its inline end), then its inputs
   * beside its JSON schema, open. The identifier is not printed by the name: Copy tool ID copies it,
   * and the schema holds it. The page's own breadcrumb entry is followed by the tool's name.
   */
  import { Button, CopyButton, SchemaView, SectionHeading } from '@lostgradient/cinder';

  import { createQuery } from '@tanstack/svelte-query';

  import { usePageLeaf } from '../../app/breadcrumbs.svelte.ts';
  import { listAgentDefinitions } from '../../lib/agent-definitions.ts';
  import { agentLabel } from '../../lib/agent-label.ts';
  import { agentsListQuery } from '../../lib/agent-queries.ts';
  import { getToolSources } from '../../lib/host-tool-sources.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { CAPABILITIES_COPY } from '../../app/copy/capabilities.ts';
  import AgentUsers from './agent-users.svelte';
  import {
    blockedUsers,
    sourceNamesOf,
    tierOf,
    toolHeading,
    toolSummary,
    userAsks,
    type ShownTool,
  } from './capability-presentation.ts';
  import LostToolWarning from './lost-tool-warning.svelte';
  import ToolBadge from './tool-badge.svelte';

  interface Props {
    /** The tool: one the catalog holds, or one of a last listing that cannot run now (COR-2435). */
    tool: ShownTool;
  }

  let { tool }: Props = $props();

  const copy = CAPABILITIES_COPY.tool;
  const tier = $derived(tierOf(tool));
  const heading = $derived(toolHeading(tool));

  usePageLeaf(() => ({ path: '/capabilities', label: heading }));

  // The agents defined in code, whose level their code sets: Used by says so rather than claiming
  // the default. A read that fails leaves the set empty.
  const definitions = createQuery(
    () => ({
      queryKey: queryKeys.agents.definitions(),
      queryFn: ({ signal }) => listAgentDefinitions({ signal }),
      retry: false,
    }),
    undefined,
  );
  // The names people call the saved sources, so the badge says "From GitHub". The same key and
  // options as the Sources tab's query: a list already read is not read again.
  const sources = createQuery(
    () => ({
      queryKey: queryKeys.toolSources.list(),
      queryFn: ({ signal }) => getToolSources({ signal }),
      retry: false,
    }),
    undefined,
  );
  // The names the Agents list shows, for the note that names the blocked agent.
  const agents = createQuery(agentsListQuery, undefined);
  const sourceNames = $derived(sourceNamesOf(sources.data?.sources));
  const codeAgents = $derived(
    new Set(
      (definitions.data ?? []).filter((agent) => agent.source === 'code').map((agent) => agent.id),
    ),
  );

  function addToAgent(event: MouseEvent): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(copy.addToAgent.href);
  }
</script>

<article class="ib-capability" data-testid="tool-detail" data-tool={tool.name} data-tier={tier}>
  <header class="ib-capability__top" data-testid="tool-top">
    <div class="ib-capability__title">
      <h3 class="ib-capability__name">{heading}</h3>
      <p class="ib-capability__prose" data-testid="tool-summary">{toolSummary(tool)}</p>
    </div>
    <div class="ib-capability__actions">
      <!-- A tool that cannot run now is not offered to agents; its warning carries its one action. -->
      {#if tool.lost === undefined}
        <Button
          href={router.href(copy.addToAgent.href)}
          variant="secondary"
          size="sm"
          onclick={addToAgent}
          data-testid="tool-add-to-agent"
          label={copy.addToAgent.label}
        />
      {/if}
      <CopyButton
        value={tool.name}
        label={copy.copyIdentifier.label}
        copiedLabel={copy.copyIdentifier.copied}
        data-testid="tool-copy-identifier"
      />
    </div>
  </header>

  <!-- The three badges, the same words and chip the list row shows; each focusable for its tooltip. -->
  <ul class="ib-capability__chips" aria-label={copy.chips.label}>
    <li><ToolBadge kind="risk" {tool} explained testId="tool-risk" /></li>
    <li><ToolBadge kind="asks" {tool} explained testId="tool-approval" /></li>
    <li><ToolBadge kind="source" {tool} {sourceNames} explained testId="tool-source" /></li>
  </ul>

  {#if tool.lost !== undefined}
    <LostToolWarning cause={tool.lost} />
  {/if}

  <AgentUsers
    heading={copy.users}
    users={tool.users}
    note={(user) => userAsks(tool, user, codeAgents).text}
    empty={{ line: tool.lost === undefined ? copy.noUsers.line : copy.lost.noUsers }}
  />

  {#each blockedUsers(tool) as agent (agent)}
    <p class="ib-capability__line" data-testid="tool-blocked-note" data-agent={agent}>
      {copy.blockedNote(agentLabel(agent, agents.data))}
    </p>
  {/each}

  <section class="ib-capability__section">
    <SectionHeading level={4} title={copy.inputs} />
    <!-- Fields at the left and the JSON schema open at the right when the pane is wide; stacked,
         and still open, when it is narrow. -->
    <SchemaView
      schema={tool.inputSchema}
      label={copy.inputsLabel(heading)}
      layout="rows"
      raw={tool.inputSchema === null ? 'none' : 'beside'}
      emptyLabel={tool.inputSchema === null ? copy.noSchema : copy.noInputs}
      data-testid="tool-input-schema"
    />
  </section>
</article>
