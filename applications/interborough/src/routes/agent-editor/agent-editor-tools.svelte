<script lang="ts">
  /**
   * The body of the editor's Tools section, with the Add tools action that opens the picker. The
   * choice lives in the editor state, so the picker, this list and a save read one list.
   *
   * A new agent's form shows one table (rows 41k, 41l, 41m): each chosen tool's name for a person,
   * with its identifier and where it comes from small beneath, its risk in muted words, and one Asks
   * select that starts at the tool's own default and says which option that is. The note under the
   * table says the Access tab owns the levels once the agent is saved. The count sits beside the
   * section's title (`toolCount`, from the form).
   *
   * Only a new agent's form has this body. A saved agent's form reads its tools as one line that
   * points to the Access tab, so it has no Remove and no picker (`agent-editor-form.svelte`, row
   * 41v).
   */
  import { Button, Select, Table } from '@lostgradient/cinder';

  import { AGENT_EDITOR_COPY, AGENT_PAGE_COPY } from '../../app/copy.ts';
  import { TOOL_APPROVALS, type ToolApproval } from '../../lib/agent-definitions.ts';
  import {
    defaultAsks,
    riskLabel,
    tierOf,
    toolHeading,
    toolSourceChip,
  } from '../capabilities/capability-presentation.ts';
  import type { AgentEditorState } from './agent-editor-state.svelte.ts';

  interface Props {
    editor: AgentEditorState;
    /** Opens the picker; the drawer returns focus to the button when it closes. */
    onAdd: () => void;
  }

  let { editor, onAdd }: Props = $props();

  const copy = AGENT_EDITOR_COPY;
  const levels = AGENT_PAGE_COPY.access.approvals;
  const chosen = $derived(editor.chosenTools);

  /** The Asks options for one tool, its own default marked (row 41l). */
  function asksOptions(fallback: ToolApproval): { value: ToolApproval; label: string }[] {
    return TOOL_APPROVALS.map((value) => ({
      value,
      label: copy.newAgent.asksOption(levels[value], value === fallback),
    }));
  }
</script>

<div class="weft-agent-tools">
  <div class="weft-agent-tools__bar weft-agent-tools__bar--end">
    <Button type="button" variant="secondary" size="sm" onclick={onAdd}
      >{copy.addToolsAction}</Button
    >
  </div>

  {#if chosen.length === 0}
    <p class="weft-agent-tools__none" data-testid="agent-tools-none">{copy.noToolsChosen}</p>
  {:else}
    <Table
      caption={copy.newAgent.toolsCaption}
      density="condensed"
      class="weft-agent-tools__table"
      data-testid="agent-tools-table"
    >
      <Table.Header>
        <Table.Row>
          <Table.HeaderCell>{copy.newAgent.columns.tool}</Table.HeaderCell>
          <Table.HeaderCell>{copy.newAgent.columns.risk}</Table.HeaderCell>
          <Table.HeaderCell>{copy.newAgent.columns.asks}</Table.HeaderCell>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each chosen as tool (tool.name)}
          {@const fallback = defaultAsks(tool)}
          <Table.Row data-tool={tool.name}>
            <Table.Cell as="th">
              <span class="weft-agent-tools__title">{toolHeading(tool)}</span>
              {#snippet detail()}
                <span class="weft-agent-tools__identity">
                  <span class="weft-agent-tools__identifier">{tool.name}</span>
                  <span>{toolSourceChip(tool)}</span>
                </span>
              {/snippet}
            </Table.Cell>
            <Table.Cell>
              <span class="weft-agent-tools__risk" data-testid="agent-tool-risk"
                >{riskLabel(tierOf(tool))}</span
              >
            </Table.Cell>
            <Table.Cell controls>
              <Select
                id={`agent-asks-${tool.name}`}
                label={copy.newAgent.asksLabel(tool.name)}
                labelVisible={false}
                size="sm"
                options={asksOptions(fallback)}
                value={editor.approvalOf(tool.name) ?? fallback}
                onValueChange={(next) => editor.setApproval(tool.name, next, fallback)}
              />
            </Table.Cell>
          </Table.Row>
        {/each}
      </Table.Body>
    </Table>
  {/if}

  <p class="weft-agent-tools__note" data-testid="agent-asks-note">{copy.newAgent.asksNote}</p>
</div>

<style>
  .weft-agent-tools {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
  }

  .weft-agent-tools__bar {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-2) var(--cinder-space-4);
    align-items: center;
    justify-content: space-between;
  }

  /* The count sits beside the section's title, so Add tools stands alone at the end. */
  .weft-agent-tools__bar--end {
    justify-content: flex-end;
  }

  .weft-agent-tools__none,
  .weft-agent-tools__note {
    margin: 0;
    font-size: var(--cinder-text-sm);
    color: var(--cinder-text-muted);
  }

  .weft-agent-tools__title {
    font-weight: var(--cinder-font-medium);
  }

  /* The identifier and where the tool comes from, small beneath its name: two words, no separator glyph. */
  .weft-agent-tools__identity {
    display: flex;
    flex-wrap: wrap;
    gap: 0 var(--cinder-space-2);
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-xs);
    color: var(--cinder-text-muted);
    overflow-wrap: anywhere;
  }

  /* Risk is said in muted words in the body face, never in a colour of its own (S32). */
  .weft-agent-tools__risk {
    font-size: var(--cinder-text-sm);
    color: var(--cinder-text-muted);
  }
</style>
