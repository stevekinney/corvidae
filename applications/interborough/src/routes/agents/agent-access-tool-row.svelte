<script lang="ts">
  /**
   * One tool of the Access tab's table (rows 38m to 38p, 39i to 39k): a leading box that allows it,
   * its name for a person with its identifier once, small and monospaced, what it does, its risk in
   * muted words (never a coloured pill, sweep S32), and one Asks select whose options mark the
   * tool's own default. The select is disabled while the tool is off. A change saves at once: the
   * row shows a spinner and "Saving…" beside its select while the write is in flight, and when the
   * write fails, the value it went back to and a full-width line under the row with Try again.
   *
   * On a narrow container Cinder's table stacks the row into a card (row 07a): the name, identifier
   * and risk on top, the box and the select full width beneath, and what the tool does is left off.
   * The box and the select carry `mutating`, so the tab's stale region holds them while the server
   * does not answer (row 40c). A tool the file lists that the host no longer offers is marked.
   */
  import { Checkbox, Select, Spinner, Table } from '@lostgradient/cinder';

  import { AGENT_PAGE_COPY } from '../../app/copy/agents.ts';
  import { TOOL_APPROVALS, type ToolApproval } from '../../lib/agent-definitions.ts';
  import { toolLine } from '../../lib/tool-line.ts';
  import { riskLabel, tierOf } from '../capabilities/capability-presentation.ts';
  import {
    accessRowHeading,
    type AccessTool,
    type AgentAccessState,
  } from './agent-access-state.svelte.ts';

  interface Props {
    /** The tab's state, which holds the row's values and saves its changes. */
    form: AgentAccessState;
    tool: AccessTool;
  }

  let { form, tool }: Props = $props();

  const copy = AGENT_PAGE_COPY.access;
  const key = $derived(`tool:${tool.name}`);
  const heading = $derived(accessRowHeading(tool));
  const line = $derived(tool.catalog === undefined ? undefined : toolLine(tool.catalog).line);
  const allowed = $derived(form.isAllowed(tool.name));
  const approval = $derived(form.approvalOf(tool.name));
  const save = $derived(form.saves.get(key));
  /** Never on a tool that declares no tier: Armorer still asks about a call it cannot classify. */
  const unclassifiedNever = $derived(
    approval === 'never' && tool.catalog !== undefined && tool.catalog.tier === null,
  );
  const options = $derived(
    TOOL_APPROVALS.map((value) => ({
      value,
      label: copy.asksOption(copy.approvals[value], value === tool.fallback),
    })),
  );

  function allow(next: boolean): void {
    const name = tool.name;
    void form.change({
      key,
      subject: heading,
      restored: next ? copy.restoredNotAllowed : copy.restoredAllowed,
      apply: () => form.setAllowed(name, next),
      undo: () => form.setAllowed(name, !next),
    });
  }

  function ask(next: ToolApproval): void {
    const name = tool.name;
    const before = form.approvalOf(name);
    if (next === before) return;
    void form.change({
      key,
      subject: heading,
      restored: copy.approvals[before],
      apply: () => form.setApproval(name, next),
      undo: () => form.setApproval(name, before),
    });
  }
</script>

<Table.Row data-tool={tool.name} data-saving={save?.kind === 'saving' ? '' : undefined}>
  <Table.Cell controls="fit">
    <Checkbox
      id={`access-allow-${tool.name}`}
      aria-label={copy.allowLabel(heading)}
      checked={allowed}
      disabled={!form.toolsEditable}
      mutating
      data-changes
      onValueChange={allow}
    />
  </Table.Cell>
  <Table.Cell as="th">
    <span class="ib-access-row__identity">
      <span class="ib-access-row__name">{heading}</span>
      <code class="ib-access-row__identifier">{tool.name}</code>
    </span>
  </Table.Cell>
  <Table.Cell>
    {#snippet detail()}
      <span class="ib-access-row__does">{line ?? copy.notInCatalog}</span>
    {/snippet}
  </Table.Cell>
  <Table.Cell>
    <span class="ib-access-row__risk" data-testid="agent-access-risk"
      >{tool.catalog === undefined ? copy.notInCatalog : riskLabel(tierOf(tool.catalog))}</span
    >
  </Table.Cell>
  <Table.Cell controls>
    <div class="ib-access-row__asks">
      <Select
        id={`access-approval-${tool.name}`}
        label={copy.asksFirstLabel(heading)}
        labelVisible={false}
        size="sm"
        {options}
        value={approval}
        disabled={!allowed || !form.approvalsEditable}
        mutating
        data-changes
        {...unclassifiedNever ? { description: copy.neverUnclassifiedHint } : {}}
        onValueChange={ask}
      />
      {#if save?.kind === 'saving'}
        <span class="ib-access-row__saving" data-testid="agent-access-saving">
          <Spinner size="sm" label={copy.saving} />
          <span aria-hidden="true">{copy.saving}</span>
        </span>
      {/if}
    </div>
  </Table.Cell>
</Table.Row>
{#if save?.kind === 'failed'}
  <Table.Row class="ib-access-row__failure" data-failed={tool.name}>
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
