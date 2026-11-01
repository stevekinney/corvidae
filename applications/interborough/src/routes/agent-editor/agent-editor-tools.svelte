<script lang="ts">
  /**
   * The body of the editor's Tools section: how many of the installation's tools the agent has
   * (`2 of 48 chosen`), the tools it has with a marker on each that asks first, a Remove beside each,
   * and the Add tools action that opens the picker. The choice lives in the editor state, so the
   * picker, this list and a save read one list.
   */
  import { Button } from '@lostgradient/cinder';

  import { AGENT_EDITOR_COPY } from '../../app/copy.ts';
  import type { AgentEditorState } from './agent-editor-state.svelte.ts';
  import AgentEditorToolRow from './agent-editor-tool-row.svelte';

  interface Props {
    editor: AgentEditorState;
    /** Opens the picker; the drawer returns focus to the button when it closes. */
    onAdd: () => void;
  }

  let { editor, onAdd }: Props = $props();

  const copy = AGENT_EDITOR_COPY;
  const chosen = $derived(editor.chosenTools);
</script>

<div class="weft-agent-tools">
  <div class="weft-agent-tools__bar">
    <p class="weft-agent-tools__count" data-testid="agent-tool-count" role="status">
      {copy.toolCount(chosen.length, editor.toolChoices.length)}
    </p>
    <Button type="button" variant="secondary" size="sm" onclick={onAdd}
      >{copy.addToolsAction}</Button
    >
  </div>

  {#if chosen.length === 0}
    <p class="weft-agent-tools__none" data-testid="agent-tools-none">{copy.noToolsChosen}</p>
  {:else}
    <ul class="weft-agent-tools__list" aria-label={copy.chosenToolsLabel}>
      {#each chosen as tool (tool.name)}
        <AgentEditorToolRow {tool} standing={editor.standingOf(tool)}>
          {#snippet lead()}
            <span class="weft-agent-tools__name">{tool.name}</span>
          {/snippet}
          {#snippet trailing()}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={copy.removeToolLabel(tool.name)}
              onclick={() => editor.setTool(tool.name, false)}>{copy.removeAction}</Button
            >
          {/snippet}
        </AgentEditorToolRow>
      {/each}
    </ul>
  {/if}
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

  .weft-agent-tools__count {
    margin: 0;
    font-size: var(--cinder-text-sm);
    font-weight: var(--cinder-font-medium);
  }

  .weft-agent-tools__none {
    margin: 0;
    font-size: var(--cinder-text-sm);
    color: var(--cinder-text-muted);
  }

  .weft-agent-tools__list {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }
</style>
