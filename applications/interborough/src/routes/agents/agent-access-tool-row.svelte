<script lang="ts">
  /**
   * One tool on the Access tab: whether the agent may call it, the tier it declares, and when it
   * asks first. The ask-first choice is only offered for a tool the agent may call, and what the
   * choice means is written under it. A tool the file lists that the host no longer offers is
   * marked, and can only be withdrawn.
   */
  import { Badge, Checkbox, Select } from '@lostgradient/cinder';

  import { AGENT_PAGE_COPY } from '../../app/copy.ts';
  import { TOOL_APPROVALS, type ToolApproval } from '../../lib/agent-definitions.ts';
  import { toolLine } from '../../lib/tool-line.ts';
  import { tierLabel, tierOf, tierVariant } from '../capabilities/capability-presentation.ts';
  import type { AccessTool } from './agent-access-state.svelte.ts';

  interface Props {
    tool: AccessTool;
    allowed: boolean;
    approval: ToolApproval;
    onAllow: (next: boolean) => void;
    onApproval: (next: ToolApproval) => void;
  }

  let { tool, allowed, approval, onAllow, onApproval }: Props = $props();

  const copy = AGENT_PAGE_COPY.access;
  const options = TOOL_APPROVALS.map((value) => ({ value, label: copy.approvals[value] }));
  const line = $derived(tool.catalog === undefined ? undefined : toolLine(tool.catalog).line);
</script>

<li class="ib-access-tool" data-tool={tool.name}>
  <div class="ib-access-tool__name">
    <Checkbox
      id={`access-allow-${tool.name}`}
      label={tool.name}
      checked={allowed}
      onValueChange={onAllow}
    />
    {#if tool.catalog === undefined}
      <Badge variant="warning" size="sm">{copy.notInCatalog}</Badge>
    {:else}
      <Badge variant={tierVariant(tierOf(tool.catalog))} size="sm"
        >{tierLabel(tierOf(tool.catalog))}</Badge
      >
    {/if}
  </div>
  {#if line !== undefined}
    <p class="ib-access-tool__line">{line}</p>
  {/if}
  {#if allowed}
    <div class="ib-access-tool__approval">
      <Select
        id={`access-approval-${tool.name}`}
        label={copy.asksFirstLabel(tool.name)}
        labelVisible={false}
        size="sm"
        {options}
        value={approval}
        description={copy.approvalHints[approval]}
        onchange={(event) => onApproval(event.currentTarget.value as ToolApproval)}
      />
    </div>
  {/if}
</li>
