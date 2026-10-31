<script lang="ts">
  /**
   * One tool: what it does, what it may do (its tier), how it is approved by default, where it comes
   * from, its inputs as a field list, and the agents that use it.
   */
  import { Badge, SchemaView, SectionHeading } from '@lostgradient/cinder';

  import { CAPABILITIES_COPY } from '../../app/copy.ts';
  import AgentUsers from './agent-users.svelte';
  import {
    approvalLabel,
    tierDescription,
    tierLabel,
    tierOf,
    tierVariant,
    toolSourceLabel,
    type CatalogTool,
  } from './capability-presentation.ts';

  interface Props {
    tool: CatalogTool;
  }

  let { tool }: Props = $props();

  const copy = CAPABILITIES_COPY.tool;
  const tier = $derived(tierOf(tool));
</script>

<article class="ib-capability" data-testid="tool-detail" data-tool={tool.name} data-tier={tier}>
  <h3 class="ib-capability__name ib-capability__identifier">{tool.name}</h3>

  <section class="ib-capability__section">
    <SectionHeading level={4} title={copy.whatItDoes} />
    <p class="ib-capability__prose">{tool.description}</p>
  </section>

  <dl class="ib-capability__facts">
    <div>
      <dt>{copy.safety}</dt>
      <dd>
        <Badge variant={tierVariant(tier)} size="sm">{tierLabel(tier)}</Badge>
        <span>{tierDescription(tier)}</span>
      </dd>
    </div>
    <div>
      <dt>{copy.approval}</dt>
      <dd data-testid="tool-approval">{approvalLabel(tool)}</dd>
    </div>
    <div>
      <dt>{copy.source}</dt>
      <dd data-testid="tool-source">{toolSourceLabel(tool)}</dd>
    </div>
  </dl>

  <section class="ib-capability__section">
    <SectionHeading level={4} title={copy.inputs} />
    <SchemaView
      schema={tool.inputSchema}
      label={copy.inputsLabel(tool.name)}
      emptyLabel={tool.inputSchema === null ? copy.noSchema : copy.noInputs}
      data-testid="tool-input-schema"
    />
  </section>

  <AgentUsers heading={copy.users} users={tool.users} empty={copy.noUsers} />
</article>
