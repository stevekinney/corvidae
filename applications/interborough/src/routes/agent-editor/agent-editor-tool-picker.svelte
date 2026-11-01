<script lang="ts">
  /**
   * The Add tools picker: a drawer that searches every tool the installation offers and lists the
   * matches grouped by source (Bureau's, the host's, and each saved MCP server or OpenAPI service),
   * a checkbox on each. A tick or a clear writes straight to the editor's list, the same list the
   * chosen tools and a save read, so there is nothing to apply: Done only closes the drawer.
   */
  import { Button, Checkbox, Drawer, EmptyState, SearchField } from '@lostgradient/cinder';

  import { AGENT_EDITOR_COPY, CAPABILITIES_COPY } from '../../app/copy.ts';
  import { groupByOrigin, matchesSearch, type ToolGroup } from '../../lib/tool-sources.ts';
  import type { AgentEditorState } from './agent-editor-state.svelte.ts';
  import AgentEditorToolRow from './agent-editor-tool-row.svelte';

  interface Props {
    editor: AgentEditorState;
    open: boolean;
  }

  let { editor, open = $bindable() }: Props = $props();

  const copy = AGENT_EDITOR_COPY.toolPicker;
  const sourceLabels = CAPABILITIES_COPY.tool.sources;

  let search = $state('');
  const matches = $derived(editor.toolChoices.filter((tool) => matchesSearch(tool, search)));
  const groups = $derived(groupByOrigin(matches));

  function labelOf(group: ToolGroup): string {
    return group.origin.sourceId === undefined
      ? sourceLabels[group.origin.kind === 'bureau' ? 'bureau' : 'host']
      : copy.savedSource(group.origin.sourceId);
  }

  function chosenIn(group: ToolGroup): number {
    return group.tools.filter((tool) => editor.hasTool(tool.name)).length;
  }
</script>

<Drawer bind:open title={copy.title} size="md" onExitComplete={() => (search = '')}>
  <div class="weft-tool-picker">
    <SearchField
      id="agent-tool-search"
      aria-label={copy.searchLabel}
      placeholder={copy.searchPlaceholder}
      bind:value={search}
    />
    <p class="weft-tool-picker__count" role="status" data-testid="agent-tool-matches">
      {copy.resultCount(matches.length)}
    </p>

    {#if groups.length === 0}
      <EmptyState
        kind="filtered"
        size="compact"
        align="start"
        headingLevel={3}
        title={copy.noMatchesTitle}
        description={copy.noMatchesDescription(search.trim())}
      />
    {:else}
      {#each groups as group (group.origin.key)}
        <fieldset class="weft-tool-picker__group" data-group={group.origin.key}>
          <legend class="weft-tool-picker__legend">
            <span>{labelOf(group)}</span>
            <span class="weft-tool-picker__group-count"
              >{copy.groupCount(chosenIn(group), group.tools.length)}</span
            >
          </legend>
          <ul class="weft-tool-picker__list">
            {#each group.tools as tool (tool.name)}
              <AgentEditorToolRow {tool} standing={editor.standingOf(tool)}>
                {#snippet lead()}
                  <Checkbox
                    id={`agent-tool-${tool.name}`}
                    aria-label={tool.name}
                    checked={editor.hasTool(tool.name)}
                    onValueChange={(next) => editor.setTool(tool.name, next)}
                  />
                  <label class="weft-tool-picker__label" for={`agent-tool-${tool.name}`}
                    >{tool.name}</label
                  >
                {/snippet}
              </AgentEditorToolRow>
            {/each}
          </ul>
        </fieldset>
      {/each}
    {/if}
  </div>

  {#snippet footer()}
    <Button type="button" variant="primary" onclick={() => (open = false)}>{copy.done}</Button>
  {/snippet}
</Drawer>

<style>
  .weft-tool-picker {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
  }

  .weft-tool-picker__count {
    margin: 0;
    font-size: var(--cinder-text-sm);
    color: var(--cinder-text-muted);
  }

  .weft-tool-picker__group {
    margin: 0;
    padding: 0;
    border: 0;
    min-width: 0;
  }

  .weft-tool-picker__legend {
    display: flex;
    gap: var(--cinder-space-2);
    align-items: baseline;
    margin-block-end: var(--cinder-space-2);
    padding: 0;
    font-weight: var(--cinder-font-medium);
  }

  .weft-tool-picker__group-count {
    font-size: var(--cinder-text-sm);
    font-weight: var(--cinder-font-normal);
    color: var(--cinder-text-muted);
  }

  .weft-tool-picker__list {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .weft-tool-picker__label {
    cursor: pointer;
  }
</style>
