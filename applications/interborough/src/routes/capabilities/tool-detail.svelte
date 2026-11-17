<script lang="ts">
  /**
   * One tool (board SchemaAndJson, frame "c Tool detail page, reordered"): its name for a person as
   * the heading with its identifier small and monospaced beside it, one sentence about it, one row
   * of muted chips (what it may do, when it asks by default, where it comes from) each with a
   * tooltip, the agents that use it, its inputs as a field list, and the raw JSON schema last as a
   * quiet collapsed disclosure (SchemaView's own). The page's own breadcrumb entry is followed by
   * the tool's name.
   */
  import { Chip, SchemaView, SectionHeading, Tooltip } from '@lostgradient/cinder';
  import { Eye, Hand, Pencil, Shield } from '@lucide/svelte';

  import { usePageLeaf } from '../../app/breadcrumbs.svelte.ts';
  import { CAPABILITIES_COPY } from '../../app/copy/capabilities.ts';
  import AgentUsers from './agent-users.svelte';
  import {
    asksLabel,
    asksTooltip,
    hasBlockedUser,
    riskLabel,
    riskTooltip,
    tierOf,
    toolHeading,
    toolSourceChip,
    toolSourceTooltip,
    toolSummary,
    userAsks,
    type ShownTool,
  } from './capability-presentation.ts';
  import LostToolWarning from './lost-tool-warning.svelte';

  interface Props {
    /** The tool: one the catalog holds, or one of a last listing that cannot run now (COR-2435). */
    tool: ShownTool;
  }

  let { tool }: Props = $props();

  const copy = CAPABILITIES_COPY.tool;
  const tier = $derived(tierOf(tool));
  const heading = $derived(toolHeading(tool));
  /** The glyph beside the risk word: an eye for a read, a pencil for a change, a shield for danger. */
  const RiskIcon = $derived(tier === 'read-only' ? Eye : tier === 'dangerous' ? Shield : Pencil);

  usePageLeaf(() => ({ path: '/capabilities', label: heading }));
</script>

<article class="ib-capability" data-testid="tool-detail" data-tool={tool.name} data-tier={tier}>
  <header class="ib-capability__name-line">
    <h3 class="ib-capability__name">{heading}</h3>
    <code class="ib-capability__code ib-capability__identifier" data-testid="tool-identifier"
      >{tool.name}</code
    >
  </header>

  <p class="ib-capability__prose" data-testid="tool-summary">{toolSummary(tool)}</p>

  <!-- Each chip is focusable so its tooltip is reachable from the keyboard; the words are muted, never red. -->
  <ul class="ib-capability__chips" aria-label={copy.chips.label}>
    <li>
      <Tooltip text={riskTooltip(tier)}>
        <Chip size="sm" tabindex={0} label={riskLabel(tier)} data-testid="tool-risk">
          {#snippet leadingIcon()}<RiskIcon size={12} aria-hidden="true" />{/snippet}
        </Chip>
      </Tooltip>
    </li>
    <li>
      <Tooltip text={asksTooltip(tool)}>
        <Chip size="sm" tabindex={0} label={asksLabel(tool)} data-testid="tool-approval">
          {#snippet leadingIcon()}<Hand size={12} aria-hidden="true" />{/snippet}
        </Chip>
      </Tooltip>
    </li>
    <li>
      <Tooltip text={toolSourceTooltip(tool)}>
        <Chip size="sm" tabindex={0} label={toolSourceChip(tool)} data-testid="tool-source" />
      </Tooltip>
    </li>
  </ul>

  {#if tool.lost !== undefined}
    <LostToolWarning cause={tool.lost} />
  {/if}

  <AgentUsers
    heading={copy.users}
    users={tool.users}
    note={(user) => userAsks(tool, user).text}
    empty={tool.lost === undefined ? copy.noUsers : { line: copy.lost.noUsers }}
  />

  <section class="ib-capability__section">
    <SectionHeading level={4} title={copy.inputs} />
    <SchemaView
      schema={tool.inputSchema}
      label={copy.inputsLabel(tool.name)}
      emptyLabel={tool.inputSchema === null ? copy.noSchema : copy.noInputs}
      data-testid="tool-input-schema"
    />
  </section>

  {#if hasBlockedUser(tool)}
    <p class="ib-capability__line" data-testid="tool-blocked-note">{copy.blockedNote}</p>
  {/if}
</article>
