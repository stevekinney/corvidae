<script lang="ts">
  /**
   * One tool in the editor: what names it (the caller's `lead`: plain text in the chosen list, a
   * checkbox in the picker), a marker when it asks first or is refused, the line a person is shown
   * for it, and, when the model is told more than the line says, a disclosure with the full text.
   * The line is at most 120 characters (`lib/tool-line.ts`), so a tool whose description is a long
   * prompt does not turn the list into a wall of text. A caller's `trailing` control (Remove) sits
   * at the end of the row.
   *
   * The disclosure is Cinder's flat `Collapsible`, shrunk below to a quiet text control that sits
   * on the line's row: a list of one-line rows cannot afford a full-width trigger.
   */
  import { Badge, Collapsible } from '@lostgradient/cinder';
  import type { Snippet } from 'svelte';

  import { AGENT_EDITOR_COPY } from '../../app/copy.ts';
  import type { AgentCatalog } from '../../lib/agent-definitions.ts';
  import { toolLine } from '../../lib/tool-line.ts';
  import type { ToolStanding } from '../../lib/tool-standing.ts';

  interface Props {
    tool: AgentCatalog['tools'][number];
    standing: ToolStanding;
    lead: Snippet;
    trailing?: Snippet;
  }

  let { tool, standing, lead, trailing }: Props = $props();

  const copy = AGENT_EDITOR_COPY;
  const summary = $derived(toolLine(tool));
</script>

<li
  class="weft-tool-row"
  class:weft-tool-row--with-action={trailing !== undefined}
  data-tool={tool.name}
>
  <div class="weft-tool-row__name">
    {@render lead()}
    {#if standing !== 'runs'}
      <Badge
        size="sm"
        variant={standing === 'blocked' ? 'danger' : 'warning'}
        data-testid="agent-tool-standing"
        data-standing={standing}>{copy.toolStanding[standing]}</Badge
      >
    {/if}
  </div>
  <div class="weft-tool-row__text">
    <span class="weft-tool-row__line" data-testid="agent-tool-line">{summary.line}</span>
    {#if summary.expandable}
      <Collapsible
        trigger={copy.toolDisclosure}
        variant="flat"
        class="weft-tool-row__more"
        triggerClass="weft-tool-row__more-trigger"
        labelClass="weft-tool-row__more-label"
      >
        <p class="weft-tool-row__full" data-testid="agent-tool-full">{tool.description}</p>
      </Collapsible>
    {/if}
  </div>
  {#if trailing}
    <div class="weft-tool-row__action">{@render trailing()}</div>
  {/if}
</li>

<style>
  /* The name and its line share a row where there is room; on a phone the line wraps under the name. */
  .weft-tool-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    column-gap: var(--cinder-space-4);
    row-gap: var(--cinder-space-1);
    align-items: baseline;
    min-width: 0;
  }

  @media (min-width: 40rem) {
    .weft-tool-row {
      grid-template-columns: 15rem minmax(0, 1fr);
    }

    .weft-tool-row--with-action {
      grid-template-columns: 15rem minmax(0, 1fr) auto;
    }
  }

  /* A tool's name, the marker beside it, and whatever names it for the caller. */
  .weft-tool-row__name {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-1) var(--cinder-space-2);
    align-items: center;
    min-width: 0;
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-sm);
    overflow-wrap: anywhere;
  }

  /* The line, and the disclosure that follows it on the same row while there is room. */
  .weft-tool-row__text {
    display: flex;
    flex-wrap: wrap;
    gap: 0 var(--cinder-space-3);
    align-items: baseline;
    min-width: 0;
  }

  .weft-tool-row__line {
    font-size: var(--cinder-text-sm);
    color: var(--cinder-text-muted);
    overflow-wrap: anywhere;
  }

  .weft-tool-row__action {
    justify-self: start;
  }

  /* A quiet text control and the text it opens; it takes the full row once it is open. */
  .weft-tool-row :global(.weft-tool-row__more[data-cinder-expanded]) {
    flex-basis: 100%;
  }

  .weft-tool-row :global(.weft-tool-row__more-trigger) {
    inline-size: auto;
    gap: var(--cinder-space-1);
    padding-block: 0;
    color: var(--cinder-text-secondary);
    font-size: var(--cinder-text-sm);
    font-weight: var(--cinder-font-normal);
  }

  .weft-tool-row :global(.weft-tool-row__more-trigger:hover:not(:disabled)) {
    text-decoration: underline;
  }

  .weft-tool-row :global(.weft-tool-row__more-label) {
    flex: none;
    font-weight: var(--cinder-font-normal);
  }

  .weft-tool-row__full {
    margin: 0;
    font-size: var(--cinder-text-sm);
    color: var(--cinder-text-muted);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
